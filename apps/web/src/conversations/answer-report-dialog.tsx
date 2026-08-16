import {
  ANSWER_REPORT_NOTE_MAX_CODE_POINTS,
  type AnswerReportReason,
  AnswerReportReasonSchema,
  type CreateAnswerReportRequest,
} from "@capstone/protocol";
import { type FormEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { copy } from "../copy";
import { ConversationApiError } from "./api";

export const answerReportReasons = AnswerReportReasonSchema.anyOf.map(
  (schema) => schema.const,
) as readonly AnswerReportReason[];

export interface AnswerReportTarget {
  readonly messageId: string;
  /** Element that opened the dialog; focus returns to it when the dialog closes. */
  readonly trigger: HTMLElement | null;
}

interface AnswerReportDialogProps {
  readonly onClose: () => void;
  readonly onSubmit: (
    messageId: string,
    input: CreateAnswerReportRequest,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly onSubmitted: (messageId: string) => void;
  readonly target: AnswerReportTarget | undefined;
}

function noteIssue(value: string): string | undefined {
  if (!value.isWellFormed()) {
    return copy.conversations.report.noteInvalid;
  }
  const normalized = value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0) {
    return undefined;
  }
  for (const character of normalized) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a) ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    ) {
      return copy.conversations.report.noteInvalid;
    }
  }
  return [...normalized].length > ANSWER_REPORT_NOTE_MAX_CODE_POINTS
    ? copy.conversations.report.noteInvalid
    : undefined;
}

/**
 * Accessible modal that collects a required reason and an optional note, states the exact
 * consent disclosure, and confirms with "Compartir y enviar". Reporting state is independent of
 * copy, retry, branch, draft, and generation controls.
 */
export function AnswerReportDialog({
  onClose,
  onSubmit,
  onSubmitted,
  target,
}: AnswerReportDialogProps) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const firstReasonRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const closingRef = useRef(false);
  const [reason, setReason] = useState<AnswerReportReason>();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const noteValidation = noteIssue(note);
  const open = target !== undefined;

  useLayoutEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      abortRef.current = undefined;
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (open) {
      closingRef.current = false;
      setReason(undefined);
      setNote("");
      setError(undefined);
      setSubmitting(false);
      if (typeof dialog.showModal === "function") {
        if (!dialog.open) {
          dialog.showModal();
        }
      } else {
        dialog.setAttribute("open", "");
      }
      queueMicrotask(() => firstReasonRef.current?.focus());
      return;
    }
    if (dialog.open) {
      if (typeof dialog.close === "function") {
        dialog.close();
      } else {
        dialog.removeAttribute("open");
      }
    }
  }, [open]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const close = () => {
    if (closingRef.current) {
      return;
    }
    closingRef.current = true;
    abortRef.current?.abort();
    const trigger = target?.trigger;
    const dialog = dialogRef.current;
    if (dialog?.open) {
      if (typeof dialog.close === "function") {
        dialog.close();
      } else {
        dialog.removeAttribute("open");
      }
    }
    onClose();
    queueMicrotask(() => {
      if (trigger?.isConnected) {
        trigger.focus();
      }
    });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!target || submitting) {
      return;
    }
    if (!reason) {
      setError(copy.conversations.report.reasonRequired);
      return;
    }
    if (noteValidation) {
      setError(noteValidation);
      return;
    }
    const trimmed = note.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
    const controller = new AbortController();
    abortRef.current = controller;
    setSubmitting(true);
    setError(undefined);
    try {
      await onSubmit(
        target.messageId,
        {
          reason,
          ...(trimmed.length > 0 ? { note: trimmed } : {}),
          sharePromptAndAnswer: true,
        },
        controller.signal,
      );
      if (controller.signal.aborted) {
        return;
      }
      setSubmitting(false);
      onSubmitted(target.messageId);
      close();
    } catch (caught) {
      if (controller.signal.aborted) {
        return;
      }
      setSubmitting(false);
      if (
        caught instanceof ConversationApiError &&
        (caught.status === 404 || caught.status === 400)
      ) {
        setError(copy.conversations.report.unavailable);
        return;
      }
      setError(copy.conversations.report.failed);
    }
  };

  return (
    <dialog
      className="action-dialog answer-report-dialog"
      ref={dialogRef}
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault();
        if (!submitting) {
          close();
        }
      }}
      onClose={() => {
        if (open && !closingRef.current) {
          close();
        }
      }}
    >
      <form method="dialog" onSubmit={(event) => void submit(event)}>
        <h2 id={`${id}-title`}>{copy.conversations.report.title}</h2>
        <fieldset className="answer-report-reasons" disabled={submitting}>
          <legend>{copy.conversations.report.reasonLabel}</legend>
          {answerReportReasons.map((candidate, index) => (
            <label key={candidate} className="answer-report-reason">
              <input
                ref={index === 0 ? firstReasonRef : undefined}
                type="radio"
                name={`${id}-reason`}
                value={candidate}
                checked={reason === candidate}
                onChange={() => {
                  setReason(candidate);
                  setError(undefined);
                }}
              />
              <span>{copy.conversations.report.reasons[candidate]}</span>
            </label>
          ))}
        </fieldset>
        <label htmlFor={`${id}-note`}>{copy.conversations.report.noteLabel}</label>
        <textarea
          id={`${id}-note`}
          value={note}
          rows={3}
          disabled={submitting}
          aria-invalid={noteValidation !== undefined}
          aria-describedby={`${id}-note-help`}
          onChange={(event) => {
            setNote(event.currentTarget.value);
            setError(undefined);
          }}
        />
        <p className={noteValidation ? "field-error" : "field-help"} id={`${id}-note-help`}>
          {noteValidation ?? copy.conversations.report.noteHelp}
        </p>
        <p className="answer-report-disclosure">{copy.conversations.report.disclosure}</p>
        {error ? (
          <p className="inline-alert" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={submitting}
            onClick={close}
          >
            {copy.conversations.report.cancel}
          </button>
          <button
            className="primary-button compact-button"
            type="submit"
            disabled={submitting || noteValidation !== undefined}
          >
            {submitting ? copy.conversations.report.submitting : copy.conversations.report.submit}
          </button>
        </div>
      </form>
    </dialog>
  );
}
