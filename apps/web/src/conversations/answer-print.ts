import type { AnswerHandoffSnapshot } from "./answer-handoff";

const PRINT_CLEANUP_TIMEOUT_MS = 60_000;

export interface AnswerPrintEnvironment {
  readonly document: Document;
  readonly window: Window;
}

function createPrintElement(
  document: Document,
  snapshot: AnswerHandoffSnapshot,
  terminalLabel: string | undefined,
): HTMLElement {
  const root = document.createElement("section");
  root.className = "answer-print-root";
  const sheet = document.createElement("article");
  sheet.className = "answer-print-sheet";
  const brand = document.createElement("p");
  brand.className = "answer-print-brand";
  brand.textContent = "Capstone Chat";
  const label = document.createElement("p");
  label.className = "answer-print-label";
  label.textContent = "Respuesta";
  const content = document.createElement("div");
  content.className = "answer-print-content";
  content.append(snapshot.element.cloneNode(true));
  sheet.append(brand, label, content);
  if (terminalLabel) {
    const warning = document.createElement("p");
    warning.className = "answer-print-warning";
    warning.textContent = terminalLabel;
    sheet.append(warning);
  }
  root.append(sheet);
  return root;
}

export function startAnswerPrint(
  snapshot: AnswerHandoffSnapshot,
  terminalLabel: string | undefined,
  onFailure: () => void,
  environment: AnswerPrintEnvironment = {
    document: globalThis.document,
    window: globalThis.window,
  },
): () => void {
  const { document, window } = environment;
  document.querySelector(".answer-print-root")?.remove();
  const printRoot = createPrintElement(document, snapshot, terminalLabel);
  document.body.append(printRoot);
  document.body.dataset.answerPrinting = "";

  let cleaned = false;
  let printMediaEntered = false;
  let fallback: number | undefined;
  let frame: number | undefined;
  const media = typeof window.matchMedia === "function" ? window.matchMedia("print") : undefined;
  const cleanup = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    if (frame !== undefined) {
      window.cancelAnimationFrame(frame);
    }
    if (fallback !== undefined) {
      window.clearTimeout(fallback);
    }
    window.removeEventListener("afterprint", cleanup);
    media?.removeEventListener("change", handleMediaChange);
    printRoot.remove();
    delete document.body.dataset.answerPrinting;
  };
  const handleMediaChange = (event: MediaQueryListEvent) => {
    if (event.matches) {
      printMediaEntered = true;
    } else if (printMediaEntered) {
      cleanup();
    }
  };

  window.addEventListener("afterprint", cleanup, { once: true });
  media?.addEventListener("change", handleMediaChange);
  fallback = window.setTimeout(cleanup, PRINT_CLEANUP_TIMEOUT_MS);
  frame = window.requestAnimationFrame(() => {
    try {
      window.print();
    } catch {
      cleanup();
      onFailure();
    }
  });

  return cleanup;
}
