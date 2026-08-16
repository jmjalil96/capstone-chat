import type {
  ConversationMessage,
  ConversationSummary,
  CreateResponseRequest,
  DraftState,
  GenerationModelTier,
  ResponseStartedEvent,
  ResponseState,
  ResponseUpdatesResponse,
  StreamEvent,
} from "@capstone/protocol";
import type { Page, Route } from "@playwright/test";
import { availableModelTierPolicy } from "../../src/test/model-tier-fixture";

const now = "2026-08-07T12:00:00.000Z";
const continueMessage =
  "Continúa desde donde te detuviste, manteniendo el idioma y el formato de la respuesta anterior.";

const session = {
  employee: {
    id: "employee-streaming",
    name: "Empleada de Streaming",
    email: "streaming@example.test",
  },
  workspace: {
    id: "workspace-streaming",
    identity: "capstone-streaming",
    name: "Capstone",
    role: "member",
  },
  session: {
    createdAt: now,
    expiresAt: "2026-08-14T12:00:00.000Z",
  },
} as const;

export interface StreamDelta {
  readonly delayMilliseconds: number;
  readonly text: string;
}

export interface StreamPlan {
  readonly deltas: readonly StreamDelta[];
  readonly outcome: "completed" | "hold" | "interrupted";
  readonly reason?: "length" | "stop";
}

export interface StreamingConversationSeed {
  readonly canonicalDetailDelayMilliseconds?: number;
  readonly id: string;
  readonly title: string;
  readonly revision?: number;
  readonly selectedLeafId?: string | null;
  readonly messages?: readonly ConversationMessage[];
  readonly draft?: Partial<Pick<DraftState, "content" | "revision" | "updatedAt">>;
  readonly responses?: readonly ResponseState[];
  readonly streams?: readonly StreamPlan[];
  /**
   * Scripted durable-update pages served in order to `POST …/responses/:generationId/updates`.
   * Omit it to emulate an API without durable updates (404 → canonical polling fallback).
   */
  readonly updates?: readonly Omit<ResponseUpdatesResponse, "conversationId">[];
}

interface StoredConversation {
  readonly canonicalDetailDelayMilliseconds: number;
  readonly draft: {
    content: string;
    revision: number;
    updatedAt: string | null;
  };
  readonly messages: ConversationMessage[];
  readonly responses: Map<string, ResponseState>;
  readonly streams: StreamPlan[];
  readonly updates: Omit<ResponseUpdatesResponse, "conversationId">[] | null;
  hasStartedResponse: boolean;
  preferredTier: GenerationModelTier;
  selectedLeafId: string | null;
  summary: ConversationSummary;
}

interface StartedStream {
  readonly plan: StreamPlan;
  readonly started: ResponseStartedEvent;
}

export interface CapturedResponseStart {
  readonly conversationId: string;
  readonly request: CreateResponseRequest;
}

export interface StreamingFixture {
  readonly cancellations: readonly { conversationId: string; generationId: string }[];
  readonly draftWrites: readonly { conversationId: string; content: string }[];
  readonly updateRequests: readonly { conversationId: string; cursor: string | null }[];
  readonly starts: readonly CapturedResponseStart[];
  conversation(conversationId: string): {
    readonly draft: DraftState;
    readonly messages: readonly ConversationMessage[];
    readonly responses: readonly ResponseState[];
    readonly revision: number;
  };
}

export interface StreamingPresentationSample {
  readonly marker: string;
  readonly receivedAt: number;
  readonly visibleAt: number | null;
}

export interface StreamingCancellationSample {
  readonly backendObservedAt: number | null;
  readonly clickedAt: number;
  readonly localUiAt: number | null;
}

export interface StreamingBrowserPerformance {
  readonly cancellations: readonly StreamingCancellationSample[];
  readonly presentations: readonly StreamingPresentationSample[];
}

export function browserUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

