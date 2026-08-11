import type {
  CreateResponseRequest,
  ResponseStartedEvent,
  ResponseStateResponse,
  StreamEvent,
} from "@capstone/protocol";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";

import {
  ConversationApiError,
  type ConversationQueryScope,
  ConversationStreamProtocolError,
  cancelGeneration,
  conversationQueryKeys,
  fetchConversation,
  fetchResponseStates,
  openConversationResponse,
} from "./api";
import { STREAM_MAX_ACCUMULATOR_BYTES } from "./config";
import { parseResponseStream, StreamReadError } from "./stream-parser";

export type ChatRuntimePhase =
  | "starting"
  | "generating"
  | "compacting"
  | "stopping"
  | "completed"
  | "cancelled"
  | "interrupted"
  | "protocol-failure"
  | "failed"
  | "output-limit";

export interface ChatRuntimeSnapshot {
  readonly awaitingCanonical: boolean;
  readonly branchAnchorMessageId?: string | null;
  readonly committedUserText: string | undefined;
  readonly contextWarning: boolean;
  readonly conversationId: string;
  readonly consumesDraft: boolean;
  readonly errorCode: string | undefined;
  readonly generationId: string | undefined;
  readonly locallyOwned: boolean;
  readonly messageId: string | undefined;
  readonly phase: ChatRuntimePhase;
  readonly reason: string | undefined;
  readonly recoveryRequired: boolean;
  readonly requestSource?: CreateResponseRequest["source"];
  readonly revision: number | undefined;
  readonly text: string;
  readonly targetMessageId?: string;
  readonly userMessageId: string | undefined;
}

interface ChatRuntimeEntry {
  readonly conversationId: string;
  readonly consumesDraft: boolean;
  readonly idempotencyKey: string;
  readonly locallyOwned: boolean;
  readonly onStarted: (() => void) | undefined;
  readonly request: CreateResponseRequest | undefined;
  readonly startReject: (error: unknown) => void;
  readonly startResolve: (event: ResponseStartedEvent) => void;
  readonly streamController: AbortController;
  readonly token: object;
  accumulatorBytes: number;
  awaitingCanonical: boolean;
  cancelController: AbortController | undefined;
  commitNotified: boolean;
  contextWarning: boolean;
  errorCode: string | undefined;
  frame: number | undefined;
  generationId: string | undefined;
  messageId: string | undefined;
  phase: ChatRuntimePhase;
  reason: string | undefined;
  reconciliation: Promise<boolean> | undefined;
  recoveryRequired: boolean;
  recoveryController: AbortController | undefined;
  revision: number | undefined;
  started: boolean;
  streamEndedWhileStopping: boolean;
  terminalObserved: boolean;
  text: string;
  userMessageId: string | undefined;
}

interface ChatRuntimeTransport {
  readonly cancel: typeof cancelGeneration;
  readonly fetchConversation: typeof fetchConversation;
  readonly fetchResponseStates: typeof fetchResponseStates;
  readonly openResponse: typeof openConversationResponse;
}

type AmbiguousStartOutcome = "committed" | "unknown";

export interface ChatRuntimeOptions {
  readonly authSignal: AbortSignal;
  readonly isAuthCurrent: () => boolean;
  readonly queryClient: QueryClient;
  readonly queryScope: ConversationQueryScope;
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
  readonly transport?: Partial<ChatRuntimeTransport>;
}

export interface StartResponseOptions {
  readonly onStarted?: () => void;
}

export interface RemoteGeneration {
  readonly generationId: string;
  readonly messageId: string;
}

export class ChatRuntimeError extends Error {
  readonly code: "GENERATION_ACTIVE" | "STREAM_INTERRUPTED" | "STREAM_PROTOCOL_ERROR";

  constructor(code: ChatRuntimeError["code"]) {
    super(
      code === "GENERATION_ACTIVE"
        ? "A response is already active."
        : code === "STREAM_INTERRUPTED"
          ? "The response stream was interrupted."
          : "The response stream was invalid.",
    );
    this.name = "ChatRuntimeError";
    this.code = code;
  }
}

