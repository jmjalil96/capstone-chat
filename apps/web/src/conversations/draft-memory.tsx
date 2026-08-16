import type { DraftScope, DraftState } from "@capstone/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { subscribeSessionBoundary } from "../api/session-boundary";
import {
  ConversationApiError,
  type ConversationQueryScope,
  conversationQueryKeys,
  draftScopeKey,
  fetchDraft,
  saveDraft,
} from "./api";
import { DRAFT_AUTOSAVE_DELAY_MS } from "./config";
import { type ContentValidationIssue, draftContentValidationIssue } from "./content-validation";
import {
  acceptServerDraft,
  adoptRefreshedDraft,
  beginDraftSave,
  blockDraftAfterConflict,
  completeDraftSave,
  consumeConfirmedDraft,
  type DraftRecord,
  editDraft,
  markDraftConflict,
  markDraftUnsaved,
  prepareDraftReplacement,
} from "./draft-state";

interface DraftMemoryContextValue {
  readonly capture: () => AbortSignal;
  readonly discardDraft: (scope: DraftScope) => void;
  readonly editingLocked: boolean;
  readonly records: Readonly<Record<string, DraftRecord | undefined>>;
  readonly flushActiveDraft: () => Promise<boolean>;
  readonly hasUnattendedDrafts: boolean;
  readonly hasUnsavedActiveDraftNow: () => boolean;
  readonly hasUnsavedDraftsNow: () => boolean;
  readonly lockEditing: () => void;
  readonly isCurrent: (capture: AbortSignal) => boolean;
  readonly moveDraftToConversation: (conversationId: string) => void;
  readonly queryScope: ConversationQueryScope;
  readonly registerActiveDraft: (key: string, flush: () => Promise<boolean>) => () => void;
  readonly unlockEditing: () => void;
  readonly consumeDraft: (scope: DraftScope, confirmed: ConfirmedDraft) => void;
  readonly updateRecord: (
    key: string,
    update: (current: DraftRecord | undefined) => DraftRecord | undefined,
  ) => void;
}

const DraftMemoryContext = createContext<DraftMemoryContextValue | null>(null);

interface DraftMemoryProviderProps {
  readonly children: ReactNode;
  readonly queryScope: ConversationQueryScope;
}

interface ConversationGeneration {
  active: boolean;
  readonly controller: AbortController;
  readonly scopeKey: string;
}

function createConversationGeneration(scopeKey: string): ConversationGeneration {
  return { active: true, controller: new AbortController(), scopeKey };
}