export function browserMessage(input: {
  readonly id: string;
  readonly parentMessageId: string | null;
  readonly role: "assistant" | "user";
  readonly text: string;
}): ConversationMessage {
  return {
    id: input.id,
    parentMessageId: input.parentMessageId,
    role: input.role,
    content: [{ type: "text", text: input.text }],
    createdAt: now,
    siblingCount: 0,
  };
}

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

class StreamingBackend implements StreamingFixture {
  readonly cancellations: { conversationId: string; generationId: string }[] = [];
  readonly draftWrites: { conversationId: string; content: string }[] = [];
  readonly updateRequests: { conversationId: string; cursor: string | null }[] = [];
  readonly starts: CapturedResponseStart[] = [];
  readonly #conversations = new Map<string, StoredConversation>();
  #nextEntity = 4_096;

  constructor(seeds: readonly StreamingConversationSeed[]) {
    for (const seed of seeds) {
      const revision = seed.revision ?? 0;
      this.#conversations.set(seed.id, {
        canonicalDetailDelayMilliseconds: seed.canonicalDetailDelayMilliseconds ?? 0,
        draft: {
          content: seed.draft?.content ?? "",
          revision: seed.draft?.revision ?? 0,
          updatedAt: seed.draft?.updatedAt ?? null,
        },
        messages: [...(seed.messages ?? [])],
        responses: new Map(seed.responses?.map((response) => [response.messageId, response])),
        hasStartedResponse: false,
        preferredTier: "balanced",
        selectedLeafId: seed.selectedLeafId ?? null,
        streams: [...(seed.streams ?? [])],
        updates: seed.updates === undefined ? null : [...seed.updates],
        summary: {
          id: seed.id,
          title: seed.title,
          isArchived: false,
          revision,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
  }

  conversation(conversationId: string) {
    const conversation = this.#requireConversation(conversationId);
    return {
      draft: this.#draftState(conversationId, conversation),
      messages: conversation.messages,
      responses: [...conversation.responses.values()],
      revision: conversation.summary.revision,
    };
  }

  async route(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === "/api/health/ready") {
      await json(route, { status: "ready", database: "up" });
      return;
    }
    if (url.pathname === "/api/session") {
      await json(route, session);
      return;
    }
    if (url.pathname === "/api/model-tiers" && method === "GET") {
      await json(route, availableModelTierPolicy);
      return;
    }
    if (url.pathname === "/api/conversations" && method === "GET") {
      const view = url.searchParams.get("view");
      const conversations = [...this.#conversations.values()]
        .map((conversation) => conversation.summary)
        .filter((conversation) => conversation.isArchived === (view === "archived"));
      await json(route, { conversations, nextCursor: null });
      return;
    }

    const preferredTierMatch = url.pathname.match(
      /^\/api\/conversations\/([0-9a-f-]+)\/preferred-tier$/u,
    );
    if (preferredTierMatch) {
      const conversationId = preferredTierMatch[1];
      if (!conversationId) {
        await this.#notFound(route);
        return;
      }
      const conversation = this.#conversations.get(conversationId);
      if (!conversation) {
        await this.#notFound(route);
        return;
      }
      if (method === "PUT") {
        const body = request.postDataJSON() as { readonly modelTier: GenerationModelTier };
        conversation.preferredTier = body.modelTier;
      }
      if (method === "GET" || method === "PUT") {
        await json(route, { conversationId, modelTier: conversation.preferredTier });
        return;
      }
    }

    const updatesMatch = url.pathname.match(
      /^\/api\/conversations\/([0-9a-f-]+)\/responses\/([0-9a-f-]+)\/updates$/u,
    );
    if (updatesMatch && method === "POST") {
      const conversationId = updatesMatch[1] ?? "";
      const conversation = this.#conversations.get(conversationId);
      if (!conversation || conversation.updates === null) {
        await this.#notFound(route);
        return;
      }
      this.updateRequests.push({
        conversationId,
        cursor: (request.postDataJSON() as { cursor: string | null }).cursor,
      });
      const next =
        conversation.updates.length > 1 ? conversation.updates.shift() : conversation.updates[0];
      if (next === undefined) {
        await this.#notFound(route);
        return;
      }
      // Mirror the durable content into the canonical message so reconciliation after the terminal
      // update presents the same text the runtime followed.
      const message = conversation.messages.find((entry) => entry.id === next.response.messageId);
      if (message) {
        const current = message.content[0]?.text ?? "";
        message.content = [
          {
            type: "text",
            text: next.content.mode === "replace" ? next.content.text : current + next.content.text,
          },
        ];
      }
      if (next.response.status !== "active") {
        conversation.responses.set(next.response.messageId, next.response);
        conversation.summary = { ...conversation.summary, revision: next.revision };
      }
      await json(route, { ...next, conversationId });
      return;
    }

    const match = url.pathname.match(
      /^\/api\/conversations\/([0-9a-f-]+)(?:\/(draft|response-states))?$/u,
    );
    if (match) {
      const conversationId = match[1];
      if (!conversationId) {
        await this.#notFound(route);
        return;
      }
      const conversation = this.#conversations.get(conversationId);
      if (!conversation) {
        await this.#notFound(route);
        return;
      }
      if (match[2] === "draft") {
        if (method === "GET") {
          await json(route, this.#draftState(conversationId, conversation));
          return;
        }
        if (method === "PUT") {
          const body = request.postDataJSON() as { content: string; observedRevision: number };
          if (body.observedRevision !== conversation.draft.revision) {
            await json(
              route,
              { code: "DRAFT_CHANGED", message: "Draft changed", requestId: "draft-changed" },
              409,
            );
            return;
          }
          conversation.draft.content = body.content;
          conversation.draft.revision += 1;
          conversation.draft.updatedAt = now;
          this.draftWrites.push({ conversationId, content: body.content });
          await json(route, this.#draftState(conversationId, conversation));
          return;
        }
      }
      if (match[2] === "response-states" && method === "POST") {
        const body = request.postDataJSON() as { messageIds: string[] };
        await json(route, {
          conversationId,
          revision: conversation.summary.revision,
          responses: body.messageIds.flatMap((messageId) => {
            const response = conversation.responses.get(messageId);
            return response ? [response] : [];
          }),
        });
        return;
      }
      if (!match[2] && method === "GET") {
        if (conversation.hasStartedResponse && conversation.canonicalDetailDelayMilliseconds > 0) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, conversation.canonicalDetailDelayMilliseconds),
          );
        }
        await json(route, {
          conversation: conversation.summary,
          selectedLeafId: conversation.selectedLeafId,
          messages: conversation.messages,
          nextCursor: null,
        });
        return;
      }
    }

    await json(
      route,
      { code: "NOT_FOUND", message: "Not found", requestId: "unexpected-browser-request" },
      404,
    );
  }

  startResponse(conversationId: string, request: CreateResponseRequest): StartedStream {
    const conversation = this.#requireConversation(conversationId);
    conversation.hasStartedResponse = true;
    this.starts.push({ conversationId, request });
    const userMessageId = this.#uuid();
    const messageId = this.#uuid();
    const generationId = this.#uuid();
    const text = request.source === "draft" ? request.content[0]?.text : continueMessage;
    if (text === undefined) {
      throw new Error("The browser response request contained no text block");
    }
    conversation.messages.push(
      browserMessage({
        id: userMessageId,
        parentMessageId: request.parentMessageId,
        role: "user",
        text,
      }),
      browserMessage({
        id: messageId,
        parentMessageId: userMessageId,
        role: "assistant",
        text: "",
      }),
    );
    conversation.selectedLeafId = messageId;
    conversation.summary = this.#incrementRevision(conversation.summary);
    conversation.responses.set(messageId, {
      generationId,
      messageId,
      status: "active",
      reason: null,
      errorCode: null,
    });
    if (request.source === "draft") {
      conversation.draft.content = "";
      conversation.draft.revision = 0;
      conversation.draft.updatedAt = null;
    }

    return {
      plan: conversation.streams.shift() ?? { deltas: [], outcome: "hold" },
      started: {
        type: "response.started",
        conversationId,
        generationId,
        userMessageId,
        messageId,
        revision: conversation.summary.revision,
      },
    };
  }

  appendDelta(conversationId: string, messageId: string, text: string): void {
    const conversation = this.#requireConversation(conversationId);
    const index = conversation.messages.findIndex((message) => message.id === messageId);
    const message = conversation.messages[index];
    if (message?.role !== "assistant") {
      return;
    }
    conversation.messages[index] = {
      ...message,
      content: [{ type: "text", text: `${message.content[0]?.text ?? ""}${text}` }],
    };
  }

  complete(conversationId: string, messageId: string, reason: "length" | "stop"): StreamEvent {
    const conversation = this.#requireConversation(conversationId);
    const current = conversation.responses.get(messageId);
    if (!current) {
      throw new Error("The completed browser stream has no generation state");
    }
    conversation.summary = this.#incrementRevision(conversation.summary);
    conversation.responses.set(messageId, {
      generationId: current.generationId,
      messageId,
      status: "completed",
      reason,
      errorCode: null,
    });
    return {
      type: "response.completed",
      messageId,
      revision: conversation.summary.revision,
      reason,
      usage: { inputTokens: 6, outputTokens: 4 },
    };
  }

  interrupt(conversationId: string, generationId: string): void {
    const conversation = this.#requireConversation(conversationId);
    const current = [...conversation.responses.values()].find(
      (response) => response.generationId === generationId,
    );
    if (current?.status !== "active") {
      return;
    }
    conversation.summary = this.#incrementRevision(conversation.summary);
    conversation.responses.set(current.messageId, {
      generationId,
      messageId: current.messageId,
      status: "incomplete",
      reason: "error",
      errorCode: "STREAM_INTERRUPTED",
    });
  }

  cancel(conversationId: string, generationId: string): void {
    this.cancellations.push({ conversationId, generationId });
    const conversation = this.#requireConversation(conversationId);
    const current = [...conversation.responses.values()].find(
      (response) => response.generationId === generationId,
    );
    if (current?.status !== "active") {
      return;
    }
    conversation.summary = this.#incrementRevision(conversation.summary);
    conversation.responses.set(current.messageId, {
      generationId,
      messageId: current.messageId,
      status: "cancelled",
      reason: "cancelled",
      errorCode: null,
    });
  }

  #draftState(conversationId: string, conversation: StoredConversation): DraftState {
    return {
      scope: { kind: "conversation", conversationId },
      content: conversation.draft.content,
      revision: conversation.draft.revision,
      updatedAt: conversation.draft.updatedAt,
    };
  }

