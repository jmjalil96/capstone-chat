import { type RefObject, useEffect, useId, useRef, useState } from "react";

import { copy } from "../copy";
import { startTextDownload } from "./answer-download";
import { answerTableToTsv, createAnswerHandoffSnapshot } from "./answer-handoff";
import { startAnswerPrint } from "./answer-print";
import { writeClipboardText, writeRichClipboard } from "./clipboard";
import { useDisclosureDismissal } from "./use-disclosure-dismissal";

type PrimaryCopyState = "idle" | "markdown" | "pending" | "plain" | "rich";
type TableCopyState = "failure" | "idle" | "pending" | "success";

interface HandoffFeedback {
  readonly kind: "error" | "status";
  readonly message: string;
}

interface AnswerHandoffActionsProps {
  readonly contentRootRef: RefObject<HTMLDivElement | null>;
  readonly source: string;
  readonly terminalLabel?: string;
}

function renderedAnswerRoot(
  contentRootRef: RefObject<HTMLDivElement | null>,
): HTMLElement | undefined {
  return contentRootRef.current?.querySelector<HTMLElement>("[data-message-content]") ?? undefined;
}

export function AnswerHandoffActions({
  contentRootRef,
  source,
  terminalLabel,
}: AnswerHandoffActionsProps) {
  const disclosureId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const printCleanupRef = useRef<(() => void) | undefined>(undefined);
  const previousSourceRef = useRef(source);
  const [open, setOpen] = useState(false);
  const [primaryState, setPrimaryState] = useState<PrimaryCopyState>("idle");
  const [exportPending, setExportPending] = useState(false);
  const [feedback, setFeedback] = useState<HandoffFeedback>();

  const closeDisclosure = ({ restoreFocus }: { readonly restoreFocus: boolean }) => {
    setOpen(false);
    if (restoreFocus) {
      triggerRef.current?.focus({ preventScroll: true });
    }
  };

  useDisclosureDismissal({
    close: closeDisclosure,
    containerRef,
    open,
    triggerRef,
  });

  useEffect(() => {
    if (previousSourceRef.current === source) {
      return;
    }
    previousSourceRef.current = source;
    setOpen(false);
    setPrimaryState("idle");
    setExportPending(false);
    setFeedback(undefined);
  }, [source]);

  useEffect(
    () => () => {
      printCleanupRef.current?.();
    },
    [],
  );

  const copyAnswer = async () => {
    if (primaryState === "pending") {
      return;
    }
    setPrimaryState("pending");
    setFeedback(undefined);
    try {
      const renderedRoot = renderedAnswerRoot(contentRootRef);
      if (!renderedRoot) {
        await writeClipboardText(source);
        setPrimaryState("markdown");
        setFeedback({ kind: "status", message: copy.conversations.messages.markdownCopied });
        return;
      }
      const snapshot = createAnswerHandoffSnapshot(renderedRoot);
      const result = await writeRichClipboard(snapshot.html, snapshot.text);
      setPrimaryState(result);
      setFeedback({
        kind: "status",
        message:
          result === "rich"
            ? copy.conversations.messages.copied
            : copy.conversations.messages.copiedPlain,
      });
    } catch {
      setPrimaryState("idle");
      setFeedback({ kind: "error", message: copy.conversations.messages.copyFormattedFailed });
    }
  };

  const finishExport = (message: string) => {
    setExportPending(false);
    setFeedback({ kind: "status", message });
    closeDisclosure({ restoreFocus: true });
  };

  const failExport = (message: string) => {
    setExportPending(false);
    setFeedback({ kind: "error", message });
  };

  const copyMarkdown = async () => {
    if (exportPending) {
      return;
    }
    setExportPending(true);
    setFeedback(undefined);
    try {
      await writeClipboardText(source);
      finishExport(copy.conversations.messages.markdownCopied);
    } catch {
      failExport(copy.conversations.messages.copyFailed);
    }
  };

  const downloadMarkdown = () => {
    if (exportPending) {
      return;
    }
    setFeedback(undefined);
    try {
      startTextDownload(source, "respuesta-capstone-chat.md", "text/markdown;charset=utf-8");
      finishExport(copy.conversations.messages.downloadStarted);
    } catch {
      failExport(copy.conversations.messages.downloadFailed);
    }
  };

  const downloadText = () => {
    if (exportPending) {
      return;
    }
    setFeedback(undefined);
    try {
      const renderedRoot = renderedAnswerRoot(contentRootRef);
      if (!renderedRoot) {
        throw new Error("Rendered answer unavailable");
      }
      const snapshot = createAnswerHandoffSnapshot(renderedRoot);
      startTextDownload(snapshot.text, "respuesta-capstone-chat.txt", "text/plain;charset=utf-8");
      finishExport(copy.conversations.messages.downloadStarted);
    } catch {
      failExport(copy.conversations.messages.downloadFailed);
    }
  };

  const printAnswer = () => {
    if (exportPending) {
      return;
    }
    setFeedback(undefined);
    try {
      const renderedRoot = renderedAnswerRoot(contentRootRef);
      if (!renderedRoot) {
        throw new Error("Rendered answer unavailable");
      }
      const snapshot = createAnswerHandoffSnapshot(renderedRoot);
      printCleanupRef.current?.();
      printCleanupRef.current = startAnswerPrint(snapshot, terminalLabel, () => {
        setFeedback({ kind: "error", message: copy.conversations.messages.printFailed });
      });
      closeDisclosure({ restoreFocus: true });
    } catch {
      failExport(copy.conversations.messages.printFailed);
    }
  };

  const primaryLabel =
    primaryState === "pending"
      ? copy.conversations.messages.copying
      : primaryState === "plain"
        ? copy.conversations.messages.copiedPlain
        : primaryState === "markdown"
          ? copy.conversations.messages.markdownCopied
          : primaryState === "rich"
            ? copy.conversations.messages.copied
            : copy.conversations.messages.copyAnswer;

  return (
    <>
      <button
        className="text-button message-action"
        type="button"
        aria-disabled={primaryState === "pending"}
        onClick={() => void copyAnswer()}
      >
        {primaryLabel}
      </button>
      <div className="answer-export-disclosure" ref={containerRef}>
        <button
          ref={triggerRef}
          aria-controls={disclosureId}
          aria-expanded={open}
          className="text-button message-action answer-export-trigger"
          type="button"
          onClick={() => setOpen((value) => !value)}
        >
          {copy.conversations.messages.export}
        </button>
        {open ? (
          <div className="answer-export-panel" id={disclosureId}>
            <button
              className="answer-export-option"
              type="button"
              aria-disabled={exportPending}
              onClick={() => void copyMarkdown()}
            >
              {copy.conversations.messages.copyMarkdown}
            </button>
            <button
              className="answer-export-option"
              type="button"
              aria-disabled={exportPending}
              onClick={downloadMarkdown}
            >
              {copy.conversations.messages.downloadMarkdown}
            </button>
            <button
              className="answer-export-option"
              type="button"
              aria-disabled={exportPending}
              onClick={downloadText}
            >
              {copy.conversations.messages.downloadText}
            </button>
            <button
              className="answer-export-option"
              type="button"
              aria-disabled={exportPending}
              onClick={printAnswer}
            >
              {copy.conversations.messages.printAnswer}
            </button>
          </div>
        ) : null}
      </div>
      {feedback ? (
        <span
          className="answer-handoff-feedback"
          role={feedback.kind === "error" ? "alert" : "status"}
        >
          {feedback.message}
        </span>
      ) : null}
    </>
  );
}

export function TableCopyAction({
  tableRef,
}: {
  readonly tableRef: RefObject<HTMLTableElement | null>;
}) {
  const [state, setState] = useState<TableCopyState>("idle");

  const copyTable = async () => {
    if (state === "pending") {
      return;
    }
    const table = tableRef.current;
    if (!table) {
      setState("failure");
      return;
    }
    setState("pending");
    try {
      await writeClipboardText(answerTableToTsv(table));
      setState("success");
    } catch {
      setState("failure");
    }
  };

  return (
    <span className="copy-action table-copy-action">
      <button
        className="text-button message-action"
        type="button"
        aria-disabled={state === "pending"}
        onClick={() => void copyTable()}
      >
        {state === "pending"
          ? copy.conversations.messages.copying
          : state === "success"
            ? copy.conversations.messages.tableCopied
            : copy.conversations.messages.copyTable}
      </button>
      {state === "success" ? (
        <span className="visually-hidden" role="status">
          {copy.conversations.messages.tableCopied}
        </span>
      ) : null}
      {state === "failure" ? (
        <span className="message-action-error" role="alert">
          {copy.conversations.messages.copyTableFailed}
        </span>
      ) : null}
    </span>
  );
}