export function DraftMemoryProvider({ children, queryScope }: DraftMemoryProviderProps) {
  const queryClient = useQueryClient();
  const scopeKey = JSON.stringify(queryScope);
  const generationRef = useRef<ConversationGeneration | undefined>(undefined);
  if (!generationRef.current) {
    generationRef.current = createConversationGeneration(scopeKey);
  }
  const [records, setRecords] = useState<Record<string, DraftRecord | undefined>>({});
  const [activeDraftKey, setActiveDraftKey] = useState<string | null>(null);
  const [editingLocked, setEditingLocked] = useState(false);
  const recordsRef = useRef(records);
  const activeDraftKeyRef = useRef<string | null>(null);
  const activeFlushRef = useRef<(() => Promise<boolean>) | null>(null);
  const updateRecord = useCallback<DraftMemoryContextValue["updateRecord"]>((key, update) => {
    const current = recordsRef.current;
    const next = { ...current, [key]: update(current[key]) };
    recordsRef.current = next;
    setRecords(next);
  }, []);
  const discardDraft = useCallback((scope: DraftScope) => {
    const key = draftScopeKey(scope);
    const next = { ...recordsRef.current };
    delete next[key];
    recordsRef.current = next;
    setRecords(next);
  }, []);
  const moveDraftToConversation = useCallback(
    (conversationId: string) => {
      const generation = generationRef.current;
      if (!generation?.active || generation.controller.signal.aborted) {
        return;
      }
      const sourceScope = { kind: "new" } as const;
      const targetScope = { kind: "conversation", conversationId } as const;
      const sourceKey = draftScopeKey(sourceScope);
      const targetKey = draftScopeKey(targetScope);
      const sourceRecord = recordsRef.current[sourceKey];
      const next = { ...recordsRef.current };
      delete next[sourceKey];
      if (sourceRecord) {
        next[targetKey] = sourceRecord;
      }
      recordsRef.current = next;
      setRecords(next);

      const sourceQueryKey = conversationQueryKeys.draft(queryScope, sourceScope);
      const targetQueryKey = conversationQueryKeys.draft(queryScope, targetScope);
      const cached = queryClient.getQueryData<DraftState>(sourceQueryKey);
      if (cached) {
        queryClient.setQueryData<DraftState>(targetQueryKey, {
          ...cached,
          scope: targetScope,
        });
      }
      queryClient.removeQueries({ queryKey: sourceQueryKey, exact: true });
    },
    [queryClient, queryScope],
  );
  const consumeDraft = useCallback(
    (scope: DraftScope, confirmed: ConfirmedDraft) => {
      const generation = generationRef.current;
      if (!generation?.active || generation.controller.signal.aborted) {
        return;
      }
      const key = draftScopeKey(scope);
      const empty: DraftState = {
        scope,
        content: "",
        revision: 0,
        updatedAt: null,
      };
      const queryKey = conversationQueryKeys.draft(queryScope, scope);
      const consumed = consumeConfirmedDraft(
        recordsRef.current[key],
        confirmed,
        empty,
        queryClient.getQueryData<DraftState>(queryKey),
      );
      const next = {
        ...recordsRef.current,
        [key]: consumed.record,
      };
      recordsRef.current = next;
      setRecords(next);
      queryClient.setQueryData(queryKey, consumed.canonical);
    },
    [queryClient, queryScope],
  );
  const registerActiveDraft = useCallback((key: string, flush: () => Promise<boolean>) => {
    activeFlushRef.current = flush;
    activeDraftKeyRef.current = key;
    setActiveDraftKey(key);
    return () => {
      if (activeFlushRef.current === flush) {
        activeFlushRef.current = null;
        activeDraftKeyRef.current = null;
        setActiveDraftKey(null);
      }
    };
  }, []);
  const flushActiveDraft = useCallback(async () => activeFlushRef.current?.() ?? true, []);
  const hasUnsavedActiveDraftNow = useCallback(() => {
    const key = activeDraftKeyRef.current;
    return key ? Boolean(recordsRef.current[key]?.dirty) : false;
  }, []);
  const hasUnsavedDraftsNow = useCallback(
    () => Object.values(recordsRef.current).some((record) => record?.dirty),
    [],
  );
  const lockEditing = useCallback(() => setEditingLocked(true), []);
  const unlockEditing = useCallback(() => setEditingLocked(false), []);
  const capture = useCallback(() => {
    const generation = generationRef.current;
    if (!generation) {
      throw new Error("The authenticated conversation generation is unavailable.");
    }
    return generation.controller.signal;
  }, []);
  const isCurrent = useCallback((candidate: AbortSignal) => {
    const generation = generationRef.current;
    return Boolean(
      generation?.active &&
        !generation.controller.signal.aborted &&
        candidate === generation.controller.signal,
    );
  }, []);
  useLayoutEffect(() => {
    let generation = generationRef.current;
    if (!generation || generation.scopeKey !== scopeKey) {
      generation = createConversationGeneration(scopeKey);
      generationRef.current = generation;
      recordsRef.current = {};
      setRecords({});
      setEditingLocked(false);
    }
    generation.active = true;
    return () => {
      generation.active = false;
      queueMicrotask(() => {
        // React replays effects in development; only dispose a generation that stayed inactive.
        if (generation.active) {
          return;
        }
        generation.controller.abort();
        const actorKey = conversationQueryKeys.all(queryScope);
        void queryClient.cancelQueries({ queryKey: actorKey });
        queryClient.removeQueries({ queryKey: actorKey });
      });
    };
  }, [queryClient, queryScope, scopeKey]);
  useLayoutEffect(
    () =>
      subscribeSessionBoundary(() => {
        const generation = generationRef.current;
        if (!generation?.active) {
          return;
        }
        generation.active = false;
        generation.controller.abort();
        const actorKey = conversationQueryKeys.all(queryScope);
        void queryClient.cancelQueries({ queryKey: actorKey });
        queryClient.removeQueries({ queryKey: actorKey });
      }),
    [queryClient, queryScope],
  );
  const value = useMemo(
    () => ({
      capture,
      consumeDraft,
      records,
      discardDraft,
      editingLocked,
      flushActiveDraft,
      hasUnattendedDrafts: Object.entries(records).some(
        ([key, record]) => key !== activeDraftKey && record?.dirty,
      ),
      hasUnsavedActiveDraftNow,
      hasUnsavedDraftsNow,
      isCurrent,
      lockEditing,
      moveDraftToConversation,
      queryScope,
      registerActiveDraft,
      unlockEditing,
      updateRecord,
    }),
    [
      capture,
      consumeDraft,
      discardDraft,
      activeDraftKey,
      editingLocked,
      flushActiveDraft,
      hasUnsavedActiveDraftNow,
      hasUnsavedDraftsNow,
      isCurrent,
      lockEditing,
      moveDraftToConversation,
      queryScope,
      records,
      registerActiveDraft,
      unlockEditing,
      updateRecord,
    ],
  );

  return <DraftMemoryContext.Provider value={value}>{children}</DraftMemoryContext.Provider>;
}

