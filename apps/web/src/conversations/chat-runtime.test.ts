import {
  type ConversationDetailResponse,
  type CreateResponseRequest,
  RESPONSE_UPDATES_MAX_TEXT_UTF8_BYTES,
  type ResponseStateResponse,
  type ResponseUpdatesResponse,
} from "@capstone/protocol";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConversationApiError,
  ConversationHttpError,
  ConversationStreamProtocolError,
  conversationQueryKeys,
} from "./api";
import { ChatRuntime, ChatRuntimeError } from "./chat-runtime";
import { STREAM_INACTIVITY_TIMEOUT_MS } from "./stream-parser";

const queryScope = ["workspace-1", "employee-1", "2026-08-07T12:00:00.000Z"] as const;
const conversationId = "11111111-1111-4111-8111-111111111111";
const secondConversationId = "22222222-2222-4222-8222-222222222222";
const generationId = "33333333-3333-4333-8333-333333333333";
const userMessageId = "44444444-4444-4444-8444-444444444444";
const messageId = "55555555-5555-4555-8555-555555555555";

const request: CreateResponseRequest = {
  source: "draft",
  parentMessageId: null,
  content: [{ type: "text", text: "Pregunta" }],
  modelTier: "balanced",
  observedRevision: 0,
  draftRevision: 1,
};

function line(event: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

function controlledStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(current) {
      controller = current;
    },
  });
  return { controller, stream };
}

function started(conversation = conversationId) {
  return {
    type: "response.started",
    conversationId: conversation,
    generationId,
    userMessageId,
    messageId,
    revision: 1,
  } as const;
}

function canonical(conversation = conversationId): ConversationDetailResponse {
  return {
    conversation: {
      id: conversation,
      title: "Pregunta",
      isArchived: false,
      revision: 2,
      createdAt: "2026-08-07T12:00:00.000Z",
      updatedAt: "2026-08-07T12:00:01.000Z",
    },
    selectedLeafId: messageId,
    messages: [
      {
        id: userMessageId,
        parentMessageId: null,
        role: "user",
        content: [{ type: "text", text: "Pregunta" }],
        createdAt: "2026-08-07T12:00:00.000Z",
        siblingCount: 0,
      },
      {
        id: messageId,
        parentMessageId: userMessageId,
        role: "assistant",
        content: [{ type: "text", text: "Respuesta" }],
        createdAt: "2026-08-07T12:00:00.000Z",
        siblingCount: 0,
      },
    ],
    nextCursor: null,
  };
}

function responseState(
  status: "active" | "cancelled" | "completed" = "cancelled",
): ResponseStateResponse {
  return {
    conversationId,
    revision: status === "active" ? 1 : 2,
    responses: [
      status === "active"
        ? { generationId, messageId, status, reason: null, errorCode: null }
        : status === "cancelled"
          ? { generationId, messageId, status, reason: "cancelled", errorCode: null }
          : { generationId, messageId, status, reason: "stop", errorCode: null },
    ],
  };
}

function compactionTerminalState(status: "cancelled" | "failed"): ResponseStateResponse {
  return {
    conversationId,
    revision: 2,
    responses: [
      status === "cancelled"
        ? { errorCode: null, generationId, messageId, reason: "cancelled", status }
        : {
            errorCode: "GENERATION_FAILED",
            generationId,
            messageId,
            reason: "error",
            status,
          },
    ],
  };
}

function updates(
  input: {
    readonly cursor?: string | null;
    readonly mode?: "append" | "replace";
    readonly phase?: "naming" | "responding";
    readonly status?: "active" | "cancelled" | "completed" | "incomplete";
    readonly text?: string;
  } = {},
): ResponseUpdatesResponse {
  const status = input.status ?? "active";
  return {
    conversationId,
    revision: status === "active" ? 1 : 2,
    phase: input.phase ?? "responding",
    response:
      status === "active"
        ? { generationId, messageId, status, reason: null, errorCode: null }
        : status === "cancelled"
          ? { generationId, messageId, status, reason: "cancelled", errorCode: null }
          : status === "incomplete"
            ? { generationId, messageId, status, reason: "error", errorCode: "STREAM_INTERRUPTED" }
            : { generationId, messageId, status, reason: "stop", errorCode: null },
    content: { mode: input.mode ?? "replace", text: input.text ?? "" },
    nextCursor: status === "active" ? (input.cursor ?? "bmV4dA.c2ln") : null,
  };
}

function completedEvent() {
  return {
    type: "response.completed",
    messageId,
    revision: 2,
    reason: "stop",
    usage: { inputTokens: 5, outputTokens: 3 },
  } as const;
}