  #incrementRevision(summary: ConversationSummary): ConversationSummary {
    return { ...summary, revision: summary.revision + 1, updatedAt: now };
  }

  async #notFound(route: Route): Promise<void> {
    await json(route, { code: "NOT_FOUND", message: "Not found", requestId: "not-found" }, 404);
  }

  #requireConversation(conversationId: string): StoredConversation {
    const conversation = this.#conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`Unknown browser conversation ${conversationId}`);
    }
    return conversation;
  }

  #uuid(): string {
    this.#nextEntity += 1;
    return browserUuid(this.#nextEntity);
  }
}

export async function installStreamingFixture(
  page: Page,
  seeds: readonly StreamingConversationSeed[],
): Promise<StreamingFixture> {
  const backend = new StreamingBackend(seeds);

  await page.exposeFunction(
    "__capstoneE2eStartResponse",
    (conversationId: string, request: CreateResponseRequest) =>
      backend.startResponse(conversationId, request),
  );
  await page.exposeFunction(
    "__capstoneE2eAppendDelta",
    (conversationId: string, messageId: string, text: string) =>
      backend.appendDelta(conversationId, messageId, text),
  );
  await page.exposeFunction(
    "__capstoneE2eComplete",
    (conversationId: string, messageId: string, reason: "length" | "stop") =>
      backend.complete(conversationId, messageId, reason),
  );
  await page.exposeFunction(
    "__capstoneE2eInterrupt",
    (conversationId: string, generationId: string) =>
      backend.interrupt(conversationId, generationId),
  );
  await page.exposeFunction("__capstoneE2eCancel", (conversationId: string, generationId: string) =>
    backend.cancel(conversationId, generationId),
  );

  await page.addInitScript(() => {
    interface BrowserBridge {
      __capstoneE2eAppendDelta(
        conversationId: string,
        messageId: string,
        text: string,
      ): Promise<void>;
      __capstoneE2eCancel(conversationId: string, generationId: string): Promise<void>;
      __capstoneE2eComplete(
        conversationId: string,
        messageId: string,
        reason: "length" | "stop",
      ): Promise<StreamEvent>;
      __capstoneE2eInterrupt(conversationId: string, generationId: string): Promise<void>;
      __capstoneE2eStartResponse(
        conversationId: string,
        request: CreateResponseRequest,
      ): Promise<StartedStream>;
    }

    interface MutablePresentationSample {
      marker: string;
      receivedAt: number;
      visibleAt: number | null;
    }

    interface MutableCancellationSample {
      backendObservedAt: number | null;
      clickedAt: number;
      localUiAt: number | null;
    }

    interface BrowserPerformanceState {
      cancellations: MutableCancellationSample[];
      presentations: MutablePresentationSample[];
    }

    interface InstrumentedWindow extends BrowserBridge {
      __capstoneE2ePerformance: BrowserPerformanceState;
    }

    const bridge = window as unknown as InstrumentedWindow;
    const performanceState: BrowserPerformanceState = {
      cancellations: [],
      presentations: [],
    };
    Object.defineProperty(window, "__capstoneE2ePerformance", {
      configurable: true,
      value: performanceState,
    });

    const visible = (element: Element): boolean => element.getClientRects().length > 0;
    const observePresentation = (): void => {
      const visibleContent = [...document.querySelectorAll("[data-message-content]")].filter(
        visible,
      );
      const now = performance.now();
      for (const sample of performanceState.presentations) {
        if (
          sample.visibleAt === null &&
          visibleContent.some((element) => element.textContent?.includes(sample.marker))
        ) {
          sample.visibleAt = now;
        }
      }

      const pendingCancellation = performanceState.cancellations.find(
        (sample) => sample.localUiAt === null,
      );
      if (!pendingCancellation) {
        return;
      }
      const activeStopPresented = [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".draft-editor .composer-action.secondary-button",
        ),
      ].some((button) => visible(button) && !button.disabled);
      if (!activeStopPresented) {
        pendingCancellation.localUiAt = now;
      }
    };

    const beginObservation = (): void => {
      const root = document.documentElement;
      if (!root) {
        document.addEventListener("DOMContentLoaded", beginObservation, { once: true });
        return;
      }
      new MutationObserver(observePresentation).observe(root, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
      document.addEventListener(
        "click",
        (event) => {
          const button = event.target instanceof Element ? event.target.closest("button") : null;
          if (button?.matches(".draft-editor .composer-action.secondary-button")) {
            performanceState.cancellations.push({
              backendObservedAt: null,
              clickedAt: performance.now(),
              localUiAt: null,
            });
          }
        },
        true,
      );
    };
    beginObservation();

    const nativeFetch = window.fetch.bind(window);
    const responsePath = /^\/api\/conversations\/([0-9a-f-]+)\/responses$/u;
    const cancelPath = /^\/api\/conversations\/([0-9a-f-]+)\/responses\/([0-9a-f-]+)\/cancel$/u;
    const encoder = new TextEncoder();
    const pause = (milliseconds: number) =>
      new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const sourceRequest = input instanceof Request ? input : undefined;
      const url = new URL(sourceRequest?.url ?? input.toString(), window.location.href);
      const method = (init?.method ?? sourceRequest?.method ?? "GET").toUpperCase();
      const responseMatch = url.pathname.match(responsePath);
      if (responseMatch && method === "POST") {
        const conversationId = responseMatch[1];
        if (!conversationId) {
          throw new Error("The test response request had no conversation identifier");
        }
        const rawBody =
          typeof init?.body === "string"
            ? init.body
            : sourceRequest
              ? await sourceRequest.clone().text()
              : "";
        const request = JSON.parse(rawBody) as CreateResponseRequest;
        const signal = init?.signal ?? sourceRequest?.signal;
        let active = true;
        let keepAbortListener = false;
        let generationId: string | undefined;

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const write = (event: StreamEvent) => {
              if (active) {
                if (event.type === "content.delta") {
                  performanceState.presentations.push({
                    marker: event.text,
                    receivedAt: performance.now(),
                    visibleAt: null,
                  });
                }
                controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
              }
            };
            const abort = () => {
              if (!active) {
                return;
              }
              active = false;
              if (generationId) {
                void bridge.__capstoneE2eInterrupt(conversationId, generationId);
              }
              controller.error(new DOMException("The browser stream was aborted", "AbortError"));
            };
            signal?.addEventListener("abort", abort, { once: true });
            try {
              const startedStream = await bridge.__capstoneE2eStartResponse(
                conversationId,
                request,
              );
              generationId = startedStream.started.generationId;
              if (!active) {
                return;
              }
              write(startedStream.started);
              for (const delta of startedStream.plan.deltas) {
                await pause(delta.delayMilliseconds);
                if (!active) {
                  return;
                }
                await bridge.__capstoneE2eAppendDelta(
                  conversationId,
                  startedStream.started.messageId,
                  delta.text,
                );
                write({ type: "content.delta", text: delta.text });
              }
              if (startedStream.plan.outcome === "completed") {
                const completed = await bridge.__capstoneE2eComplete(
                  conversationId,
                  startedStream.started.messageId,
                  startedStream.plan.reason ?? "stop",
                );
                active = false;
                controller.enqueue(encoder.encode(`${JSON.stringify(completed)}\n`));
                controller.close();
              } else if (startedStream.plan.outcome === "interrupted") {
                await bridge.__capstoneE2eInterrupt(conversationId, generationId);
                active = false;
                controller.close();
              } else {
                keepAbortListener = true;
              }
            } catch (error) {
              if (active) {
                active = false;
                controller.error(error);
              }
            } finally {
              if (!keepAbortListener) {
                signal?.removeEventListener("abort", abort);
              }
            }
          },
          cancel() {
            active = false;
            if (generationId) {
              void bridge.__capstoneE2eInterrupt(conversationId, generationId);
            }
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        });
      }

      const cancelMatch = url.pathname.match(cancelPath);
      if (cancelMatch && method === "POST") {
        const conversationId = cancelMatch[1];
        const generationId = cancelMatch[2];
        if (!conversationId || !generationId) {
          throw new Error("The test cancellation request was incomplete");
        }
        await bridge.__capstoneE2eCancel(conversationId, generationId);
        const pendingCancellation = performanceState.cancellations.find(
          (sample) => sample.backendObservedAt === null,
        );
        if (pendingCancellation) {
          pendingCancellation.backendObservedAt = performance.now();
        }
        return new Response(null, { status: 204 });
      }

      return nativeFetch(input, init);
    };
  });

  await page.route(/^http:\/\/127\.0\.0\.1:4173\/api\//u, (route) => backend.route(route));
  return backend;
}

export async function readStreamingBrowserPerformance(
  page: Page,
): Promise<StreamingBrowserPerformance> {
  return page.evaluate(() => {
    const state = (
      window as unknown as {
        __capstoneE2ePerformance?: StreamingBrowserPerformance;
      }
    ).__capstoneE2ePerformance;
    if (!state) {
      throw new Error("The streaming browser performance probe was not installed");
    }
    return {
      cancellations: state.cancellations.map((sample) => ({ ...sample })),
      presentations: state.presentations.map((sample) => ({ ...sample })),
    };
  });
}
