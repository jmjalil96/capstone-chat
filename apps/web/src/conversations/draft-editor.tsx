import type { DraftScope } from "@capstone/protocol";
import { useEffect, useRef } from "react";

import { copy } from "../copy";
import { useServerDraft } from "./draft-memory";

interface DraftEditorProps {
  readonly autoFocus?: boolean;
  readonly scope: DraftScope;
}

export function DraftEditor({ autoFocus = false, scope }: DraftEditorProps) {
  const draft = useServerDraft(scope);
  const conflictRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (draft.conflict) {
      conflictRef.current?.focus();
    }
  }, [draft.conflict]);

  useEffect(() => {
    if (autoFocus && !draft.isLoading) {
      textareaRef.current?.focus();
      textareaRef.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [autoFocus, draft.isLoading]);

  if (draft.loadError) {
    return (
      <div className="draft-load-error" role="alert">
        <p>{copy.conversations.common.genericError}</p>
        <button className="secondary-button compact-button" type="button" onClick={draft.retryLoad}>
          {copy.conversations.common.retry}
        </button>
      </div>
    );
  }

  return (
    <section className="draft-editor" aria-busy={draft.isLoading}>
      <label
        className="visually-hidden"
        htmlFor={`draft-${scope.kind === "new" ? "new" : scope.conversationId}`}
      >
        {copy.conversations.draft.label}
      </label>
      <textarea
        ref={textareaRef}
        id={`draft-${scope.kind === "new" ? "new" : scope.conversationId}`}
        value={draft.content}
        onChange={(event) => draft.setContent(event.currentTarget.value)}
        placeholder={copy.conversations.draft.placeholder}
        rows={4}
        disabled={draft.isLoading || draft.interactionLocked}
        aria-describedby="draft-save-status"
      />
      <div className="draft-status-row">
        <p id="draft-save-status" className="draft-save-status" role="status" aria-live="polite">
          {draft.isLoading
            ? copy.conversations.draft.loading
            : draft.status === "conflict"
              ? copy.conversations.draft.conflictTitle
              : copy.conversations.draft[draft.status]}
        </p>
        {draft.status === "unsaved" ? (
          <button
            className="text-button"
            type="button"
            disabled={draft.interactionLocked}
            onClick={draft.retrySave}
          >
            {copy.conversations.draft.retry}
          </button>
        ) : null}
      </div>
      {draft.status === "conflict" ? (
        <section
          className="draft-conflict"
          ref={conflictRef}
          role="alert"
          tabIndex={-1}
          aria-labelledby="draft-conflict-title"
        >
          <h2 id="draft-conflict-title">{copy.conversations.draft.conflictTitle}</h2>
          <p>
            {draft.conflict
              ? copy.conversations.draft.conflictDescription
              : copy.conversations.draft.conflictLoadError}
          </p>
          {draft.conflict ? (
            <div className="dialog-actions">
              <button
                className="secondary-button compact-button"
                type="button"
                disabled={draft.interactionLocked}
                onClick={draft.acceptServer}
              >
                {copy.conversations.draft.keepServer}
              </button>
              <button
                className="primary-button compact-button"
                type="button"
                disabled={draft.interactionLocked}
                onClick={draft.replaceServer}
              >
                {copy.conversations.draft.replaceServer}
              </button>
            </div>
          ) : (
            <button
              className="secondary-button compact-button"
              type="button"
              disabled={draft.interactionLocked}
              onClick={draft.retryConflict}
            >
              {copy.conversations.draft.loadServer}
            </button>
          )}
        </section>
      ) : null}
    </section>
  );
}
