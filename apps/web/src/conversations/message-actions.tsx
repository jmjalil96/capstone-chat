import type { AlternativeContext, ConversationMessage } from "@capstone/protocol";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";

import { copy } from "../copy";
import { writeClipboardText } from "./clipboard";
import { userMessageContentValidationIssue } from "./content-validation";

type CopyState = "idle" | "pending" | "success" | "failure";

interface CopyActionProps {
  readonly label: string;
  readonly source: string;
}

function CopyAction({ label, source }: CopyActionProps) {
  const [state, setState] = useState<CopyState>("idle");

  const copySource = async () => {
    if (state === "pending") {
      return;
    }
    setState("pending");
    try {
      await writeClipboardText(source);
      setState("success");
    } catch {
      setState("failure");
    }
  };

  return (
    <span className="copy-action">
      <button
        className="text-button message-action"
        type="button"
        aria-disabled={state === "pending"}
        onClick={() => void copySource()}
      >
        {state === "pending"
          ? copy.conversations.messages.copying
          : state === "success"
            ? copy.conversations.messages.copied
            : label}
      </button>
      {state === "success" ? (
        <span className="visually-hidden" role="status">
          {copy.conversations.messages.copied}
        </span>
      ) : null}
      {state === "failure" ? (
        <span className="message-action-error" role="alert">
          {copy.conversations.messages.copyFailed}
        </span>
      ) : null}
    </span>
  );
}

export function CodeCopyAction({ source }: { readonly source: string }) {
  return <CopyAction label={copy.conversations.messages.copyCode} source={source} />;
}

interface MessageActionsProps {
  readonly alternative: AlternativeContext | undefined;
  readonly canCopy: boolean;
  readonly canContinue: boolean;
  readonly canEdit: boolean;
  readonly canRetry: boolean;
  readonly canUndo: boolean;
  readonly children: ReactNode;
  readonly message: ConversationMessage;
  readonly pending: boolean;
  readonly onEdit: (content: string, onCommitted: () => void) => Promise<void>;
  readonly onContinue: () => void;
  readonly onRetry: () => void;
  readonly onSelectAlternative: (
    selectionTargetMessageId: string,
    trigger: HTMLButtonElement,
  ) => void;
  readonly onUndo: (trigger: HTMLButtonElement) => void;
}

