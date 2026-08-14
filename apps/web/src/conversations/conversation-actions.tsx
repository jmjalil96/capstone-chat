import {
  type ConversationDetailResponse,
  type ConversationSummary,
  ConversationTitleSchema,
} from "@capstone/protocol";
import { type InfiniteData, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import Value from "typebox/value";

import { copy } from "../copy";
import {
  archiveConversation,
  ConversationApiError,
  conversationQueryKeys,
  deleteConversation,
  fetchConversation,
  renameConversation,
  unarchiveConversation,
} from "./api";
import { notifyCanonicalAdoption } from "./canonical-adoption";
import { useOptionalChatRuntime } from "./chat-runtime-provider";
import { adoptCanonicalConversationDetail } from "./conversation-detail";
import { useDraftMemory } from "./draft-memory";
import {
  type ConversationRequestCapture,
  useConversationRequestLifetime,
} from "./request-lifetime";

type ArchiveDirection = "archive" | "unarchive";

// A stale archive keeps its requested direction so a retry cannot flip into the
// opposite operation after canonical adoption changed isArchived underneath it.
type StaleAction =
  | "delete"
  | "rename"
  | { readonly kind: "archive"; readonly direction: ArchiveDirection };

interface RemoveCapture {
  readonly authSignal: AbortSignal;
  readonly conversation: ConversationSummary;
  readonly request: ConversationRequestCapture;
}

function openDialog(dialog: HTMLDialogElement | null): void {
  if (!dialog) {
    return;
  }
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
}

function closeDialog(dialog: HTMLDialogElement | null): void {
  if (!dialog) {
    return;
  }
  if (typeof dialog.close === "function") {
    dialog.close();
  } else {
    dialog.removeAttribute("open");
  }
}

function focusSoon(element: HTMLElement | null): void {
  queueMicrotask(() => element?.focus());
}

export function useConversationActions(conversation: ConversationSummary | undefined) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const chatRuntime = useOptionalChatRuntime();
  const draftMemory = useDraftMemory();
  const queryScope = draftMemory.queryScope;
  const conversationId = conversation?.id ?? "none";
  const requestLifetime = useConversationRequestLifetime(`actions:${conversationId}`);
  const id = useId();
  const disclosureId = `${id}-conversation-actions`;
  const renameDialogTitleId = `${id}-rename-title`;
  const renameInputId = `${id}-conversation-title`;
  const renameHelpId = `${id}-conversation-title-help`;
  const deleteDialogTitleId = `${id}-delete-title`;
  const renameDialogRef = useRef<HTMLDialogElement>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const renameCaptureRef = useRef<ConversationRequestCapture | undefined>(undefined);
  const archiveCaptureRef = useRef<ConversationRequestCapture | undefined>(undefined);
  const removeCaptureRef = useRef<RemoveCapture | undefined>(undefined);
  const staleActionRef = useRef<StaleAction | undefined>(undefined);
  // The rename dialog negotiates against the revision observed when it opened, so a
  // remote change mid-edit surfaces as a 409 instead of being silently overwritten.
  const renameObservedRevisionRef = useRef<ConversationSummary["revision"] | undefined>(undefined);
  const pendingTriggerFocusRef = useRef(false);
  const previousConversationIdRef = useRef(conversation?.id);
  // Mirrors disclosureOpen synchronously so unmount cleanups batched with a close
  // never read a stale open state from the last completed render.
  const disclosureOpenRef = useRef(false);
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const [title, setTitle] = useState(conversation?.title ?? "");
  const [dialogError, setDialogError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [canonicalRecoveryFailed, setCanonicalRecoveryFailed] = useState(false);
  const [canonicalRecoveryPending, setCanonicalRecoveryPending] = useState(false);
  const titleValid = Value.Check(ConversationTitleSchema, title);

  const restoreTriggerFocus = useCallback(() => {
    focusSoon(triggerRef.current?.isConnected ? triggerRef.current : null);
  }, []);

  const setDisclosureOpenState = useCallback((next: boolean) => {
    disclosureOpenRef.current = next;
    setDisclosureOpen(next);
  }, []);

  const registerTrigger = useCallback((trigger: HTMLButtonElement) => {
    triggerRef.current = trigger;
    if (pendingTriggerFocusRef.current) {
      pendingTriggerFocusRef.current = false;
      focusSoon(trigger);
    }
  }, []);

  const unregisterTrigger = useCallback(
    (trigger: HTMLButtonElement, handoffFocus: boolean) => {
      if (triggerRef.current === trigger) {
        triggerRef.current = null;
      }
      setDisclosureOpenState(false);
      if (!handoffFocus) {
        return;
      }
      pendingTriggerFocusRef.current = true;
      queueMicrotask(() => {
        const nextTrigger = triggerRef.current;
        if (pendingTriggerFocusRef.current && nextTrigger?.isConnected) {
          pendingTriggerFocusRef.current = false;
          nextTrigger.focus();
        }
      });
    },
    [setDisclosureOpenState],
  );

  const closeDisclosure = useCallback(
    (options: { readonly restoreFocus?: boolean } = {}) => {
      setDisclosureOpenState(false);
      if (options.restoreFocus ?? true) {
        restoreTriggerFocus();
      }
    },
    [restoreTriggerFocus, setDisclosureOpenState],
  );

  const adoptCanonical = useCallback(
    (canonical: ConversationSummary) => {
      let adopted = false;
      queryClient.setQueryData<InfiniteData<ConversationDetailResponse>>(
        conversationQueryKeys.detail(queryScope, canonical.id),
        (current) => {
          if (!current) {
            return current;
          }
          const currentRevision = current.pages[0]?.conversation.revision;
          if (currentRevision !== undefined && currentRevision > canonical.revision) {
            // A concurrent recovery already adopted newer state; never move back.
            return current;
          }
          adopted = true;
          return {
            ...current,
            pages: current.pages.map((page) => ({ ...page, conversation: canonical })),
          };
        },
      );
      if (adopted) {
        notifyCanonicalAdoption(canonical.id, "adopt");
      }
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: conversationQueryKeys.histories(queryScope) }),
        queryClient.invalidateQueries({ queryKey: conversationQueryKeys.searches(queryScope) }),
        queryClient.invalidateQueries({
          queryKey: conversationQueryKeys.responseStates(queryScope),
        }),
      ]);
      setCanonicalRecoveryFailed(false);
      setActionError(undefined);
      staleActionRef.current = undefined;
    },
    [queryClient, queryScope],
  );

  const recoverCanonical = useCallback(
    async (action: StaleAction) => {
      if (!conversation) {
        return;
      }
      const capture = requestLifetime.capture();
      staleActionRef.current = action;
      setCanonicalRecoveryPending(true);
      try {
        const canonical = await fetchConversation(conversation.id, undefined, capture.signal);
        if (!capture.isCurrent()) {
          return;
        }
        if (adoptCanonicalConversationDetail(queryClient, queryScope, canonical)) {
          if (action === "rename") {
            renameObservedRevisionRef.current = canonical.conversation.revision;
          }
          notifyCanonicalAdoption(conversation.id, "recover");
        }
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: conversationQueryKeys.histories(queryScope) }),
          queryClient.invalidateQueries({ queryKey: conversationQueryKeys.searches(queryScope) }),
          queryClient.invalidateQueries({
            queryKey: conversationQueryKeys.responseStates(queryScope),
          }),
        ]);
        if (!capture.isCurrent()) {
          return;
        }
        setCanonicalRecoveryFailed(false);
        setActionError(copy.conversations.common.changed);
        setDisclosureOpenState(true);
      } catch {
        if (!capture.isCurrent()) {
          return;
        }
        setCanonicalRecoveryFailed(true);
        setActionError(copy.conversations.common.genericError);
        setDisclosureOpenState(true);
      } finally {
        if (capture.isCurrent()) {
          setCanonicalRecoveryPending(false);
        }
        capture.release();
      }
    },
    [conversation, queryClient, queryScope, requestLifetime, setDisclosureOpenState],
  );

  const handleMutationFailure = useCallback(
    async (error: unknown, action: StaleAction, inDialog: boolean, isCurrent: () => boolean) => {
      if (!isCurrent()) {
        return;
      }
      if (error instanceof ConversationApiError && error.code === "CONVERSATION_CHANGED") {
        closeDialog(renameDialogRef.current);
        closeDialog(deleteDialogRef.current);
        restoreTriggerFocus();
        await recoverCanonical(action);
        return;
      }
      if (inDialog) {
        setDialogError(copy.conversations.common.genericError);
      } else {
        staleActionRef.current = action;
        setActionError(copy.conversations.common.genericError);
        setDisclosureOpenState(true);
      }
    },
    [recoverCanonical, restoreTriggerFocus, setDisclosureOpenState],
  );

  const rename = useMutation({
    mutationFn: () => {
      if (!conversation || !titleValid) {
        throw new Error("The conversation title is invalid.");
      }
      const capture = requestLifetime.capture();
      renameCaptureRef.current = capture;
      return renameConversation(
        conversation.id,
        {
          title,
          observedRevision: renameObservedRevisionRef.current ?? conversation.revision,
        },
        capture.signal,
      );
    },
    onSuccess: (canonical) => {
      const capture = renameCaptureRef.current;
      try {
        if (!capture?.isCurrent()) {
          return;
        }
        adoptCanonical(canonical);
        closeDialog(renameDialogRef.current);
        restoreTriggerFocus();
      } finally {
        capture?.release();
        if (renameCaptureRef.current === capture) {
          renameCaptureRef.current = undefined;
        }
      }
    },
    onError: async (error) => {
      const capture = renameCaptureRef.current;
      try {
        if (capture) {
          await handleMutationFailure(error, "rename", true, capture.isCurrent);
        }
      } finally {
        capture?.release();
        if (renameCaptureRef.current === capture) {
          renameCaptureRef.current = undefined;
        }
      }
    },
  });

  const archive = useMutation({
    mutationFn: (direction: ArchiveDirection) => {
      if (!conversation) {
        throw new Error("No current conversation is available.");
      }
      const capture = requestLifetime.capture();
      archiveCaptureRef.current = capture;
      return direction === "unarchive"
        ? unarchiveConversation(
            conversation.id,
            { observedRevision: conversation.revision },
            capture.signal,
          )
        : archiveConversation(
            conversation.id,
            { observedRevision: conversation.revision },
            capture.signal,
          );
    },
    onSuccess: (canonical) => {
      const capture = archiveCaptureRef.current;
      try {
        if (!capture?.isCurrent()) {
          return;
        }
        adoptCanonical(canonical);
        closeDisclosure();
      } finally {
        capture?.release();
        if (archiveCaptureRef.current === capture) {
          archiveCaptureRef.current = undefined;
        }
      }
    },
    onError: async (error, direction) => {
      const capture = archiveCaptureRef.current;
      try {
        if (capture) {
          await handleMutationFailure(
            error,
            { kind: "archive", direction },
            false,
            capture.isCurrent,
          );
        }
      } finally {
        capture?.release();
        if (archiveCaptureRef.current === capture) {
          archiveCaptureRef.current = undefined;
        }
      }
    },
  });

  const remove = useMutation({
    mutationFn: async () => {
      if (!conversation) {
        throw new Error("No current conversation is available.");
      }
      const authSignal = draftMemory.capture();
      const request = requestLifetime.capture();
      const capture = { authSignal, conversation, request } satisfies RemoveCapture;
      removeCaptureRef.current = capture;
      // Deletion intentionally removes this draft, but no earlier save may finish after discard.
      await draftMemory.flushActiveDraft();
      if (!draftMemory.isCurrent(authSignal) || !request.isCurrent()) {
        throw new Error("session-changed");
      }
      return deleteConversation(
        conversation.id,
        { observedRevision: conversation.revision },
        request.signal,
      );
    },
    onSuccess: async () => {
      const capture = removeCaptureRef.current;
      if (!capture) {
        return;
      }
      try {
        if (!draftMemory.isCurrent(capture.authSignal)) {
          return;
        }
        const returnToNewChat = capture.request.isCurrent();
        draftMemory.unlockEditing();
        if (returnToNewChat) {
          navigate("/", { replace: true, state: { focusComposer: true } });
        }
        chatRuntime?.discardConversation(capture.conversation.id);
        queryClient.removeQueries({
          queryKey: conversationQueryKeys.detail(queryScope, capture.conversation.id),
        });
        queryClient.removeQueries({
          queryKey: conversationQueryKeys.draft(queryScope, {
            kind: "conversation",
            conversationId: capture.conversation.id,
          }),
        });
        draftMemory.discardDraft({
          kind: "conversation",
          conversationId: capture.conversation.id,
        });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: conversationQueryKeys.histories(queryScope) }),
          queryClient.invalidateQueries({ queryKey: conversationQueryKeys.searches(queryScope) }),
        ]);
      } finally {
        capture.request.release();
        if (removeCaptureRef.current === capture) {
          removeCaptureRef.current = undefined;
        }
      }
    },
    onError: async (error) => {
      const capture = removeCaptureRef.current;
      if (!capture) {
        return;
      }
      try {
        if (!draftMemory.isCurrent(capture.authSignal)) {
          return;
        }
        draftMemory.unlockEditing();
        if (capture.request.isCurrent()) {
          await handleMutationFailure(error, "delete", true, capture.request.isCurrent);
        }
      } finally {
        capture.request.release();
        if (removeCaptureRef.current === capture) {
          removeCaptureRef.current = undefined;
        }
      }
    },
  });

  useEffect(() => {
    if (previousConversationIdRef.current === conversation?.id) {
      return;
    }
    previousConversationIdRef.current = conversation?.id;
    closeDialog(renameDialogRef.current);
    closeDialog(deleteDialogRef.current);
    setDisclosureOpenState(false);
    setActionError(undefined);
    setCanonicalRecoveryFailed(false);
    setCanonicalRecoveryPending(false);
    setDialogError(undefined);
    setTitle(conversation?.title ?? "");
    staleActionRef.current = undefined;
    renameObservedRevisionRef.current = undefined;
    pendingTriggerFocusRef.current = false;
  }, [conversation?.id, conversation?.title, setDisclosureOpenState]);

  useEffect(() => {
    if (staleActionRef.current !== "rename" && !renameDialogRef.current?.open) {
      setTitle(conversation?.title ?? "");
    }
  }, [conversation?.title]);

  useEffect(() => {
    if (disclosureOpen && actionError) {
      focusSoon(alertRef.current);
    }
  }, [actionError, disclosureOpen]);

  const openRenameDialog = useCallback(
    (preserveTitle = false) => {
      if (!conversation) {
        return;
      }
      setDialogError(undefined);
      renameObservedRevisionRef.current = conversation.revision;
      if (!preserveTitle) {
        setTitle(conversation.title ?? "");
      }
      closeDisclosure({ restoreFocus: false });
      openDialog(renameDialogRef.current);
    },
    [closeDisclosure, conversation],
  );

  const openDeleteDialog = useCallback(() => {
    if (!conversation) {
      return;
    }
    setDialogError(undefined);
    closeDisclosure({ restoreFocus: false });
    openDialog(deleteDialogRef.current);
  }, [closeDisclosure, conversation]);

  const closeRenameDialog = useCallback(() => {
    closeDialog(renameDialogRef.current);
    restoreTriggerFocus();
  }, [restoreTriggerFocus]);

  const closeDeleteDialog = useCallback(() => {
    closeDialog(deleteDialogRef.current);
    restoreTriggerFocus();
  }, [restoreTriggerFocus]);

  const retryAction = useCallback(async () => {
    const action = staleActionRef.current;
    if (!action) {
      return;
    }
    setActionError(undefined);
    if (canonicalRecoveryFailed) {
      await recoverCanonical(action);
      return;
    }
    if (action === "rename") {
      openRenameDialog(true);
      return;
    }
    if (action === "delete") {
      openDeleteDialog();
      return;
    }
    if (conversation?.isArchived === (action.direction === "archive")) {
      // The concurrent change already produced the requested state; replaying the
      // mutation here would reverse it.
      staleActionRef.current = undefined;
      closeDisclosure();
      return;
    }
    archive.mutate(action.direction);
  }, [
    archive,
    canonicalRecoveryFailed,
    closeDisclosure,
    conversation?.isArchived,
    openDeleteDialog,
    openRenameDialog,
    recoverCanonical,
  ]);

  return {
    actionError,
    alertRef,
    archive,
    canonicalRecoveryPending,
    closeDeleteDialog,
    closeDisclosure,
    closeRenameDialog,
    conversation,
    deleteDialogRef,
    deleteDialogTitleId,
    dialogError,
    disclosureId,
    disclosureOpen,
    disclosureOpenRef,
    isPending:
      archive.isPending || rename.isPending || remove.isPending || canonicalRecoveryPending,
    openDeleteDialog,
    openRenameDialog,
    remove,
    rename,
    renameDialogRef,
    renameDialogTitleId,
    renameHelpId,
    renameInputId,
    registerTrigger,
    restoreTriggerFocus,
    retryAction,
    setActionError,
    setDialogError,
    setDisclosureOpen: setDisclosureOpenState,
    setTitle,
    title,
    titleValid,
    toggleArchive: () => {
      if (conversation) {
        archive.mutate(conversation.isArchived ? "unarchive" : "archive");
      }
    },
    triggerRef,
    unregisterTrigger,
    beginDelete: () => {
      draftMemory.lockEditing();
      remove.mutate();
    },
  };
}

export type ConversationActionController = ReturnType<typeof useConversationActions>;
