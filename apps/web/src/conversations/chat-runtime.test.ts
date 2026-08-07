import type {
  ConversationDetailResponse,
  CreateResponseRequest,
  ResponseStateResponse,
} from "@capstone/protocol";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConversationApiError,
  ConversationStreamProtocolError,
  conversationQueryKeys,
} from "./api";
import { ChatRuntime, ChatRuntimeError } from "./chat-runtime";

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
    expect(runtime.getSnapshot(conversationId)).toBeDefined();

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

  it("keeps recovery for a response-state rollout 404 but discards a deleted conversation", async () => {
    const rolloutStream = controlledStream();
    const rollout = createRuntime({
      fetchConversation: vi.fn(async () => canonical()),
      fetchResponseStates: vi.fn(async () => {
        throw new ConversationApiError(404, "NOT_FOUND");
      }),
      openResponse: vi.fn(async () => rolloutStream.stream),
    });
    const rolloutStarted = rollout.runtime.startResponse(conversationId, request);
    rolloutStream.controller.enqueue(line(started()));
    await rolloutStarted;
    rolloutStream.controller.error(new TypeError("connection lost"));
    await vi.waitFor(() =>
      expect(rollout.runtime.getSnapshot(conversationId)?.phase).toBe("interrupted"),
    );
    expect(
      rollout.queryClient.getQueryData(conversationQueryKeys.detail(queryScope, conversationId)),
    ).toBeDefined();
    rollout.runtime.dispose();

    const deletedStream = controlledStream();
    const deleted = createRuntime({
      fetchConversation: vi.fn(async () => {
        throw new ConversationApiError(404, "NOT_FOUND");
      }),
      fetchResponseStates: vi.fn(async () => responseState()),
      openResponse: vi.fn(async () => deletedStream.stream),
    });
    const deletedStarted = deleted.runtime.startResponse(conversationId, request);
    deletedStream.controller.enqueue(line(started()));
    await deletedStarted;
    deletedStream.controller.error(new TypeError("connection lost"));
    await vi.waitFor(() => expect(deleted.runtime.getSnapshot(conversationId)).toBeUndefined());
    deleted.runtime.dispose();
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
});