export function MessageActions({
  alternative,
  canCopy,
  canContinue,
  canEdit,
  canRetry,
  canUndo,
  children,
  message,
  pending,
  onEdit,
  onContinue,
  onRetry,
  onSelectAlternative,
  onUndo,
}: MessageActionsProps) {
  const originalSource = message.content[0]?.text ?? "";
  const editorId = useId();
  const editorValidationId = `${editorId}-validation`;
  const committedRef = useRef(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const restoreEditFocusRef = useRef(false);
  const [editing, setEditing] = useState(false);
  const [editSource, setEditSource] = useState(originalSource);
  const [editError, setEditError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const normalizedEdit = editSource.replace(/\r\n?/gu, "\n");
  const normalizedOriginal = originalSource.replace(/\r\n?/gu, "\n");
  const validationIssue = userMessageContentValidationIssue(editSource);
  const unchanged = normalizedEdit === normalizedOriginal;
  const empty = editSource.trim().length === 0;

  const closeEditor = () => {
    committedRef.current = true;
    restoreEditFocusRef.current = false;
    setSaving(false);
    setEditError(undefined);
    setEditing(false);
  };

  const saveEdit = async () => {
    if (saving || pending || !canEdit || validationIssue || empty || unchanged) {
      return;
    }
    committedRef.current = false;
    setSaving(true);
    setEditError(undefined);
    try {
      await onEdit(normalizedEdit, closeEditor);
      if (!committedRef.current) {
        closeEditor();
      }
    } catch {
      if (!committedRef.current) {
        setEditError(copy.conversations.messages.editFailed);
        setSaving(false);
      }
    }
  };

  const cancelEdit = () => {
    restoreEditFocusRef.current = true;
    setEditSource(originalSource);
    setEditError(undefined);
    setEditing(false);
  };

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      cancelEdit();
    }
  };

  useEffect(() => {
    if (editing) {
      editorRef.current?.focus();
      return;
    }
    if (restoreEditFocusRef.current) {
      restoreEditFocusRef.current = false;
      editButtonRef.current?.focus();
    }
  }, [editing]);

  if (editing) {
    const validationMessage = validationIssue
      ? validationIssue === "too-large"
        ? copy.conversations.messages.oversizedEdit
        : copy.conversations.messages.invalidEdit
      : unchanged
        ? copy.conversations.messages.unchangedEdit
        : undefined;
    const editorInvalid = validationMessage !== undefined;
    return (
      <div className="message-inline-edit">
        <label htmlFor={editorId}>{copy.conversations.messages.editLabel}</label>
        <textarea
          ref={editorRef}
          id={editorId}
          value={editSource}
          aria-describedby={editorInvalid ? editorValidationId : undefined}
          aria-invalid={editorInvalid}
          disabled={saving}
          onChange={(event) => {
            setEditSource(event.currentTarget.value);
            setEditError(undefined);
          }}
          onKeyDown={handleEditorKeyDown}
        />
        {validationMessage ? (
          <p className="field-error" id={editorValidationId}>
            {validationMessage}
          </p>
        ) : null}
        {editError ? (
          <p className="inline-alert" role="alert">
            {editError}
          </p>
        ) : null}
        <div className="message-inline-edit-actions">
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={
              saving || pending || !canEdit || Boolean(validationIssue) || empty || unchanged
            }
            onClick={() => void saveEdit()}
          >
            {saving ? copy.conversations.messages.savingEdit : copy.conversations.messages.saveEdit}
          </button>
          <button className="text-button" type="button" disabled={saving} onClick={cancelEdit}>
            {copy.conversations.messages.cancelEdit}
          </button>
        </div>
      </div>
    );
  }

  const hasActions = canCopy || canEdit || canRetry || canContinue || canUndo || alternative;

  return (
    <>
      {children}
      {hasActions ? (
        <fieldset className="message-actions">
          <legend className="visually-hidden">{copy.conversations.messages.actions}</legend>
          {canCopy ? (
            <CopyAction
              label={
                message.role === "user"
                  ? copy.conversations.messages.copyUser
                  : copy.conversations.messages.copyAnswer
              }
              source={originalSource}
            />
          ) : null}
          {message.role === "user" && canEdit ? (
            <button
              ref={editButtonRef}
              className="text-button message-action"
              type="button"
              disabled={pending}
              onClick={() => {
                setEditSource(originalSource);
                setEditError(undefined);
                setEditing(true);
              }}
            >
              {copy.conversations.messages.edit}
            </button>
          ) : null}
          {message.role === "assistant" && canRetry ? (
            <button
              className="text-button message-action"
              type="button"
              disabled={pending}
              onClick={onRetry}
            >
              {copy.conversations.messages.tryAgain}
            </button>
          ) : null}
          {message.role === "assistant" && canContinue ? (
            <button
              className="text-button message-action"
              type="button"
              disabled={pending}
              onClick={onContinue}
            >
              {copy.conversations.generation.actions.continue}
            </button>
          ) : null}
          {canUndo ? (
            <button
              className="text-button message-action"
              type="button"
              data-structural-focus-key={`${message.id}:undo`}
              disabled={pending}
              onClick={(event) => onUndo(event.currentTarget)}
            >
              {copy.conversations.messages.undo}
            </button>
          ) : null}
          {alternative ? (
            <span className="message-alternative-controls">
              <button
                className="text-button message-action"
                type="button"
                aria-label={copy.conversations.messages.previousAlternative}
                data-structural-focus-key={`${message.id}:previous`}
                disabled={pending || alternative.previousLeafMessageId === null}
                onClick={(event) => {
                  if (alternative.previousLeafMessageId) {
                    onSelectAlternative(alternative.previousLeafMessageId, event.currentTarget);
                  }
                }}
              >
                ←
              </button>
              <span>
                <span aria-hidden="true">
                  {alternative.position} / {alternative.total}
                </span>
                <span className="visually-hidden">
                  {copy.conversations.messages.alternativePosition(
                    alternative.position,
                    alternative.total,
                  )}
                </span>
              </span>
              <button
                className="text-button message-action"
                type="button"
                aria-label={copy.conversations.messages.nextAlternative}
                data-structural-focus-key={`${message.id}:next`}
                disabled={pending || alternative.nextLeafMessageId === null}
                onClick={(event) => {
                  if (alternative.nextLeafMessageId) {
                    onSelectAlternative(alternative.nextLeafMessageId, event.currentTarget);
                  }
                }}
              >
                →
              </button>
            </span>
          ) : null}
        </fieldset>
      ) : null}
    </>
  );
}
