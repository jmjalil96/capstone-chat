import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { copy } from "../copy";
import { AnswerHandoffActions, TableCopyAction } from "./answer-handoff-actions";
import { MessageContent } from "./message-content";

interface CapturedClipboardItem {
  readonly items: Record<string, Blob>;
}

class TestClipboardItem {
  static captured: CapturedClipboardItem[] = [];

  static supports(type: string): boolean {
    return type === "text/html" || type === "text/plain";
  }

  readonly items: Record<string, Blob>;

  constructor(items: Record<string, Blob>) {
    this.items = items;
    TestClipboardItem.captured.push(this);
  }
}

function installClipboard({ rejectRich = false }: { readonly rejectRich?: boolean } = {}) {
  const writeText = vi.fn(async () => undefined);
  const write = vi.fn(async () => {
    if (rejectRich) {
      throw new DOMException("Clipboard denied", "NotAllowedError");
    }
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { write, writeText },
  });
  Object.defineProperty(globalThis, "ClipboardItem", {
    configurable: true,
    value: TestClipboardItem,
  });
  return { write, writeText };
}

function AnswerHarness({
  rendered = true,
  source,
}: {
  readonly rendered?: boolean;
  readonly source: string;
}) {
  const contentRootRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={contentRootRef}>
        {rendered ? (
          <MessageContent
            fallback="No disponible"
            renderTableAction={(tableRef) => <TableCopyAction tableRef={tableRef} />}
            source={source}
          />
        ) : null}
      </div>
      <div className="message-actions">
        <AnswerHandoffActions contentRootRef={contentRootRef} source={source} />
      </div>
    </>
  );
}

afterEach(() => {
  cleanup();
  TestClipboardItem.captured = [];
  vi.restoreAllMocks();
});

describe("answer handoff actions", () => {
  it("copies one safe semantic HTML and readable text item", async () => {
    const user = userEvent.setup();
    const { write, writeText } = installClipboard();
    render(
      <AnswerHarness
        source={`# Resultado

Texto con **énfasis** y [fuente](https://example.com/informe).

| Campo | Valor |
| --- | --- |
| Total | 42 |`}
      />,
    );

    await user.click(screen.getByRole("button", { name: copy.conversations.messages.copyAnswer }));

    expect(write).toHaveBeenCalledOnce();
    expect(writeText).not.toHaveBeenCalled();
    const item = TestClipboardItem.captured[0];
    await expect(item?.items["text/html"]?.text()).resolves.toContain("<h1>Resultado</h1>");
    await expect(item?.items["text/html"]?.text()).resolves.toContain("<strong>énfasis</strong>");
    await expect(item?.items["text/html"]?.text()).resolves.not.toMatch(
      /class=|target=|data-message/u,
    );
    await expect(item?.items["text/plain"]?.text()).resolves.toBe(
      [
        "Resultado",
        "Texto con énfasis y fuente (https://example.com/informe).",
        "Campo\tValor\nTotal\t42",
      ].join("\n\n"),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(copy.conversations.messages.copied);
  });

  it("falls back to readable plain text only when rich capability is absent", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: undefined,
    });
    render(<AnswerHarness source={"# Resultado\n\nTexto **legible**."} />);

    await user.click(screen.getByRole("button", { name: copy.conversations.messages.copyAnswer }));

    expect(writeText).toHaveBeenCalledWith("Resultado\n\nTexto legible.");
    expect(await screen.findByRole("status")).toHaveTextContent(
      copy.conversations.messages.copiedPlain,
    );
  });

  it("does not retry as plain text after a supported rich write is rejected", async () => {
    const user = userEvent.setup();
    const { write, writeText } = installClipboard({ rejectRich: true });
    render(<AnswerHarness source="Respuesta privada" />);

    await user.click(screen.getByRole("button", { name: copy.conversations.messages.copyAnswer }));

    expect(write).toHaveBeenCalledOnce();
    expect(writeText).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      copy.conversations.messages.copyFormattedFailed,
    );
  });

  it("keeps exact Markdown as an explicit export option and restores trigger focus", async () => {
    const user = userEvent.setup();
    const { writeText } = installClipboard();
    const source = "  # Exacto\r\n\r\nTexto `original`  ";
    render(<AnswerHarness source={source} />);
    const exportButton = screen.getByRole("button", {
      name: copy.conversations.messages.export,
    });

    await user.click(exportButton);
    await user.click(
      screen.getByRole("button", { name: copy.conversations.messages.copyMarkdown }),
    );

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(source);
    expect(await screen.findByRole("status")).toHaveTextContent(
      copy.conversations.messages.markdownCopied,
    );
    expect(exportButton).toHaveFocus();
    expect(
      screen.queryByRole("button", { name: copy.conversations.messages.downloadText }),
    ).not.toBeInTheDocument();
  });

  it("uses exact Markdown as the recovery path if rendered output is unavailable", async () => {
    const user = userEvent.setup();
    const { writeText } = installClipboard();
    const source = "Respuesta `exacta`";
    render(<AnswerHarness rendered={false} source={source} />);

    await user.click(screen.getByRole("button", { name: copy.conversations.messages.copyAnswer }));

    expect(writeText).toHaveBeenCalledWith(source);
    expect(await screen.findByRole("status")).toHaveTextContent(
      copy.conversations.messages.markdownCopied,
    );
  });

  it("copies each table as formula-safe TSV without changing code copy", async () => {
    const user = userEvent.setup();
    const { writeText } = installClipboard();
    render(
      <AnswerHarness
        source={`| Nombre | Valor |
| --- | --- |
| Fórmula | =SUM(A1:A2) |`}
      />,
    );

    await user.click(screen.getByRole("button", { name: copy.conversations.messages.copyTable }));

    expect(writeText).toHaveBeenCalledWith("Nombre\tValor\nFórmula\t'=SUM(A1:A2)");
    expect(await screen.findByRole("status")).toHaveTextContent(
      copy.conversations.messages.tableCopied,
    );
  });
});