function createRuntime(
  overrides: ConstructorParameters<typeof ChatRuntime>[0]["transport"] = {},
  frame?: {
    readonly callbacks: FrameRequestCallback[];
    readonly cancelled: number[];
  },
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const auth = new AbortController();
  const runtime = new ChatRuntime({
    authSignal: auth.signal,
    isAuthCurrent: () => !auth.signal.aborted,
    queryClient,
    queryScope,
    ...(frame
      ? {
          requestFrame: (callback: FrameRequestCallback) => {
            frame.callbacks.push(callback);
            return frame.callbacks.length;
          },
          cancelFrame: (handle: number) => {
            frame.cancelled.push(handle);
          },
        }
      : {}),
    transport: overrides,
  });
  return { auth, queryClient, runtime };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ChatRuntime", () => {
  it("locks duplicate starts synchronously while allowing separate conversations", async () => {
    const first = controlledStream();
    const second = controlledStream();
    const openResponse = vi
      .fn()
      .mockResolvedValueOnce(first.stream)
      .mockResolvedValueOnce(second.stream);
    const { runtime } = createRuntime({ openResponse });
    const firstStarted = runtime.startResponse(conversationId, request);

    await expect(runtime.startResponse(conversationId, request)).rejects.toBeInstanceOf(
      ChatRuntimeError,
    );

    const secondStarted = runtime.startResponse(secondConversationId, request);
    first.controller.enqueue(line(started()));
    second.controller.enqueue(line(started(secondConversationId)));
    await expect(firstStarted).resolves.toMatchObject({ conversationId });
    await expect(secondStarted).resolves.toMatchObject({ conversationId: secondConversationId });
    expect(runtime.getSnapshot(conversationId)?.phase).toBe("generating");
    expect(runtime.getSnapshot(secondConversationId)?.phase).toBe("generating");
    runtime.dispose();
  });

  it("publishes multiple deltas at most once in one animation frame", async () => {
    const source = controlledStream();
    const frame = { callbacks: [] as FrameRequestCallback[], cancelled: [] as number[] };
    const { runtime } = createRuntime(
      { openResponse: vi.fn().mockResolvedValue(source.stream) },
      frame,
    );
    const listener = vi.fn();
    runtime.subscribe(listener);
    const startPromise = runtime.startResponse(conversationId, request);
    source.controller.enqueue(line(started()));
    await startPromise;
    listener.mockClear();

    source.controller.enqueue(line({ type: "content.delta", text: "Res" }));
    source.controller.enqueue(line({ type: "content.delta", text: "puesta" }));
    await vi.waitFor(() => expect(frame.callbacks).toHaveLength(1));
    expect(listener).not.toHaveBeenCalled();
    frame.callbacks[0]?.(0);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot(conversationId)?.text).toBe("Respuesta");
    runtime.dispose();
  });

  it("observes the encoded naming event through the stream parser", async () => {
    const source = controlledStream();
    const { runtime } = createRuntime({ openResponse: vi.fn(async () => source.stream) });
    const pending = runtime.startResponse(conversationId, request);
    source.controller.enqueue(line(started()));
    await pending;
    source.controller.enqueue(line({ text: "Respuesta", type: "content.delta" }));
    source.controller.enqueue(line({ type: "conversation.naming" }));

    await vi.waitFor(() =>
      expect(runtime.getSnapshot(conversationId)).toMatchObject({
        phase: "naming",
        text: "Respuesta",
      }),
    );
    runtime.dispose();
  });

  it("retains a direct admission fallback warning while ordinary generation continues", async () => {
    const source = controlledStream();
    const { runtime } = createRuntime({ openResponse: vi.fn().mockResolvedValue(source.stream) });
    const startPromise = runtime.startResponse(conversationId, request);
    source.controller.enqueue(line(started()));
    await startPromise;

    source.controller.enqueue(
      line({ code: "CONTEXT_COMPACTION_FALLBACK", type: "context.warning" }),
    );
    await vi.waitFor(() =>
      expect(runtime.getSnapshot(conversationId)).toMatchObject({
        contextWarning: true,
        phase: "generating",
      }),
    );

    source.controller.enqueue(line({ text: "Respuesta", type: "content.delta" }));
    await vi.waitFor(() =>
      expect(runtime.getSnapshot(conversationId)).toMatchObject({
        contextWarning: true,
        text: "Respuesta",
      }),
    );
    runtime.dispose();
  });

  it.each([
    [
      "cancellation",
      { messageId, revision: 2, type: "response.cancelled" } as const,
      "cancelled" as const,
    ],
    [
      "failure",
      {
        errorCode: "GENERATION_FAILED",
        messageId,
        partial: false,
        revision: 2,
        type: "response.failed",
      } as const,
      "failed" as const,
    ],
  ])("accepts terminal %s directly from compaction", async (_label, terminal, status) => {
    const source = controlledStream();
    const canonicalPending = Promise.withResolvers<ConversationDetailResponse>();
    const fetchConversation = vi.fn(() => canonicalPending.promise);
    const fetchResponseStates = vi.fn(async () => compactionTerminalState(status));
    const { runtime } = createRuntime({
      fetchConversation,
      fetchResponseStates,
      openResponse: vi.fn(async () => source.stream),
    });
    const startPromise = runtime.startResponse(conversationId, request);
    source.controller.enqueue(line(started()));
    await startPromise;
    source.controller.enqueue(line({ type: "context.compacting" }));
    await vi.waitFor(() => expect(runtime.getSnapshot(conversationId)?.phase).toBe("compacting"));

    source.controller.enqueue(line(terminal));
    source.controller.close();
    await vi.waitFor(() => expect(fetchConversation).toHaveBeenCalledOnce());
    expect(runtime.getSnapshot(conversationId)).toMatchObject({ phase: status });

    canonicalPending.resolve(canonical());
    await vi.waitFor(() => expect(runtime.getSnapshot(conversationId)).toBeUndefined());
    expect(fetchResponseStates).toHaveBeenCalledOnce();
    runtime.dispose();
  });

  it("exposes only browser-authored committed user text for presentation", async () => {
    const draftStream = controlledStream();
    const draftRuntime = createRuntime({
      openResponse: vi.fn(async () => draftStream.stream),
    });
    const draftStarted = draftRuntime.runtime.startResponse(conversationId, request);
    draftStream.controller.enqueue(line(started()));
    await draftStarted;
    expect(draftRuntime.runtime.getSnapshot(conversationId)?.committedUserText).toBe("Pregunta");
    draftRuntime.runtime.dispose();

    const continueStream = controlledStream();
    const continueRuntime = createRuntime({
      openResponse: vi.fn(async () => continueStream.stream),
    });
    const continueStarted = continueRuntime.runtime.startResponse(conversationId, {
      source: "continue",
      parentMessageId: messageId,
      modelTier: "balanced",
      observedRevision: 2,
    });
    continueStream.controller.enqueue(line(started()));
    await continueStarted;
    expect(continueRuntime.runtime.getSnapshot(conversationId)?.committedUserText).toBeUndefined();
    continueRuntime.runtime.dispose();
  });

  it("commits cancellation before aborting the stream and reconciles with a fresh signal", async () => {
    const source = controlledStream();
    let streamSignal: AbortSignal | undefined;
    let releaseCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const cancel = vi.fn(
      async (_conversation: string, _generation: string, signal?: AbortSignal) => {
        expect(streamSignal?.aborted).toBe(false);
        expect(signal?.aborted).toBe(false);
        await cancellation;
      },
    );
    const fetchConversation = vi.fn(
      async (_conversation: string, _cursor: string | undefined, signal?: AbortSignal) => {
        expect(signal?.aborted).toBe(false);
        return canonical();
      },
    );
    const fetchResponseStates = vi.fn(async () => responseState());
    const { runtime } = createRuntime({
      cancel,
      fetchConversation,
      fetchResponseStates,
      openResponse: vi.fn(async (_conversation, _request, _key, signal) => {
        streamSignal = signal;
        return source.stream;
      }),
    });
    const startPromise = runtime.startResponse(conversationId, request);
    source.controller.enqueue(line(started()));
    await startPromise;

    const stopping = runtime.stopResponse(conversationId);
    expect(cancel).toHaveBeenCalledOnce();
    expect(streamSignal?.aborted).toBe(false);
    expect(runtime.getSnapshot(conversationId)?.phase).toBe("stopping");
    source.controller.enqueue(line({ type: "content.delta", text: "Parcial" }));
    await vi.waitFor(() => expect(runtime.getSnapshot(conversationId)?.text).toBe("Parcial"));
    expect(runtime.getSnapshot(conversationId)?.phase).toBe("stopping");
    releaseCancellation();
    await stopping;

    expect(streamSignal?.aborted).toBe(true);
    expect(fetchConversation).toHaveBeenCalledOnce();
    expect(fetchResponseStates).toHaveBeenCalledOnce();
    expect(runtime.getSnapshot(conversationId)).toBeUndefined();
    runtime.dispose();
  });

  it("keeps the live stream retryable when cancellation itself fails", async () => {
    const source = controlledStream();
    let streamSignal: AbortSignal | undefined;
    const cancel = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(undefined);
    const { runtime } = createRuntime({
      cancel,
      fetchConversation: vi.fn(async () => canonical()),
      fetchResponseStates: vi.fn(async () => responseState()),
      openResponse: vi.fn(async (_conversation, _request, _key, signal) => {
        streamSignal = signal;
        return source.stream;
      }),
    });
    const startPromise = runtime.startResponse(conversationId, request);
    source.controller.enqueue(line(started()));
    await startPromise;

    await runtime.stopResponse(conversationId);
    expect(streamSignal?.aborted).toBe(false);
    expect(runtime.getSnapshot(conversationId)?.phase).toBe("generating");

    await runtime.stopResponse(conversationId);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(streamSignal?.aborted).toBe(true);
    expect(runtime.getSnapshot(conversationId)).toBeUndefined();
    runtime.dispose();
  });

  it("does not revive generation after its durable attachment fails during Stop", async () => {
    const cancellation = Promise.withResolvers<void>();
    const nextUpdate = Promise.withResolvers<ResponseUpdatesResponse>();
    const fetchResponseUpdates = vi
      .fn()
      .mockResolvedValueOnce(updates({ text: "Durable" }))
      .mockImplementationOnce(async () => nextUpdate.promise);
    const { runtime } = createRuntime({
      cancel: vi.fn(async () => cancellation.promise),
      fetchConversation: vi.fn(async () => {
        throw new TypeError("canonical unavailable");
      }),
      fetchResponseUpdates,
    });
    (
      runtime as unknown as {
        waitForAttachAttempt: () => Promise<void>;
      }
    ).waitForAttachAttempt = async () => undefined;
    runtime.attachRemote(conversationId, { generationId, messageId });
    await vi.waitFor(() => expect(fetchResponseUpdates).toHaveBeenCalledTimes(2));

    const stopping = runtime.stopResponse(conversationId);
    expect(runtime.getSnapshot(conversationId)?.phase).toBe("stopping");
    nextUpdate.reject(new ConversationApiError(409, "GENERATION_ACTIVE"));
    await vi.waitFor(() =>
      expect(runtime.getSnapshot(conversationId)).toMatchObject({
        errorCode: "STREAM_PROTOCOL_ERROR",
        phase: "protocol-failure",
        recoveryRequired: true,
      }),
    );

    cancellation.reject(new TypeError("cancellation unavailable"));
    await stopping;
    expect(runtime.getSnapshot(conversationId)).toMatchObject({
      errorCode: "STREAM_PROTOCOL_ERROR",
      phase: "protocol-failure",
      recoveryRequired: true,
    });
    runtime.dispose();
  });

  it("keeps a failed remote Stop fenced until terminal state can reconcile it", async () => {
    const cancel = vi.fn().mockRejectedValue(new TypeError("network unavailable"));
    const fetchConversation = vi.fn(async () => canonical());
    const fetchResponseStates = vi.fn(async () => responseState("completed"));
    const { runtime } = createRuntime({ cancel, fetchConversation, fetchResponseStates });

    await runtime.stopResponse(conversationId, { generationId, messageId });

    expect(runtime.getSnapshot(conversationId)).toMatchObject({
      locallyOwned: false,
      phase: "generating",
      recoveryRequired: false,
    });
    await runtime.recoverConversation(conversationId);

    expect(fetchConversation).toHaveBeenCalledOnce();
    expect(fetchResponseStates).toHaveBeenCalledOnce();
    expect(runtime.getSnapshot(conversationId)).toBeUndefined();
    runtime.dispose();
  });

  it("preserves a received terminal outcome when its pending Stop request fails", async () => {
    const source = controlledStream();
    let rejectCancellation!: (error: unknown) => void;
    const cancellation = new Promise<void>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    let rejectResponseState!: (error: unknown) => void;
    const responseStatePending = new Promise<ResponseStateResponse>((_resolve, reject) => {
      rejectResponseState = reject;
    });
    const fetchConversation = vi.fn(async () => canonical());
    const fetchResponseStates = vi.fn(() => responseStatePending);
    const { runtime } = createRuntime({
      cancel: vi.fn(() => cancellation),
      fetchConversation,
      fetchResponseStates,
      openResponse: vi.fn(async () => source.stream),
    });
    const startPromise = runtime.startResponse(conversationId, request);
    source.controller.enqueue(line(started()));
    await startPromise;

    const stopping = runtime.stopResponse(conversationId);
    source.controller.enqueue(line(completedEvent()));
    source.controller.close();
    await vi.waitFor(() => expect(fetchResponseStates).toHaveBeenCalledOnce());
    expect(runtime.getSnapshot(conversationId)?.phase).toBe("completed");

    rejectCancellation(new TypeError("cancellation response lost"));
    await Promise.resolve();
    rejectResponseState(new TypeError("canonical state temporarily unavailable"));
    await stopping;

    expect(fetchConversation).toHaveBeenCalledOnce();
    expect(fetchResponseStates).toHaveBeenCalledOnce();
    expect(runtime.getSnapshot(conversationId)).toMatchObject({
      phase: "completed",
      reason: "stop",
      recoveryRequired: true,
    });
    runtime.dispose();
  });

  it.each(["local", "remote"] as const)(
    "releases a %s Stop after durable cancellation when response-state is a rollout 404",
    async (ownership) => {
      const active = controlledStream();
      const retryStream = controlledStream();
      const openResponse = vi.fn(async () => retryStream.stream);
      if (ownership === "local") {
        openResponse.mockResolvedValueOnce(active.stream);
      }
      const cancel = vi.fn(async () => undefined);
      const { runtime } = createRuntime({
        cancel,
        fetchConversation: vi.fn(async () => canonical()),
        fetchResponseStates: vi.fn(async () => {
          throw new ConversationApiError(404, "NOT_FOUND");
        }),
        openResponse,
      });

      if (ownership === "local") {
        const startPromise = runtime.startResponse(conversationId, request);
        active.controller.enqueue(line(started()));
        await startPromise;
        await runtime.stopResponse(conversationId);
      } else {
        await runtime.stopResponse(conversationId, { generationId, messageId });
      }

      expect(cancel).toHaveBeenCalledOnce();
      expect(runtime.getSnapshot(conversationId)).toBeUndefined();
      const retry = runtime.startResponse(conversationId, request);
      retryStream.controller.enqueue(line(started()));
      await expect(retry).resolves.toMatchObject({ generationId });
      runtime.dispose();
    },
  );

  it("keeps a content-free pre-start failure while releasing the next explicit start", async () => {
    const rejected = new ConversationApiError(409, "DRAFT_CHANGED");
    const next = controlledStream();
    const openResponse = vi.fn().mockRejectedValueOnce(rejected).mockResolvedValueOnce(next.stream);
    const fetchConversation = vi.fn(async () => canonical());
    const onStarted = vi.fn();
    const { runtime } = createRuntime({ fetchConversation, openResponse });

    await expect(runtime.startResponse(conversationId, request, { onStarted })).rejects.toBe(
      rejected,
    );
    expect(runtime.getSnapshot(conversationId)).toMatchObject({
      errorCode: "DRAFT_CHANGED",
      phase: "failed",
      text: "",
    });
    expect(fetchConversation).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();

    const retry = runtime.startResponse(conversationId, request);
    next.controller.enqueue(line(started()));
    await expect(retry).resolves.toMatchObject({ generationId });
    runtime.dispose();
  });

  it("refetches canonical state when a successful stream ends before response.started", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const onStarted = vi.fn();
    const fetchConversation = vi.fn(async () => canonical());
    const { queryClient, runtime } = createRuntime({
      fetchConversation,
      openResponse: vi.fn(async () => stream),
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await expect(
      runtime.startResponse(conversationId, request, { onStarted }),
    ).rejects.toMatchObject({ code: "STREAM_INTERRUPTED" });
    expect(runtime.getSnapshot(conversationId)).toMatchObject({
      errorCode: "STREAM_INTERRUPTED",
      phase: "interrupted",
      text: "",
    });
    expect(
      queryClient.getQueryData(conversationQueryKeys.detail(queryScope, conversationId)),
    ).toEqual({ pages: [canonical()], pageParams: [undefined] });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: conversationQueryKeys.draft(queryScope, {
        kind: "conversation",
        conversationId,
      }),
    });
    expect(fetchConversation).toHaveBeenCalledOnce();
    expect(onStarted).toHaveBeenCalledOnce();
    runtime.dispose();
  });

  it("watchdogs a silent stream and adopts its terminal canonical partial", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      start(controller) {
        source = controller;
      },
    });
    const recovered = canonical();
    const assistant = recovered.messages.find((message) => message.id === messageId);
    if (!assistant) {
      throw new Error("The canonical fixture is missing its assistant response");
    }
    assistant.content = [{ type: "text", text: "Parcial visible" }];
    const fetchConversation = vi.fn(async () => recovered);
    const fetchResponseStates = vi.fn(
      async (): Promise<ResponseStateResponse> => ({
        conversationId,
        revision: 2,
        responses: [
          {
            errorCode: "STREAM_INTERRUPTED",
            generationId,
            messageId,
            reason: "error",
            status: "incomplete",
          },
        ],
      }),
    );
    const fetchResponseUpdates = vi.fn(async () =>
      updates({ status: "incomplete", text: "Parcial visible" }),
    );
    const { queryClient, runtime } = createRuntime({
      fetchConversation,
      fetchResponseStates,
      fetchResponseUpdates,
      openResponse: vi.fn(async () => stream),
    });
    const startPromise = runtime.startResponse(conversationId, request);
    source.enqueue(line(started()));
    await vi.advanceTimersByTimeAsync(0);
    await startPromise;
    source.enqueue(line({ text: "Parcial visible", type: "content.delta" }));
    await vi.advanceTimersByTimeAsync(16);
    expect(runtime.getSnapshot(conversationId)?.text).toBe("Parcial visible");

    await vi.advanceTimersByTimeAsync(STREAM_INACTIVITY_TIMEOUT_MS);
    for (let attempt = 0; attempt < 40 && runtime.getSnapshot(conversationId); attempt += 1) {
      await Promise.resolve();
    }

    // The silent transport is abandoned, but the generation is followed durably instead of
    // being declared interrupted by the browser alone.
    expect(cancelled).toBe(true);
    expect(fetchResponseUpdates).toHaveBeenCalledWith(
      conversationId,
      generationId,
      { cursor: null },
      expect.any(AbortSignal),
    );
    expect(fetchConversation).toHaveBeenCalledOnce();
    expect(fetchResponseStates).toHaveBeenCalledOnce();
    expect(runtime.getSnapshot(conversationId)).toBeUndefined();
    expect(
      queryClient
        .getQueryData<{ pages: ConversationDetailResponse[] }>(
          conversationQueryKeys.detail(queryScope, conversationId),
        )
        ?.pages[0]?.messages.find((message) => message.id === messageId)?.content[0]?.text,
    ).toBe("Parcial visible");
    runtime.dispose();
  });

  it("treats a successful response with the wrong media type as committed exactly once", async () => {
    const onStarted = vi.fn();
    const fetchConversation = vi.fn(async () => canonical());
    const { runtime } = createRuntime({
      fetchConversation,
      openResponse: vi.fn(async () => {
        throw new ConversationStreamProtocolError();
      }),
    });

    await expect(
      runtime.startResponse(conversationId, request, { onStarted }),
    ).rejects.toMatchObject({ code: "STREAM_PROTOCOL_ERROR" });
    expect(fetchConversation).toHaveBeenCalledOnce();
    expect(onStarted).toHaveBeenCalledOnce();
    expect(runtime.getSnapshot(conversationId)).toMatchObject({
      phase: "protocol-failure",
      text: "",
    });
    runtime.dispose();
  });

  it("uses canonical turn shape before consuming a pre-header ambiguous draft", async () => {
    const committed = vi.fn();
    const committedRuntime = createRuntime({
      fetchConversation: vi.fn(async () => canonical()),
      openResponse: vi.fn(async () => {
        throw new TypeError("network unavailable");
      }),
    });

    await expect(
      committedRuntime.runtime.startResponse(conversationId, request, {
        onStarted: committed,
      }),
    ).rejects.toMatchObject({ code: "STREAM_INTERRUPTED" });
    expect(committed).toHaveBeenCalledOnce();
    committedRuntime.runtime.dispose();

    const notCommitted = vi.fn();
    const uncommitted = canonical();
    uncommitted.conversation.revision = request.observedRevision;
    uncommitted.selectedLeafId = null;
    uncommitted.messages = [];
    const uncommittedRuntime = createRuntime({
      fetchConversation: vi.fn(async () => uncommitted),
      openResponse: vi.fn(async () => {
        throw new TypeError("network unavailable");
      }),
    });

    await expect(
      uncommittedRuntime.runtime.startResponse(conversationId, request, {
        onStarted: notCommitted,
      }),
    ).rejects.toMatchObject({ code: "STREAM_INTERRUPTED" });
    expect(notCommitted).not.toHaveBeenCalled();
    expect(uncommittedRuntime.runtime.getSnapshot(conversationId)).toMatchObject({
      awaitingCanonical: true,
    });
    uncommittedRuntime.runtime.dispose();
  });

  it("replays the same key explicitly after unchanged reads and detects a late commit", async () => {
    const retryStream = controlledStream();
    const unchanged = {
      ...canonical(),
      conversation: { ...canonical().conversation, revision: request.observedRevision },
      selectedLeafId: null,
      messages: [],
    };
    const fetchConversation = vi
      .fn()
      .mockResolvedValueOnce(unchanged)
      .mockResolvedValueOnce(unchanged)
      .mockRejectedValueOnce(new TypeError("canonical read still unavailable"))
      .mockResolvedValueOnce(canonical());
    const openResponse = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("request status unknown"))
      .mockRejectedValueOnce(new ConversationApiError(409, "GENERATION_ALREADY_EXISTS"))
      .mockResolvedValue(retryStream.stream);
    const onStarted = vi.fn();
    const { runtime } = createRuntime({ fetchConversation, openResponse });

    await expect(
      runtime.startResponse(conversationId, request, { onStarted }),
    ).rejects.toMatchObject({ code: "STREAM_INTERRUPTED" });
    expect(runtime.getSnapshot(conversationId)).toMatchObject({ awaitingCanonical: true });
    await runtime.recoverConversation(conversationId);

    expect(openResponse).toHaveBeenCalledTimes(2);
    expect(openResponse.mock.calls[1]?.[2]).toBe(openResponse.mock.calls[0]?.[2]);
    expect(onStarted).toHaveBeenCalledOnce();
    expect(runtime.getSnapshot(conversationId)).toMatchObject({ awaitingCanonical: true });

    await runtime.recoverConversation(conversationId);
    expect(openResponse).toHaveBeenCalledTimes(2);
    expect(onStarted).toHaveBeenCalledOnce();
    expect(runtime.getSnapshot(conversationId)).toBeUndefined();

    const retry = runtime.startResponse(conversationId, request);
    retryStream.controller.enqueue(line(started()));
    await expect(retry).resolves.toMatchObject({ generationId });
    runtime.dispose();
  });

  it("keeps transient pre-header failures fenced until same-key replay proves a commit", async () => {
    const unchanged = {
      ...canonical(),
      conversation: { ...canonical().conversation, revision: request.observedRevision },
      selectedLeafId: null,
      messages: [],
    };
    const fetchConversation = vi
      .fn()
      .mockResolvedValueOnce(unchanged)
      .mockResolvedValueOnce(unchanged)
      .mockResolvedValueOnce(unchanged)
      .mockResolvedValueOnce(unchanged)
      .mockResolvedValueOnce(canonical());
    const openResponse = vi
      .fn()
      .mockRejectedValueOnce(new ConversationApiError(503, "INTERNAL_ERROR"))
      .mockRejectedValueOnce(new ConversationApiError(503, "INTERNAL_ERROR"))
      .mockRejectedValueOnce(new ConversationApiError(409, "GENERATION_ALREADY_EXISTS"));
    const onStarted = vi.fn();
    const { runtime } = createRuntime({ fetchConversation, openResponse });

    await expect(
      runtime.startResponse(conversationId, request, { onStarted }),
    ).rejects.toMatchObject({ code: "STREAM_INTERRUPTED" });
    expect(runtime.getSnapshot(conversationId)).toMatchObject({
      awaitingCanonical: true,
      errorCode: "STREAM_INTERRUPTED",
      phase: "interrupted",
    });
    expect(onStarted).not.toHaveBeenCalled();

    await runtime.recoverConversation(conversationId);
    expect(openResponse).toHaveBeenCalledTimes(2);
    expect(openResponse.mock.calls[1]?.[2]).toBe(openResponse.mock.calls[0]?.[2]);
    expect(runtime.getSnapshot(conversationId)).toMatchObject({
      awaitingCanonical: true,
      errorCode: "STREAM_INTERRUPTED",
      phase: "interrupted",
    });
    expect(onStarted).not.toHaveBeenCalled();

    await runtime.recoverConversation(conversationId);
    expect(openResponse).toHaveBeenCalledTimes(3);
    expect(openResponse.mock.calls[2]?.[2]).toBe(openResponse.mock.calls[0]?.[2]);
    expect(onStarted).toHaveBeenCalledOnce();
    expect(runtime.getSnapshot(conversationId)).toBeUndefined();
    runtime.dispose();
  });

  it("releases the fence only after the same-key replay receives an ordinary rejection", async () => {
    const retryStream = controlledStream();
    const unchanged = {
      ...canonical(),
      conversation: { ...canonical().conversation, revision: request.observedRevision },
      selectedLeafId: null,
      messages: [],
    };
    const fetchConversation = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("canonical read unavailable"))
      .mockResolvedValueOnce(unchanged);
    const openResponse = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("request status unknown"))
      .mockRejectedValueOnce(new ConversationApiError(409, "DRAFT_CHANGED"))
      .mockResolvedValue(retryStream.stream);
    const onStarted = vi.fn();
    const { runtime } = createRuntime({ fetchConversation, openResponse });

    await expect(
      runtime.startResponse(conversationId, request, { onStarted }),
    ).rejects.toMatchObject({ code: "STREAM_INTERRUPTED" });
    await runtime.recoverConversation(conversationId);

    expect(openResponse.mock.calls[1]?.[2]).toBe(openResponse.mock.calls[0]?.[2]);
    expect(onStarted).not.toHaveBeenCalled();
    expect(runtime.getSnapshot(conversationId)).toMatchObject({
      awaitingCanonical: false,
      errorCode: "DRAFT_CHANGED",
      phase: "failed",
    });
    const retry = runtime.startResponse(conversationId, request);
    retryStream.controller.enqueue(line(started()));
    await expect(retry).resolves.toMatchObject({ generationId });
    runtime.dispose();
  });

  it("uses canonical-only retries after a successful response already proved commit", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const successfulCanonical = {
      ...canonical(),
      conversation: { ...canonical().conversation, revision: request.observedRevision },
      selectedLeafId: null,
      messages: [],
    };
    const fetchConversation = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("canonical read unavailable"))
      .mockResolvedValueOnce(successfulCanonical)
      .mockResolvedValueOnce(canonical());
    const openResponse = vi.fn(async () => stream);
    const onStarted = vi.fn();
    const { runtime } = createRuntime({ fetchConversation, openResponse });

    await expect(
      runtime.startResponse(conversationId, request, { onStarted }),
    ).rejects.toMatchObject({ code: "STREAM_INTERRUPTED" });
    expect(runtime.getSnapshot(conversationId)).toMatchObject({ awaitingCanonical: true });
    expect(onStarted).toHaveBeenCalledOnce();
    await runtime.recoverConversation(conversationId);

    expect(openResponse).toHaveBeenCalledOnce();
    expect(onStarted).toHaveBeenCalledOnce();
    expect(runtime.getSnapshot(conversationId)).toMatchObject({ awaitingCanonical: true });
    await runtime.recoverConversation(conversationId);

    expect(openResponse).toHaveBeenCalledOnce();
    expect(onStarted).toHaveBeenCalledOnce();
    expect(runtime.getSnapshot(conversationId)).toBeUndefined();
    runtime.dispose();
  });

  it("reconciles every cached message page without publishing a one-page cache", async () => {
    const source = controlledStream();
    const fetchConversation = vi.fn(async () => {
      throw new Error("Registered infinite detail queries must own canonical refetches.");
    });
    const { queryClient, runtime } = createRuntime({
      fetchConversation,
      fetchResponseStates: vi.fn(async () => responseState("completed")),
      openResponse: vi.fn(async () => source.stream),
    });
    const detailKey = conversationQueryKeys.detail(queryScope, conversationId);
    const olderUserMessageId = "66666666-6666-4666-8666-666666666666";
    const olderAssistantMessageId = "77777777-7777-4777-8777-777777777777";
    const detailQuery = vi.fn(async ({ pageParam }: { pageParam: string | undefined }) => {
      if (pageParam) {
        return {
          ...canonical(),
          messages: [
            {
              id: olderUserMessageId,
              parentMessageId: null,
              role: "user" as const,
              content: [{ type: "text" as const, text: "Pregunta anterior" }],
              createdAt: "2026-08-07T11:00:00.000Z",
              siblingCount: 0,
            },
            {
              id: olderAssistantMessageId,
              parentMessageId: olderUserMessageId,
              role: "assistant" as const,
              content: [{ type: "text" as const, text: "Respuesta anterior" }],
              createdAt: "2026-08-07T11:00:01.000Z",
              siblingCount: 0,
            },
          ],
          nextCursor: null,
        };
      }
      return { ...canonical(), nextCursor: "cursor.signature" };
    });
    await queryClient.fetchInfiniteQuery({
      queryKey: detailKey,
      queryFn: detailQuery,
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
      pages: 2,
    });
    detailQuery.mockClear();
    const detailQueryHash = queryClient
      .getQueryCache()
      .find({ queryKey: detailKey, exact: true })?.queryHash;
    expect(detailQueryHash).toBeTruthy();
    const observedPageCounts: number[] = [];
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.query.queryHash !== detailQueryHash) {
        return;
      }
      const data = event.query.state.data as { pages?: readonly unknown[] } | undefined;
      if (data?.pages) {
        observedPageCounts.push(data.pages.length);
      }
    });

    const startPromise = runtime.startResponse(conversationId, request);
    source.controller.enqueue(line(started()));
    await startPromise;
    source.controller.enqueue(line(completedEvent()));
    source.controller.close();
    await vi.waitFor(() => expect(runtime.getSnapshot(conversationId)).toBeUndefined());

    const cached = queryClient.getQueryData<{ pages: ConversationDetailResponse[] }>(detailKey);
    expect(cached?.pages).toHaveLength(2);
    expect(cached?.pages[1]?.messages.map((message) => message.id)).toEqual([
      olderUserMessageId,
      olderAssistantMessageId,
    ]);
    expect(observedPageCounts).not.toContain(1);
    expect(detailQuery.mock.calls.some(([context]) => context.pageParam === undefined)).toBe(true);
    expect(
      detailQuery.mock.calls.some(([context]) => context.pageParam === "cursor.signature"),
    ).toBe(true);
    expect(fetchConversation).not.toHaveBeenCalled();
    unsubscribe();
    runtime.dispose();
  });

  it("joins a concurrent recovery to the in-flight terminal reconciliation", async () => {
    const source = controlledStream();
    let releaseResponseState!: () => void;
    const responseStatePending = new Promise<void>((resolve) => {
      releaseResponseState = resolve;
    });
    let recoverySignal: AbortSignal | undefined;
    const fetchConversation = vi.fn(async () => canonical());
    const fetchResponseStates = vi.fn(
      async (_conversation: string, _request: unknown, signal?: AbortSignal) => {
        recoverySignal = signal;
        await responseStatePending;
        return responseState("completed");
      },
    );
    const { runtime } = createRuntime({
      fetchConversation,
      fetchResponseStates,
      openResponse: vi.fn(async () => source.stream),
    });
    const startPromise = runtime.startResponse(conversationId, request);
    source.controller.enqueue(line(started()));
    await startPromise;
    source.controller.enqueue(line(completedEvent()));
    source.controller.close();
    await vi.waitFor(() => expect(fetchResponseStates).toHaveBeenCalledOnce());
    expect(runtime.getSnapshot(conversationId)).toMatchObject({
      phase: "completed",
      recoveryRequired: false,
    });

    const concurrentRecovery = runtime.recoverConversation(conversationId);
    await Promise.resolve();

    expect(fetchConversation).toHaveBeenCalledOnce();
    expect(fetchResponseStates).toHaveBeenCalledOnce();
    expect(recoverySignal?.aborted).toBe(false);

    releaseResponseState();
    await concurrentRecovery;
    await vi.waitFor(() => expect(runtime.getSnapshot(conversationId)).toBeUndefined());
    runtime.dispose();
  });

  it("retries a transient terminal reconciliation and then permits the next response", async () => {
    const first = controlledStream();
    const second = controlledStream();
    let rejectFirstResponseState!: (error: unknown) => void;
    const firstResponseState = new Promise<ResponseStateResponse>((_resolve, reject) => {
      rejectFirstResponseState = reject;
    });
    const fetchConversation = vi.fn(async () => canonical());
    const fetchResponseStates = vi
      .fn()
      .mockReturnValueOnce(firstResponseState)
      .mockResolvedValue(responseState("completed"));
    const { runtime } = createRuntime({
      fetchConversation,
      fetchResponseStates,
      openResponse: vi
        .fn()
        .mockResolvedValueOnce(first.stream)
        .mockResolvedValueOnce(second.stream),
    });
    const firstStarted = runtime.startResponse(conversationId, request);
    first.controller.enqueue(line(started()));
    await firstStarted;
    first.controller.enqueue(line(completedEvent()));
    first.controller.close();
    await vi.waitFor(() => expect(fetchResponseStates).toHaveBeenCalledOnce());

    const joinedFailure = runtime.recoverConversation(conversationId);
    expect(fetchConversation).toHaveBeenCalledOnce();
    expect(fetchResponseStates).toHaveBeenCalledOnce();
    rejectFirstResponseState(new TypeError("temporary failure"));
    await joinedFailure;
    expect(runtime.getSnapshot(conversationId)).toMatchObject({
      phase: "completed",
      recoveryRequired: true,
    });

    await expect(runtime.startResponse(conversationId, request)).rejects.toMatchObject({
      code: "GENERATION_ACTIVE",
    });
    await runtime.recoverConversation(conversationId);
    expect(runtime.getSnapshot(conversationId)).toBeUndefined();
    expect(fetchConversation).toHaveBeenCalledTimes(2);
    expect(fetchResponseStates).toHaveBeenCalledTimes(2);

    const nextStarted = runtime.startResponse(conversationId, request);
    second.controller.enqueue(line(started()));
    await expect(nextStarted).resolves.toMatchObject({ generationId });
    runtime.dispose();
  });

  it("releases a durable terminal response when response-state is unavailable during rollout", async () => {
    const source = controlledStream();
    const next = controlledStream();
    const { runtime } = createRuntime({
      fetchConversation: vi.fn(async () => canonical()),
      fetchResponseStates: vi.fn(async () => {
        throw new ConversationApiError(404, "NOT_FOUND");
      }),
      openResponse: vi.fn().mockResolvedValueOnce(source.stream).mockResolvedValueOnce(next.stream),
    });
    const firstStarted = runtime.startResponse(conversationId, request);
    source.controller.enqueue(line(started()));
    await firstStarted;
    source.controller.enqueue(line(completedEvent()));
    source.controller.close();
    await vi.waitFor(() => expect(runtime.getSnapshot(conversationId)).toBeUndefined());

    const nextStarted = runtime.startResponse(conversationId, request);
    next.controller.enqueue(line(started()));
    await expect(nextStarted).resolves.toMatchObject({ generationId });
    runtime.dispose();
  });

  it("hands a transport loss back to canonical polling when durable updates answer 404", async () => {
    const rolloutStream = controlledStream();
    const fetchResponseUpdates = vi.fn(async () => {
      throw new ConversationApiError(404, "NOT_FOUND");
    });
    const fetchConversation = vi.fn(async () => canonical());
    const fetchResponseStates = vi.fn(async () => responseState("active"));
    const rollout = createRuntime({
      fetchConversation,
      fetchResponseStates,
      fetchResponseUpdates,
      openResponse: vi.fn(async () => rolloutStream.stream),
    });
    const rolloutStarted = rollout.runtime.startResponse(conversationId, request);
    rolloutStream.controller.enqueue(line(started()));
    await rolloutStarted;
    rolloutStream.controller.error(new TypeError("connection lost"));
    await vi.waitFor(() => expect(rollout.runtime.getSnapshot(conversationId)).toBeUndefined());
    expect(fetchResponseUpdates).toHaveBeenCalledOnce();
    expect(fetchConversation).toHaveBeenCalledOnce();
    expect(fetchResponseStates).toHaveBeenCalledOnce();
    expect(
      rollout.queryClient.getQueryData(
        conversationQueryKeys.responseState(queryScope, conversationId, [messageId]),
      ),
    ).toEqual(responseState("active"));
    // Rediscovery of the same generation never re-attaches; polling owns it.
    rollout.runtime.attachRemote(conversationId, { generationId, messageId });
    expect(rollout.runtime.getSnapshot(conversationId)).toBeUndefined();
    expect(fetchResponseUpdates).toHaveBeenCalledOnce();
    rollout.runtime.dispose();
  });

  it("hands a status-only durable updates 404 to canonical polling", async () => {
    const fetchResponseUpdates = vi.fn(async () => {
      throw new ConversationHttpError(404);
    });
    const fetchConversation = vi.fn(async () => canonical());
    const fetchResponseStates = vi.fn(async () => responseState("active"));
    const { runtime } = createRuntime({
      fetchConversation,
      fetchResponseStates,
      fetchResponseUpdates,
    });

    runtime.attachRemote(conversationId, { generationId, messageId });
    await vi.waitFor(() => expect(runtime.getSnapshot(conversationId)).toBeUndefined());

    expect(fetchResponseUpdates).toHaveBeenCalledOnce();
    expect(fetchConversation).toHaveBeenCalledOnce();
    expect(fetchResponseStates).toHaveBeenCalledOnce();
    runtime.dispose();
  });

  it("retains a recoverable overlay when the 404 canonical handoff is unavailable", async () => {
    const rolloutStream = controlledStream();
    const fetchConversation = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("canonical unavailable"))
      .mockResolvedValueOnce(canonical());
    const fetchResponseStates = vi.fn(async () => responseState("active"));
    const fetchResponseUpdates = vi.fn(async () => {
      throw new ConversationApiError(404, "NOT_FOUND");
    });
    const { runtime } = createRuntime({
      fetchConversation,
      fetchResponseStates,
      fetchResponseUpdates,
      openResponse: vi.fn(async () => rolloutStream.stream),
    });
    const pending = runtime.startResponse(conversationId, request);
    rolloutStream.controller.enqueue(line(started()));
    await pending;
    rolloutStream.controller.enqueue(line({ text: "Parcial", type: "content.delta" }));
    await vi.waitFor(() =>
      expect(runtime.getSnapshot(conversationId)).toMatchObject({ text: "Parcial" }),
    );
    rolloutStream.controller.error(new TypeError("connection lost"));

    await vi.waitFor(() =>
      expect(runtime.getSnapshot(conversationId)).toMatchObject({
        errorCode: "STREAM_INTERRUPTED",
        phase: "interrupted",
        recoveryRequired: true,
        text: "Parcial",
      }),
    );
    await runtime.recoverConversation(conversationId);
    expect(runtime.getSnapshot(conversationId)).toBeUndefined();
    expect(fetchConversation).toHaveBeenCalledTimes(2);
    expect(fetchResponseStates).toHaveBeenCalledOnce();
    expect(fetchResponseUpdates).toHaveBeenCalledOnce();
    runtime.dispose();
  });

  it("converges to missing when the 404 handoff confirms the conversation was deleted", async () => {
    const rolloutStream = controlledStream();
    const fetchConversation = vi.fn(async () => {
      throw new ConversationApiError(404, "NOT_FOUND");
    });
    const fetchResponseStates = vi.fn(async () => responseState("active"));
    const { runtime } = createRuntime({
      fetchConversation,
      fetchResponseStates,
      fetchResponseUpdates: vi.fn(async () => {
        throw new ConversationApiError(404, "NOT_FOUND");
      }),
      openResponse: vi.fn(async () => rolloutStream.stream),
    });
    const pending = runtime.startResponse(conversationId, request);
    rolloutStream.controller.enqueue(line(started()));
    await pending;
    rolloutStream.controller.error(new TypeError("connection lost"));

    await vi.waitFor(() => expect(runtime.getSnapshot(conversationId)).toBeUndefined());
    expect(fetchConversation).toHaveBeenCalledOnce();
    expect(fetchResponseStates).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it("drops every scoped runtime when reattachment reports workspace denial", async () => {
    const source = controlledStream();
    const fetchResponseUpdates = vi.fn(async () => {
      throw new ConversationApiError(403, "WORKSPACE_ACCESS_DENIED");
    });
    const { runtime } = createRuntime({
      fetchResponseUpdates,
      openResponse: vi.fn(async () => source.stream),
    });
    const pending = runtime.startResponse(conversationId, request);
    source.controller.enqueue(line(started()));
    await pending;
    source.controller.error(new TypeError("connection lost"));

    await vi.waitFor(() => expect(runtime.getSnapshot(conversationId)).toBeUndefined());
    expect(fetchResponseUpdates).toHaveBeenCalledOnce();
  });

  it("does not poll while hidden and resumes the same generation when visible", async () => {
    let visibility: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const fetchResponseUpdates = vi.fn(async () => updates({ status: "completed", text: "Listo" }));
    const { runtime } = createRuntime({
      fetchConversation: vi.fn(async () => canonical()),
      fetchResponseStates: vi.fn(async () => responseState("completed")),
      fetchResponseUpdates,
    });

    runtime.attachRemote(conversationId, { generationId, messageId });
    await Promise.resolve();
    expect(fetchResponseUpdates).not.toHaveBeenCalled();

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(fetchResponseUpdates).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(runtime.getSnapshot(conversationId)).toBeUndefined());
    runtime.dispose();
  });

  it("gates the next successful long poll when the tab becomes hidden", async () => {
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const first = Promise.withResolvers<ResponseUpdatesResponse>();
    const fetchResponseUpdates = vi
      .fn()
      .mockImplementationOnce(async () => first.promise)
      .mockResolvedValueOnce(updates({ status: "completed", text: " final" }));
    const { runtime } = createRuntime({
      fetchConversation: vi.fn(async () => canonical()),
      fetchResponseStates: vi.fn(async () => responseState("completed")),
      fetchResponseUpdates,
    });
    runtime.attachRemote(conversationId, { generationId, messageId });
    await vi.waitFor(() => expect(fetchResponseUpdates).toHaveBeenCalledOnce());

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    first.resolve(updates({ cursor: "next", text: "Durable" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchResponseUpdates).toHaveBeenCalledOnce();

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(fetchResponseUpdates).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(runtime.getSnapshot(conversationId)).toBeUndefined());
    runtime.dispose();
  });

  it("requires both retry backoff and restored connectivity", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let online = true;
    vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
    const fetchResponseUpdates = vi.fn(async () => {
      if (fetchResponseUpdates.mock.calls.length === 1) {
        online = false;
        throw new TypeError("offline");
      }
      return updates({ status: "completed", text: "Recuperada" });
    });
    const { runtime } = createRuntime({
      fetchConversation: vi.fn(async () => canonical()),
      fetchResponseStates: vi.fn(async () => responseState("completed")),
      fetchResponseUpdates,
    });
    runtime.attachRemote(conversationId, { generationId, messageId });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchResponseUpdates).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(200);
    online = true;
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(299);
    expect(fetchResponseUpdates).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchResponseUpdates).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.getSnapshot(conversationId)).toBeUndefined();
    runtime.dispose();
  });

  it("keeps retrying unparseable 5xx updates across successful polls", async () => {
    const cursors: (string | null)[] = [];
    const fetchResponseUpdates = vi.fn(
      async (_conversation: string, _generation: string, input: { cursor: string | null }) => {
        cursors.push(input.cursor);
        if (fetchResponseUpdates.mock.calls.length === 1) {
          throw new ConversationHttpError(502);
        }
        if (fetchResponseUpdates.mock.calls.length === 2) {
          return updates({ cursor: "cursor-1", text: "Durable" });
        }
        if (fetchResponseUpdates.mock.calls.length === 3) {
          throw new ConversationHttpError(503);
        }
        return updates({ status: "completed", text: "Final" });
      },
    );
    const { runtime } = createRuntime({
      fetchConversation: vi.fn(async () => canonical()),
      fetchResponseStates: vi.fn(async () => responseState("completed")),
      fetchResponseUpdates,
    });
    (
      runtime as unknown as {
        waitForAttachAttempt: () => Promise<void>;
      }
    ).waitForAttachAttempt = async () => undefined;

    runtime.attachRemote(conversationId, { generationId, messageId });
    await vi.waitFor(() => expect(runtime.getSnapshot(conversationId)).toBeUndefined());

    expect(fetchResponseUpdates).toHaveBeenCalledTimes(4);
    expect(cursors).toEqual([null, null, "cursor-1", "cursor-1"]);
    runtime.dispose();
  });

  it("rejects cumulative durable updates beyond the shared answer limit", async () => {
    const fetchResponseUpdates = vi
      .fn()
      .mockResolvedValueOnce(updates({ text: "a".repeat(RESPONSE_UPDATES_MAX_TEXT_UTF8_BYTES) }))
      .mockResolvedValueOnce(updates({ mode: "append", text: "b" }));
    const { runtime } = createRuntime({
      fetchConversation: vi.fn(async () => {
        throw new TypeError("canonical unavailable");
      }),
      fetchResponseUpdates,
    });
    runtime.attachRemote(conversationId, { generationId, messageId });

    await vi.waitFor(
      () =>
        expect(runtime.getSnapshot(conversationId)).toMatchObject({
          errorCode: "STREAM_PROTOCOL_ERROR",
          phase: "protocol-failure",
          recoveryRequired: true,
          text: "a".repeat(RESPONSE_UPDATES_MAX_TEXT_UTF8_BYTES),
        }),
      { timeout: 2_000 },
    );
    expect(fetchResponseUpdates).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });

  it("reattaches durably after a transport loss and finishes on the terminal update", async () => {
    const stream = controlledStream();
    const cursors: (string | null)[] = [];
    const fetchResponseUpdates = vi.fn(
      async (_conversation: string, _generation: string, input: { cursor: string | null }) => {
        cursors.push(input.cursor);
        if (input.cursor === null) {
          return updates({ cursor: "c1", text: "Durable " });
        }
        if (input.cursor === "c1") {
          return updates({ cursor: "c2", mode: "append", text: "partial" });
        }
        if (input.cursor === "c2") {
          return updates({ cursor: "c3", mode: "append", phase: "naming", text: "" });
        }
        return updates({ mode: "append", status: "completed", text: " done" });
      },
    );
    const { runtime } = createRuntime({
      fetchConversation: vi.fn(async () => canonical()),
      fetchResponseStates: vi.fn(async () => responseState("completed")),
      fetchResponseUpdates,
      openResponse: vi.fn(async () => stream.stream),
    });
    const phases: string[] = [];
    runtime.subscribe(() => {
      const phase = runtime.getSnapshot(conversationId)?.phase;
      if (phase && phases.at(-1) !== phase) {
        phases.push(phase);
      }
    });
    const startPromise = runtime.startResponse(conversationId, request);
    stream.controller.enqueue(line(started()));
    await startPromise;
    stream.controller.enqueue(line({ text: "Volatile", type: "content.delta" }));
    stream.controller.error(new TypeError("connection lost"));
    await vi.waitFor(() => expect(runtime.getSnapshot(conversationId)).toBeUndefined());
    expect(cursors).toEqual([null, "c1", "c2", "c3"]);
    expect(phases).toEqual([
      "starting",
      "generating",
      "reattaching",
      "generating",
      "naming",
      "completed",
    ]);
    runtime.dispose();
  });

  it("follows a discovered remote response read-only and stops it globally", async () => {
    const release = Promise.withResolvers<void>();
    const cancel = vi.fn(async () => {
      release.resolve();
    });
    let calls = 0;
    const fetchResponseUpdates = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return updates({ text: "Remote text" });
      }
      // The server long-polls; the test holds the poll open until Stop commits.
      await release.promise;
      return updates({ status: "cancelled", text: "Remote text" });
    });
    const { runtime } = createRuntime({
      cancel,
      fetchConversation: vi.fn(async () => canonical()),
      fetchResponseStates: vi.fn(async () => responseState("cancelled")),
      fetchResponseUpdates,
    });
    runtime.attachRemote(conversationId, { generationId, messageId });
    expect(runtime.getSnapshot(conversationId)).toMatchObject({
      locallyOwned: false,
      phase: "reattaching",
    });
    await vi.waitFor(() =>
      expect(runtime.getSnapshot(conversationId)).toMatchObject({
        phase: "generating",
        text: "Remote text",
      }),
    );
    await runtime.stopResponse(conversationId, { generationId, messageId });
    expect(cancel).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(runtime.getSnapshot(conversationId)).toBeUndefined());
    runtime.dispose();
  });

  it("resets one invalid cursor and retries transport failures with backoff", async () => {
    const stream = controlledStream();
    const waits: number[] = [];
    let calls = 0;
    const fetchResponseUpdates = vi.fn(
      async (_c: string, _g: string, input: { cursor: string | null }) => {
        calls += 1;
        if (calls === 1) {
          throw new TypeError("offline");
        }
        if (calls === 2) {
          return updates({ cursor: "stale", text: "One" });
        }
        if (calls === 3) {
          expect(input.cursor).toBe("stale");
          throw new ConversationApiError(400, "INVALID_CURSOR");
        }
        expect(input.cursor).toBeNull();
        return updates({ status: "completed", text: "One two" });
      },
    );
    const runtimeOptions = createRuntime({
      fetchConversation: vi.fn(async () => canonical()),
      fetchResponseStates: vi.fn(async () => responseState("completed")),
      fetchResponseUpdates,
      openResponse: vi.fn(async () => stream.stream),
    });
    const { runtime } = runtimeOptions;
    (
      runtime as unknown as {
        waitForAttachAttempt: (notBefore: number) => Promise<void>;
      }
    ).waitForAttachAttempt = async (notBefore: number) => {
      waits.push(notBefore - Date.now());
    };
    const startPromise = runtime.startResponse(conversationId, request);
    stream.controller.enqueue(line(started()));
    await startPromise;
    stream.controller.error(new TypeError("connection lost"));
    await vi.waitFor(() => expect(runtime.getSnapshot(conversationId)).toBeUndefined());
    expect(calls).toBe(4);
    const retryWaits = waits.filter((milliseconds) => milliseconds > 0);
    expect(retryWaits).toHaveLength(1);
    expect(retryWaits[0]).toBeGreaterThanOrEqual(400);
    expect(retryWaits[0]).toBeLessThanOrEqual(600);
    runtime.dispose();
  });

  it("aborts recovery and rejects an unsettled start when the auth scope is disposed", async () => {
    let resolveOpen!: (stream: ReadableStream<Uint8Array>) => void;
    const open = new Promise<ReadableStream<Uint8Array>>((resolve) => {
      resolveOpen = resolve;
    });
    const { runtime } = createRuntime({ openResponse: vi.fn(() => open) });
    const pending = runtime.startResponse(conversationId, request);
    runtime.dispose();
    resolveOpen(controlledStream().stream);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(runtime.getSnapshot(conversationId)).toBeUndefined();
  });

  it("does not publish a late reconciliation failure after auth disposal", async () => {
    const source = controlledStream();
    let rejectResponseState!: (error: unknown) => void;
    const responseStatePending = new Promise<ResponseStateResponse>((_resolve, reject) => {
      rejectResponseState = reject;
    });
    const fetchResponseStates = vi.fn(() => responseStatePending);
    const { runtime } = createRuntime({
      fetchConversation: vi.fn(async () => canonical()),
      fetchResponseStates,
      openResponse: vi.fn(async () => source.stream),
    });
    const listener = vi.fn();
    runtime.subscribe(listener);
    const startPromise = runtime.startResponse(conversationId, request);
    source.controller.enqueue(line(started()));
    await startPromise;
    source.controller.enqueue(line(completedEvent()));
    source.controller.close();
    await vi.waitFor(() => expect(fetchResponseStates).toHaveBeenCalledOnce());
    const recovery = runtime.recoverConversation(conversationId);

    runtime.dispose();
    listener.mockClear();
    rejectResponseState(new TypeError("late response-state failure"));
    await recovery;

    expect(runtime.getSnapshot(conversationId)).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });

  it("publishes the edit branch anchor, target, and browser-authored replacement", async () => {
    const source = controlledStream();
    const editRequest: CreateResponseRequest = {
      source: "edit",
      targetMessageId: userMessageId,
      parentMessageId: null,
      content: [{ type: "text", text: "Pregunta editada" }],
      modelTier: "balanced",
      observedRevision: 2,
    };
    const { runtime } = createRuntime({ openResponse: vi.fn(async () => source.stream) });
    const pending = runtime.startResponse(conversationId, editRequest);
    source.controller.enqueue(line(started()));
    await pending;

    expect(runtime.getSnapshot(conversationId)).toMatchObject({
      branchAnchorMessageId: null,
      committedUserText: "Pregunta editada",
      messageId,
      requestSource: "edit",
      targetMessageId: userMessageId,
    });
    runtime.dispose();
  });

  it("publishes retry as a sibling assistant without browser-authored user text", async () => {
    const source = controlledStream();
    const retryRequest: CreateResponseRequest = {
      source: "retry",
      targetMessageId: messageId,
      parentMessageId: userMessageId,
      modelTier: "balanced",
      observedRevision: 2,
    };
    const { runtime } = createRuntime({ openResponse: vi.fn(async () => source.stream) });
    const pending = runtime.startResponse(conversationId, retryRequest);
    source.controller.enqueue(
      line({
        ...started(),
        messageId: "66666666-6666-4666-8666-666666666666",
        revision: 3,
      }),
    );
    await pending;

    expect(runtime.getSnapshot(conversationId)).toMatchObject({
      branchAnchorMessageId: userMessageId,
      committedUserText: undefined,
      requestSource: "retry",
      targetMessageId: messageId,
    });
    runtime.dispose();
  });

  it("proves an ambiguous edit only from a distinct replacement user branch", async () => {
    const replacementUserId = "66666666-6666-4666-8666-666666666666";
    const replacementAssistantId = "77777777-7777-4777-8777-777777777777";
    const editRequest: CreateResponseRequest = {
      source: "edit",
      targetMessageId: userMessageId,
      parentMessageId: null,
      content: [{ type: "text", text: "Pregunta editada" }],
      modelTier: "balanced",
      observedRevision: 2,
    };
    const committed = canonical();
    committed.conversation.revision = 3;
    committed.selectedLeafId = replacementAssistantId;
    committed.messages = [
      {
        id: replacementUserId,
        parentMessageId: null,
        role: "user",
        content: editRequest.content,
        createdAt: "2026-08-07T12:00:00.000Z",
        siblingCount: 1,
      },
      {
        id: replacementAssistantId,
        parentMessageId: replacementUserId,
        role: "assistant",
        content: [{ type: "text", text: "Respuesta editada" }],
        createdAt: "2026-08-07T12:00:01.000Z",
        siblingCount: 0,
      },
    ];
    const onStarted = vi.fn();
    const { queryClient, runtime } = createRuntime({
      fetchConversation: vi.fn(async () => committed),
      openResponse: vi.fn(async () => {
        throw new TypeError("status unknown");
      }),
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await expect(
      runtime.startResponse(conversationId, editRequest, { onStarted }),
    ).rejects.toMatchObject({ code: "STREAM_INTERRUPTED" });

    expect(onStarted).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: conversationQueryKeys.alternativeContexts(queryScope),
    });
    runtime.dispose();
  });

  it("does not mistake the original assistant for an ambiguous retry commit", async () => {
    const retryRequest: CreateResponseRequest = {
      source: "retry",
      targetMessageId: messageId,
      parentMessageId: userMessageId,
      modelTier: "balanced",
      observedRevision: 1,
    };
    const unchanged = canonical();
    unchanged.conversation.revision = 2;
    const onStarted = vi.fn();
    const { runtime } = createRuntime({
      fetchConversation: vi.fn(async () => unchanged),
      openResponse: vi.fn(async () => {
        throw new TypeError("status unknown");
      }),
    });

    await expect(
      runtime.startResponse(conversationId, retryRequest, { onStarted }),
    ).rejects.toMatchObject({ code: "STREAM_INTERRUPTED" });

    expect(onStarted).not.toHaveBeenCalled();
    expect(runtime.getSnapshot(conversationId)).toMatchObject({ awaitingCanonical: true });
    runtime.dispose();
  });
});