export function useDraftMemory(): DraftMemoryContextValue {
  const value = useContext(DraftMemoryContext);
  if (!value) {
    throw new Error("Draft memory must be used within its provider.");
  }
  return value;
}

export interface DraftEditorState {
  readonly acceptServer: () => void;
  readonly content: string;
  readonly conflict: DraftState | undefined;
  readonly confirmForSend: () => Promise<ConfirmedDraft | undefined>;
  readonly isLoading: boolean;
  readonly interactionLocked: boolean;
  readonly loadError: boolean;
  readonly replaceServer: () => void;
  readonly retryConflict: () => void;
  readonly retryLoad: () => void;
  readonly retrySave: () => void;
  readonly setContent: (content: string) => void;
  readonly status: DraftRecord["status"];
  readonly validationIssue: ContentValidationIssue | undefined;
}

export interface ConfirmedDraft {
  readonly content: string;
  readonly editVersion: number;
  readonly revision: number;
}

interface DraftRequestLifetime {
  active: boolean;
  readonly controllers: Set<AbortController>;
}

function beginDraftRequest(lifetime: DraftRequestLifetime): AbortController {
  const controller = new AbortController();
  lifetime.controllers.add(controller);
  return controller;
}

function endDraftRequest(lifetime: DraftRequestLifetime, controller: AbortController): void {
  lifetime.controllers.delete(controller);
}

function draftRequestIsCurrent(
  lifetime: DraftRequestLifetime,
  controller?: AbortController,
): boolean {
  return lifetime.active && !controller?.signal.aborted;
}