function defaultRequestFrame(callback: FrameRequestCallback): number {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(callback);
  }
  return window.setTimeout(() => callback(performance.now()), 16);
}

function defaultCancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(handle);
  } else {
    window.clearTimeout(handle);
  }
}

export class ChatRuntime {
  readonly queryScope: ConversationQueryScope;
  private readonly authSignal: AbortSignal;
  private readonly cancelFrame: (handle: number) => void;
  private readonly entries = new Map<string, ChatRuntimeEntry>();
  private readonly isAuthCurrent: () => boolean;
  private readonly listeners = new Set<() => void>();
  private readonly queryClient: QueryClient;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly snapshots = new Map<string, ChatRuntimeSnapshot>();
  private readonly transport: ChatRuntimeTransport;
  private active = true;

  constructor(options: ChatRuntimeOptions) {
    this.authSignal = options.authSignal;
    this.isAuthCurrent = options.isAuthCurrent;
    this.queryClient = options.queryClient;
    this.queryScope = options.queryScope;
    this.requestFrame = options.requestFrame ?? defaultRequestFrame;
    this.cancelFrame = options.cancelFrame ?? defaultCancelFrame;
    this.transport = {
      cancel: options.transport?.cancel ?? cancelGeneration,
      fetchConversation: options.transport?.fetchConversation ?? fetchConversation,
      fetchResponseStates: options.transport?.fetchResponseStates ?? fetchResponseStates,
      openResponse: options.transport?.openResponse ?? openConversationResponse,
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (conversationId: string): ChatRuntimeSnapshot | undefined =>
    this.snapshots.get(conversationId);

  startResponse(
    conversationId: string,
    request: CreateResponseRequest,
    options: StartResponseOptions = {},
  ): Promise<ResponseStartedEvent> {
    const existing = this.entries.get(conversationId);
    if (existing) {
      return Promise.reject(new ChatRuntimeError("GENERATION_ACTIVE"));
    }
    if (!this.isCurrent()) {
      return Promise.reject(new DOMException("The authenticated session changed.", "AbortError"));
    }

    let startResolve!: (event: ResponseStartedEvent) => void;
    let startReject!: (error: unknown) => void;
    const started = new Promise<ResponseStartedEvent>((resolve, reject) => {
      startResolve = resolve;
      startReject = reject;
    });
    const entry: ChatRuntimeEntry = {
      accumulatorBytes: 0,
      awaitingCanonical: false,
      cancelController: undefined,
      commitNotified: false,
      contextWarning: false,
      conversationId,
      consumesDraft: request.source === "draft",
      errorCode: undefined,
      frame: undefined,
      generationId: undefined,
      idempotencyKey: crypto.randomUUID().toLowerCase(),
      locallyOwned: true,
      messageId: undefined,
      onStarted: options.onStarted,
      phase: "starting",
      reason: undefined,
      reconciliation: undefined,
      recoveryRequired: false,
      recoveryController: undefined,
      request,
      revision: undefined,
      started: false,
      streamEndedWhileStopping: false,
      terminalObserved: false,
      startReject,
      startResolve,
      streamController: new AbortController(),
      text: "",
      token: {},
      userMessageId: undefined,
    };
    this.entries.set(conversationId, entry);
    this.publish(entry);
    void this.consume(entry);
    return started;
  }

  async stopResponse(conversationId: string, remote?: RemoteGeneration): Promise<void> {
    let entry = this.entries.get(conversationId);
    if (!entry && remote) {
      entry = this.createRemoteStoppingEntry(conversationId, remote);
      this.entries.set(conversationId, entry);
    }
    if (!entry?.generationId || entry.phase === "stopping" || !this.entryIsCurrent(entry)) {
      return;
    }

    entry.phase = "stopping";
    entry.streamEndedWhileStopping = false;
    entry.cancelController = new AbortController();
    this.publish(entry);

    try {
      await this.transport.cancel(
        conversationId,
        entry.generationId,
        AbortSignal.any([entry.cancelController.signal, this.authSignal]),
      );
      if (!this.entryIsCurrent(entry)) {
        return;
      }
      entry.terminalObserved = true;
      entry.streamController.abort();
      const reconciled = await this.reconcile(entry);
      if (reconciled && this.entryIsCurrent(entry)) {
        this.remove(entry);
      } else if (this.entryIsCurrent(entry)) {
        entry.phase = "interrupted";
        entry.errorCode = "STREAM_INTERRUPTED";
        this.publish(entry);
      }
    } catch {
      if (!this.entryIsCurrent(entry)) {
        return;
      }
      if (entry.terminalObserved) {
        const reconciled = await this.reconcile(entry);
        if (reconciled && this.entryIsCurrent(entry)) {
          this.remove(entry);
        }
        return;
      }
      entry.phase = entry.streamEndedWhileStopping ? "interrupted" : "generating";
      entry.errorCode = entry.streamEndedWhileStopping ? "STREAM_INTERRUPTED" : undefined;
      this.publish(entry);
      if (entry.streamEndedWhileStopping) {
        await this.recover(entry);
      }
    } finally {
      entry.cancelController?.abort();
      entry.recoveryController?.abort();
      entry.cancelController = undefined;
    }
  }

  async recoverConversation(conversationId: string): Promise<void> {
    const entry = this.entries.get(conversationId);
    if (entry) {
      if (entry.awaitingCanonical) {
        const outcome = await this.recoverAmbiguousStart(entry, entry.commitNotified);
        if (outcome === "committed" && this.entryIsCurrent(entry)) {
          this.remove(entry);
        } else if (this.entryIsCurrent(entry) && !entry.commitNotified) {
          await this.retryAmbiguousStart(entry);
        }
        return;
      }
      await this.recover(entry);
    }
  }

  discardConversation(conversationId: string): void {
    const entry = this.entries.get(conversationId);
    if (entry) {
      if (!entry.started) {
        entry.startReject(new DOMException("The conversation was removed.", "AbortError"));
      }
      this.remove(entry);
      return;
    }
    if (this.snapshots.delete(conversationId)) {
      this.emit();
    }
  }

  dispose(): void {
    if (!this.active) {
      return;
    }
    this.active = false;
    for (const entry of this.entries.values()) {
      entry.streamController.abort();
      entry.cancelController?.abort();
      entry.recoveryController?.abort();
      if (entry.frame !== undefined) {
        this.cancelFrame(entry.frame);
      }
      if (!entry.started) {
        entry.startReject(new DOMException("The authenticated session changed.", "AbortError"));
      }
    }
    this.entries.clear();
    this.snapshots.clear();
    this.emit();
    this.listeners.clear();
  }

  private async consume(entry: ChatRuntimeEntry, explicitAmbiguousRetry = false): Promise<void> {
    let streamOpened = false;
    try {
      if (!entry.request) {
        throw new ChatRuntimeError("STREAM_PROTOCOL_ERROR");
      }
      const stream = await this.transport.openResponse(
        entry.conversationId,
        entry.request,
        entry.idempotencyKey,
        AbortSignal.any([entry.streamController.signal, this.authSignal]),
      );
      streamOpened = true;
      if (!this.entryIsCurrent(entry)) {
        return;
      }

      for await (const event of parseResponseStream(
        stream,
        AbortSignal.any([entry.streamController.signal, this.authSignal]),
      )) {
        if (!this.entryIsCurrent(entry)) {
          return;
        }
        await this.applyEvent(entry, event);
      }
    } catch (error) {
      if (!this.entryIsCurrent(entry)) {
        return;
      }
      if (!entry.started) {
        if (explicitAmbiguousRetry) {
          await this.handleAmbiguousRetryFailure(entry, error, streamOpened);
          return;
        }
        if (!(error instanceof ConversationApiError) || error.status >= 500) {
          const commitKnown = streamOpened || error instanceof ConversationStreamProtocolError;
          const outcome = await this.recoverAmbiguousStart(entry, commitKnown);
          if (!this.entryIsCurrent(entry)) {
            return;
          }
          entry.awaitingCanonical = outcome === "unknown";
          entry.phase =
            (error instanceof StreamReadError && error.code === "STREAM_PROTOCOL_ERROR") ||
            (error instanceof ChatRuntimeError && error.code === "STREAM_PROTOCOL_ERROR") ||
            error instanceof ConversationStreamProtocolError
              ? "protocol-failure"
              : "interrupted";
          entry.errorCode =
            entry.phase === "protocol-failure" ? "STREAM_PROTOCOL_ERROR" : "STREAM_INTERRUPTED";
          this.publish(entry);
          entry.startReject(
            new ChatRuntimeError(
              entry.phase === "protocol-failure" ? "STREAM_PROTOCOL_ERROR" : "STREAM_INTERRUPTED",
            ),
          );
          if (!entry.awaitingCanonical) {
            this.detach(entry);
          }
          return;
        }
        entry.phase = "failed";
        entry.errorCode = error.code;
        this.publish(entry);
        entry.startReject(error);
        this.detach(entry);
        return;
      }
      if (entry.phase === "stopping" || entry.streamController.signal.aborted) {
        if (entry.phase === "stopping" && !entry.streamController.signal.aborted) {
          entry.streamEndedWhileStopping = true;
        }
        return;
      }
      entry.phase =
        (error instanceof StreamReadError && error.code === "STREAM_PROTOCOL_ERROR") ||
        (error instanceof ChatRuntimeError && error.code === "STREAM_PROTOCOL_ERROR")
          ? "protocol-failure"
          : "interrupted";
      entry.errorCode =
        entry.phase === "protocol-failure" ? "STREAM_PROTOCOL_ERROR" : "STREAM_INTERRUPTED";
      this.flush(entry);
      await this.recover(entry);
    }
  }

  private async applyEvent(entry: ChatRuntimeEntry, event: StreamEvent): Promise<void> {
    if (event.type === "response.started") {
      if (event.conversationId !== entry.conversationId) {
        throw new ChatRuntimeError("STREAM_PROTOCOL_ERROR");
      }
      entry.started = true;
      entry.awaitingCanonical = false;
      entry.generationId = event.generationId;
      entry.userMessageId = event.userMessageId;
      entry.messageId = event.messageId;
      entry.revision = event.revision;
      entry.phase = "generating";
      this.publish(entry);
      entry.startResolve(event);
      this.notifyCommitted(entry);
      void this.invalidateStarted(entry);
      return;
    }

    if (event.type === "content.delta") {
      const byteLength = new TextEncoder().encode(event.text).byteLength;
      if (entry.accumulatorBytes + byteLength > STREAM_MAX_ACCUMULATOR_BYTES) {
        throw new ChatRuntimeError("STREAM_PROTOCOL_ERROR");
      }
      entry.accumulatorBytes += byteLength;
      entry.text += event.text;
      if (entry.phase !== "stopping") {
        entry.phase = "generating";
      }
      this.schedulePublish(entry);
      return;
    }

    if (event.type === "stream.heartbeat") {
      return;
    }

    if (event.type === "context.compacting") {
      if (entry.phase !== "stopping") {
        entry.phase = "compacting";
      }
      this.publish(entry);
      return;
    }
    if (event.type === "context.compacted" || event.type === "context.warning") {
      entry.contextWarning ||= event.type === "context.warning";
      if (entry.phase !== "stopping") {
        entry.phase = "generating";
      }
      this.publish(entry);
      return;
    }

    entry.revision = event.revision;
    entry.terminalObserved = true;
    entry.reason =
      event.type === "response.completed"
        ? event.reason
        : event.type === "response.cancelled"
          ? "cancelled"
          : "error";
    entry.errorCode = event.type === "response.failed" ? event.errorCode : undefined;
    entry.phase =
      event.type === "response.cancelled"
        ? "cancelled"
        : event.type === "response.failed"
          ? event.partial
            ? "interrupted"
            : "failed"
          : event.reason === "length"
            ? "output-limit"
            : "completed";
    this.flush(entry);
    const reconciled = await this.reconcile(entry);
    if (reconciled && this.entryIsCurrent(entry)) {
      this.remove(entry);
    }
  }

  private async invalidateStarted(entry: ChatRuntimeEntry): Promise<void> {
    try {
      await Promise.all([
        this.queryClient.invalidateQueries({
          queryKey: conversationQueryKeys.detail(this.queryScope, entry.conversationId),
        }),
        this.queryClient.invalidateQueries({
          queryKey: conversationQueryKeys.histories(this.queryScope),
        }),
        this.queryClient.invalidateQueries({
          queryKey: conversationQueryKeys.draft(this.queryScope, {
            kind: "conversation",
            conversationId: entry.conversationId,
          }),
        }),
        this.queryClient.invalidateQueries({
          queryKey: conversationQueryKeys.responseStates(this.queryScope),
        }),
        this.queryClient.invalidateQueries({
          queryKey: conversationQueryKeys.alternativeContexts(this.queryScope),
        }),
      ]);
    } catch {
      // The active stream remains authoritative presentation until the next reconciliation.
    }
  }

  private async retryAmbiguousStart(entry: ChatRuntimeEntry): Promise<void> {
    if (!entry.request || !this.entryIsCurrent(entry)) {
      return;
    }
    entry.awaitingCanonical = false;
    entry.phase = "starting";
    entry.errorCode = undefined;
    this.publish(entry);
    await this.consume(entry, true);
  }

  private async handleAmbiguousRetryFailure(
    entry: ChatRuntimeEntry,
    error: unknown,
    streamOpened: boolean,
  ): Promise<void> {
    if (!this.entryIsCurrent(entry)) {
      return;
    }
    if (error instanceof ConversationApiError) {
      if (error.code === "GENERATION_ALREADY_EXISTS") {
        const outcome = await this.recoverAmbiguousStart(entry, true);
        if (!this.entryIsCurrent(entry)) {
          return;
        }
        if (outcome === "committed") {
          this.remove(entry);
          return;
        }
        entry.awaitingCanonical = true;
        entry.phase = "interrupted";
        entry.errorCode = "STREAM_INTERRUPTED";
        this.publish(entry);
        return;
      }

      if (error.status < 500) {
        entry.awaitingCanonical = false;
        entry.phase = "failed";
        entry.errorCode = error.code;
        this.publish(entry);
        this.detach(entry);
        return;
      }
    }

    const commitKnown = streamOpened || error instanceof ConversationStreamProtocolError;
    const outcome = await this.recoverAmbiguousStart(entry, commitKnown);
    if (!this.entryIsCurrent(entry)) {
      return;
    }
    entry.awaitingCanonical = outcome === "unknown";
    entry.phase =
      (error instanceof StreamReadError && error.code === "STREAM_PROTOCOL_ERROR") ||
      (error instanceof ChatRuntimeError && error.code === "STREAM_PROTOCOL_ERROR") ||
      error instanceof ConversationStreamProtocolError
        ? "protocol-failure"
        : "interrupted";
    entry.errorCode =
      entry.phase === "protocol-failure" ? "STREAM_PROTOCOL_ERROR" : "STREAM_INTERRUPTED";
    this.publish(entry);
    if (!entry.awaitingCanonical) {
      this.detach(entry);
    }
  }

  private async recoverAmbiguousStart(
    entry: ChatRuntimeEntry,
    commitKnown: boolean,
  ): Promise<AmbiguousStartOutcome> {
    if (!this.entryIsCurrent(entry)) {
      return "unknown";
    }
    let outcome: AmbiguousStartOutcome = "unknown";
    if (commitKnown) {
      this.notifyCommitted(entry);
    }

    entry.recoveryController?.abort();
    const recoveryController = new AbortController();
    entry.recoveryController = recoveryController;
    const signal = AbortSignal.any([recoveryController.signal, this.authSignal]);
    try {
      const canonical = await this.refreshCanonicalDetail(entry, signal);
      if (!this.entryIsCurrent(entry)) {
        return "unknown";
      }
      if (
        commitKnown &&
        entry.request &&
        canonical.conversation.revision > entry.request.observedRevision
      ) {
        outcome = "committed";
      } else if (this.canonicalShowsCommittedTurn(entry, canonical)) {
        this.notifyCommitted(entry);
        outcome = "committed";
      }
    } catch {
      // Keep the request fenced until a later recovery can establish canonical state.
    } finally {
      if (entry.recoveryController === recoveryController) {
        entry.recoveryController = undefined;
      }
      recoveryController.abort();
    }

    if (!this.entryIsCurrent(entry)) {
      return "unknown";
    }
    await Promise.allSettled([
      this.queryClient.invalidateQueries({
        queryKey: conversationQueryKeys.histories(this.queryScope),
      }),
      this.queryClient.invalidateQueries({
        queryKey: conversationQueryKeys.searches(this.queryScope),
      }),
      this.queryClient.invalidateQueries({
        queryKey: conversationQueryKeys.draft(this.queryScope, {
          kind: "conversation",
          conversationId: entry.conversationId,
        }),
      }),
      this.queryClient.invalidateQueries({
        queryKey: conversationQueryKeys.responseStates(this.queryScope),
      }),
      this.queryClient.invalidateQueries({
        queryKey: conversationQueryKeys.alternativeContexts(this.queryScope),
      }),
    ]);
    return outcome;
  }

  private canonicalShowsCommittedTurn(
    entry: ChatRuntimeEntry,
    canonical: Awaited<ReturnType<typeof fetchConversation>>,
  ): boolean {
    const request = entry.request;
    if (
      !request ||
      canonical.conversation.revision <= request.observedRevision ||
      !canonical.selectedLeafId ||
      canonical.selectedLeafId === request.parentMessageId
    ) {
      return false;
    }

    const assistant = canonical.messages.find((message) => message.id === canonical.selectedLeafId);
    if (assistant?.role !== "assistant") {
      return false;
    }

    if (request.source === "retry") {
      return (
        assistant.id !== request.targetMessageId &&
        assistant.parentMessageId === request.parentMessageId
      );
    }

    const user = canonical.messages.find((message) => message.id === assistant.parentMessageId);
    if (user?.role !== "user" || user.parentMessageId !== request.parentMessageId) {
      return false;
    }
    if (request.source === "continue") {
      return true;
    }
    if (request.source === "edit" && user.id === request.targetMessageId) {
      return false;
    }
    return user.content[0]?.text === request.content[0]?.text;
  }

  private notifyCommitted(entry: ChatRuntimeEntry): void {
    if (entry.commitNotified) {
      return;
    }
    entry.commitNotified = true;
    try {
      entry.onStarted?.();
    } catch {
      // A presentation callback cannot interrupt an already committed server generation.
    }
  }

  private async recover(entry: ChatRuntimeEntry): Promise<void> {
    const reconciled = await this.reconcile(entry);
    if (reconciled && this.entryIsCurrent(entry)) {
      this.remove(entry);
    }
  }

  private reconcile(entry: ChatRuntimeEntry): Promise<boolean> {
    const messageId = entry.messageId;
    if (!messageId || !this.entryIsCurrent(entry)) {
      return Promise.resolve(false);
    }

    if (entry.reconciliation) {
      return entry.reconciliation;
    }

    const reconciliation = this.runReconciliation(entry, messageId)
      .then((reconciled) => {
        if (!reconciled && this.entryIsCurrent(entry)) {
          entry.recoveryRequired = true;
          this.publish(entry);
        }
        return reconciled;
      })
      .finally(() => {
        if (entry.reconciliation === reconciliation) {
          entry.reconciliation = undefined;
        }
      });
    entry.reconciliation = reconciliation;
    return reconciliation;
  }

  private async runReconciliation(entry: ChatRuntimeEntry, messageId: string): Promise<boolean> {
    entry.recoveryController?.abort();
    const recoveryController = new AbortController();
    entry.recoveryController = recoveryController;
    const signal = AbortSignal.any([recoveryController.signal, this.authSignal]);
    try {
      let canonical: Awaited<ReturnType<typeof fetchConversation>>;
      try {
        canonical = await this.refreshCanonicalDetail(entry, signal);
      } catch (error) {
        if (
          error instanceof ConversationApiError &&
          error.status === 404 &&
          this.entryIsCurrent(entry)
        ) {
          this.remove(entry);
        }
        return false;
      }
      if (!this.entryIsCurrent(entry)) {
        return false;
      }
      let responseState: ResponseStateResponse;
      try {
        responseState = await this.transport.fetchResponseStates(
          entry.conversationId,
          { messageIds: [messageId] },
          signal,
        );
      } catch (error) {
        if (
          error instanceof ConversationApiError &&
          error.status === 404 &&
          entry.terminalObserved &&
          (entry.revision === undefined || canonical.conversation.revision >= entry.revision)
        ) {
          await this.invalidateReconciledCollections();
          return this.entryIsCurrent(entry);
        }
        return false;
      }
      if (!this.entryIsCurrent(entry)) {
        return false;
      }
      this.queryClient.setQueryData<ResponseStateResponse>(
        conversationQueryKeys.responseState(this.queryScope, entry.conversationId, [messageId]),
        responseState,
      );
      await this.invalidateReconciledCollections();
      if (!this.entryIsCurrent(entry)) {
        return false;
      }
      const canonicalState = responseState.responses.find((state) => state.messageId === messageId);
      return Boolean(
        canonicalState &&
          canonicalState.status !== "active" &&
          (entry.revision === undefined ||
            (canonical.conversation.revision >= entry.revision &&
              responseState.revision >= entry.revision)),
      );
    } catch {
      return false;
    } finally {
      if (entry.recoveryController === recoveryController) {
        entry.recoveryController = undefined;
      }
      recoveryController.abort();
    }
  }

  private async refreshCanonicalDetail(
    entry: ChatRuntimeEntry,
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<typeof fetchConversation>>> {
    const queryKey = conversationQueryKeys.detail(this.queryScope, entry.conversationId);
    const detailQuery = this.queryClient.getQueryCache().find({ queryKey, exact: true });

    if (detailQuery?.options.queryFn) {
      await this.queryClient.invalidateQueries(
        { queryKey, exact: true, refetchType: "all" },
        { cancelRefetch: true, throwOnError: true },
      );
      if (!this.entryIsCurrent(entry)) {
        throw new DOMException("The authenticated session changed.", "AbortError");
      }
      const refreshed =
        this.queryClient.getQueryData<InfiniteData<Awaited<ReturnType<typeof fetchConversation>>>>(
          queryKey,
        )?.pages[0];
      if (!refreshed) {
        throw new Error("Canonical conversation detail was not cached after refetch.");
      }
      return refreshed;
    }

    const canonical = await this.transport.fetchConversation(
      entry.conversationId,
      undefined,
      signal,
    );
    if (!this.entryIsCurrent(entry)) {
      throw new DOMException("The authenticated session changed.", "AbortError");
    }
    this.queryClient.setQueryData<InfiniteData<Awaited<ReturnType<typeof fetchConversation>>>>(
      queryKey,
      { pages: [canonical], pageParams: [undefined] },
    );
    return canonical;
  }

  private async invalidateReconciledCollections(): Promise<void> {
    await Promise.all([
      this.queryClient.invalidateQueries({
        queryKey: conversationQueryKeys.histories(this.queryScope),
      }),
      this.queryClient.invalidateQueries({
        queryKey: conversationQueryKeys.searches(this.queryScope),
      }),
      this.queryClient.invalidateQueries({
        queryKey: conversationQueryKeys.drafts(this.queryScope),
      }),
      this.queryClient.invalidateQueries({
        queryKey: conversationQueryKeys.responseStates(this.queryScope),
      }),
      this.queryClient.invalidateQueries({
        queryKey: conversationQueryKeys.alternativeContexts(this.queryScope),
      }),
    ]);
  }

  private createRemoteStoppingEntry(
    conversationId: string,
    remote: RemoteGeneration,
  ): ChatRuntimeEntry {
    return {
      accumulatorBytes: 0,
      awaitingCanonical: false,
      cancelController: undefined,
      commitNotified: true,
      contextWarning: false,
      conversationId,
      consumesDraft: false,
      errorCode: undefined,
      frame: undefined,
      generationId: remote.generationId,
      idempotencyKey: "",
      locallyOwned: false,
      messageId: remote.messageId,
      onStarted: undefined,
      phase: "generating",
      reason: undefined,
      reconciliation: undefined,
      recoveryRequired: false,
      recoveryController: undefined,
      request: undefined,
      revision: undefined,
      started: true,
      streamEndedWhileStopping: false,
      terminalObserved: false,
      startReject: () => undefined,
      startResolve: () => undefined,
      streamController: new AbortController(),
      text: "",
      token: {},
      userMessageId: undefined,
    };
  }

  private schedulePublish(entry: ChatRuntimeEntry): void {
    if (entry.frame !== undefined) {
      return;
    }
    entry.frame = this.requestFrame(() => {
      entry.frame = undefined;
      if (this.entryIsCurrent(entry)) {
        this.publish(entry);
      }
    });
  }

  private flush(entry: ChatRuntimeEntry): void {
    if (entry.frame !== undefined) {
      this.cancelFrame(entry.frame);
      entry.frame = undefined;
    }
    this.publish(entry);
  }

  private publish(entry: ChatRuntimeEntry): void {
    if (!this.entryIsCurrent(entry)) {
      return;
    }
    this.snapshots.set(entry.conversationId, {
      awaitingCanonical: entry.awaitingCanonical,
      ...(entry.request
        ? {
            branchAnchorMessageId: entry.request.parentMessageId,
            requestSource: entry.request.source,
          }
        : {}),
      committedUserText:
        entry.userMessageId &&
        (entry.request?.source === "draft" || entry.request?.source === "edit")
          ? entry.request.content[0]?.text
          : undefined,
      contextWarning: entry.contextWarning,
      conversationId: entry.conversationId,
      consumesDraft: entry.consumesDraft,
      errorCode: entry.errorCode,
      generationId: entry.generationId,
      locallyOwned: entry.locallyOwned,
      messageId: entry.messageId,
      phase: entry.phase,
      reason: entry.reason,
      recoveryRequired: entry.recoveryRequired,
      revision: entry.revision,
      text: entry.text,
      ...(entry.request && "targetMessageId" in entry.request
        ? { targetMessageId: entry.request.targetMessageId }
        : {}),
      userMessageId: entry.userMessageId,
    });
    this.emit();
  }

  private remove(entry: ChatRuntimeEntry): void {
    if (!this.entryIsCurrent(entry)) {
      return;
    }
    if (entry.frame !== undefined) {
      this.cancelFrame(entry.frame);
    }
    entry.streamController.abort();
    entry.cancelController?.abort();
    entry.recoveryController?.abort();
    this.entries.delete(entry.conversationId);
    this.snapshots.delete(entry.conversationId);
    this.emit();
  }

  private detach(entry: ChatRuntimeEntry): void {
    if (!this.entryIsCurrent(entry)) {
      return;
    }
    if (entry.frame !== undefined) {
      this.cancelFrame(entry.frame);
    }
    entry.streamController.abort();
    entry.cancelController?.abort();
    entry.recoveryController?.abort();
    this.entries.delete(entry.conversationId);
  }

  private entryIsCurrent(entry: ChatRuntimeEntry): boolean {
    return (
      this.isCurrent() &&
      this.entries.get(entry.conversationId) === entry &&
      this.entries.get(entry.conversationId)?.token === entry.token
    );
  }

  private isCurrent(): boolean {
    return this.active && !this.authSignal.aborted && this.isAuthCurrent();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