export function useServerDraft(scope: DraftScope): DraftEditorState {
  const key = draftScopeKey(scope);
  const memory = useDraftMemory();
  const queryScope = memory.queryScope;
  const generationCapture = memory.capture();
  const generationIsCurrent = memory.isCurrent;
  const registerActiveDraft = memory.registerActiveDraft;
  const updateMemoryRecord = memory.updateRecord;
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: conversationQueryKeys.draft(queryScope, scope),
    queryFn: ({ signal }) => fetchDraft(scope, signal),
    refetchOnWindowFocus: true,
  });
  const record = memory.records[key];
  const recordContent = record?.content;
  const validationIssue = useMemo(
    () => (recordContent === undefined ? undefined : draftContentValidationIssue(recordContent)),
    [recordContent],
  );
  const recordRef = useRef<DraftRecord | undefined>(record);
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  const inFlightTokenRef = useRef<object | null>(null);
  const saveRef = useRef<(force?: boolean) => Promise<boolean>>(async () => true);
  const lifetimeRef = useRef<DraftRequestLifetime | null>(null);
  if (!lifetimeRef.current) {
    lifetimeRef.current = { active: true, controllers: new Set() };
  }
  const lifetime = lifetimeRef.current;
  const requestIsCurrent = useCallback(
    (controller?: AbortController) =>
      draftRequestIsCurrent(lifetime, controller) && generationIsCurrent(generationCapture),
    [generationCapture, generationIsCurrent, lifetime],
  );

  recordRef.current = record;

  useEffect(() => {
    lifetime.active = !generationCapture.aborted;
    return () => {
      lifetime.active = false;
      for (const controller of lifetime.controllers) {
        controller.abort();
      }
      lifetime.controllers.clear();
      inFlightRef.current = null;
      inFlightTokenRef.current = null;
    };
  }, [generationCapture, lifetime]);

  const update = useCallback(
    (updater: (current: DraftRecord) => DraftRecord) => {
      if (!requestIsCurrent()) {
        return;
      }
      const current = recordRef.current;
      if (!current) {
        return;
      }
      const next = updater(current);
      recordRef.current = next;
      updateMemoryRecord(key, () => next);
    },
    [key, requestIsCurrent, updateMemoryRecord],
  );

  useEffect(() => {
    if (
      requestIsCurrent() &&
      query.data &&
      // A sent draft may replace the cache before an older render's synchronization effect runs.
      queryClient.getQueryData(conversationQueryKeys.draft(queryScope, scope)) === query.data
    ) {
      const synchronized = adoptRefreshedDraft(recordRef.current, query.data);
      if (synchronized !== recordRef.current) {
        recordRef.current = synchronized;
        updateMemoryRecord(key, () => synchronized);
      }
    }
  }, [key, query.data, queryClient, queryScope, requestIsCurrent, scope, updateMemoryRecord]);

  const performSave = useCallback(
    async (force = false): Promise<boolean> => {
      while (inFlightRef.current) {
        const priorSave = await inFlightRef.current;
        if (!requestIsCurrent() || !priorSave || !force) {
          return priorSave;
        }
      }

      if (!requestIsCurrent()) {
        return false;
      }
      const current = recordRef.current;
      if (!current?.dirty || current.blocked) {
        return !current?.dirty;
      }
      if (draftContentValidationIssue(current.content)) {
        return false;
      }
      if (!force && current.editVersion <= current.lastAttemptedVersion) {
        return false;
      }

      const submittedContent = current.content;
      const submittedVersion = current.editVersion;
      const submittedRevision = current.revision;
      update((value) => beginDraftSave(value, submittedVersion));

      const saveController = beginDraftRequest(lifetime);
      const requestToken = {};
      const request = (async () => {
        try {
          const saved = await saveDraft(
            scope,
            {
              content: submittedContent,
              observedRevision: submittedRevision,
            },
            AbortSignal.any([saveController.signal, generationCapture]),
          );
          if (
            !requestIsCurrent(saveController) ||
            recordRef.current?.revision !== submittedRevision
          ) {
            return false;
          }
          queryClient.setQueryData(conversationQueryKeys.draft(queryScope, scope), saved);
          if (saved.content !== submittedContent) {
            update((value) => markDraftConflict(value, saved));
            return false;
          }
          update((value) => completeDraftSave(value, saved, submittedContent, submittedVersion));
          return true;
        } catch (error) {
          if (
            !requestIsCurrent(saveController) ||
            recordRef.current?.revision !== submittedRevision
          ) {
            return false;
          }
          if (error instanceof ConversationApiError && error.code === "DRAFT_CHANGED") {
            const refetchController = beginDraftRequest(lifetime);
            try {
              const server = await fetchDraft(
                scope,
                AbortSignal.any([refetchController.signal, generationCapture]),
              );
              if (
                !requestIsCurrent(refetchController) ||
                recordRef.current?.revision !== submittedRevision
              ) {
                return false;
              }
              queryClient.setQueryData(conversationQueryKeys.draft(queryScope, scope), server);
              update((value) => markDraftConflict(value, server));
            } catch {
              if (requestIsCurrent(refetchController)) {
                update(blockDraftAfterConflict);
              }
            } finally {
              endDraftRequest(lifetime, refetchController);
            }
          } else {
            update(markDraftUnsaved);
          }
          return false;
        } finally {
          endDraftRequest(lifetime, saveController);
          if (inFlightTokenRef.current === requestToken) {
            inFlightRef.current = null;
            inFlightTokenRef.current = null;
          }
        }
      })();

      inFlightRef.current = request;
      inFlightTokenRef.current = requestToken;
      const saved = await request;
      if (!requestIsCurrent()) {
        return false;
      }
      const latest = recordRef.current;
      if (force && saved && latest?.dirty && !latest.blocked) {
        return performSave(true);
      }
      return saved && !recordRef.current?.dirty;
    },
    [generationCapture, lifetime, queryClient, queryScope, requestIsCurrent, scope, update],
  );

  saveRef.current = performSave;

  useEffect(
    () => registerActiveDraft(key, () => saveRef.current(true)),
    [key, registerActiveDraft],
  );

  useEffect(() => {
    if (
      !record?.dirty ||
      record.blocked ||
      validationIssue ||
      record.status === "saving" ||
      record.editVersion <= record.lastAttemptedVersion
    ) {
      return;
    }

    const timeout = window.setTimeout(() => void saveRef.current(), DRAFT_AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [record, validationIssue]);

  useEffect(() => {
    const retryWhenOnline = () => {
      if (
        recordRef.current?.dirty &&
        !recordRef.current.blocked &&
        !draftContentValidationIssue(recordRef.current.content)
      ) {
        void saveRef.current(true);
      }
    };
    window.addEventListener("online", retryWhenOnline);
    return () => window.removeEventListener("online", retryWhenOnline);
  }, []);

  const setContent = useCallback(
    (content: string) => update((current) => editDraft(current, content)),
    [update],
  );
  const acceptServer = useCallback(() => {
    const conflict = recordRef.current?.conflict;
    if (conflict) {
      queryClient.setQueryData(conversationQueryKeys.draft(queryScope, scope), conflict);
      update(acceptServerDraft);
    }
  }, [queryClient, queryScope, scope, update]);
  const replaceServer = useCallback(() => {
    if (!recordRef.current?.conflict) {
      return;
    }
    update(prepareDraftReplacement);
    void saveRef.current(true);
  }, [update]);
  const retryConflict = useCallback(() => {
    void (async () => {
      const refetchController = beginDraftRequest(lifetime);
      try {
        const server = await fetchDraft(
          scope,
          AbortSignal.any([refetchController.signal, generationCapture]),
        );
        if (!requestIsCurrent(refetchController)) {
          return;
        }
        queryClient.setQueryData(conversationQueryKeys.draft(queryScope, scope), server);
        update((value) => markDraftConflict(value, server));
      } catch {
        if (requestIsCurrent(refetchController)) {
          update(blockDraftAfterConflict);
        }
      } finally {
        endDraftRequest(lifetime, refetchController);
      }
    })();
  }, [generationCapture, lifetime, queryClient, queryScope, requestIsCurrent, scope, update]);
  const confirmForSend = useCallback(async (): Promise<ConfirmedDraft | undefined> => {
    const saved = await saveRef.current(true);
    if (!saved || !requestIsCurrent()) {
      return undefined;
    }
    const confirmed = recordRef.current;
    if (
      !confirmed ||
      confirmed.dirty ||
      confirmed.blocked ||
      draftContentValidationIssue(confirmed.content) ||
      confirmed.content.trim().length === 0
    ) {
      return undefined;
    }
    return {
      content: confirmed.content,
      editVersion: confirmed.editVersion,
      revision: confirmed.revision,
    };
  }, [requestIsCurrent]);

  return {
    acceptServer,
    confirmForSend,
    content: record?.content ?? "",
    conflict: record?.conflict,
    isLoading: query.isPending || !record,
    interactionLocked: memory.editingLocked,
    loadError: query.isError && !record,
    replaceServer,
    retryConflict,
    retryLoad: () => void query.refetch(),
    retrySave: () => void saveRef.current(true),
    setContent,
    status: record?.status ?? "saved",
    validationIssue,
  };
}
