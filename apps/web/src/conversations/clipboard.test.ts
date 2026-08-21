import { describe, expect, it, vi } from "vitest";

import { type ClipboardItemConstructor, writeClipboardText, writeRichClipboard } from "./clipboard";

class TestClipboardItem {
  static supports(type: string): boolean {
    return type === "text/html" || type === "text/plain";
  }

  constructor(readonly items: Record<string, Blob>) {}
}

const TestClipboardItemClass = TestClipboardItem as unknown as ClipboardItemConstructor;

describe("writeClipboardText", () => {
  it("writes the exact provided source once", async () => {
    const writeText = vi.fn(async () => undefined);
    const source = "  línea uno\n\n\t🙂\r\n";

    await writeClipboardText(source, { writeText });

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(source);
  });

  it("propagates clipboard rejection without another write path", async () => {
    const failure = new Error("permission denied");
    const writeText = vi.fn(async () => {
      throw failure;
    });

    await expect(writeClipboardText("contenido", { writeText })).rejects.toBe(failure);
    expect(writeText).toHaveBeenCalledOnce();
  });

  it("fails with content-free metadata when the Clipboard API is unavailable", async () => {
    await expect(writeClipboardText("contenido sensible", null)).rejects.toThrow(
      "Clipboard API unavailable",
    );
  });
});

describe("writeRichClipboard", () => {
  it("writes safe HTML and readable text in one clipboard item", async () => {
    const writeText = vi.fn(async () => undefined);
    const write = vi.fn(async (_items: ClipboardItem[]) => undefined);

    await expect(
      writeRichClipboard(
        "<p><strong>Resultado</strong></p>",
        "Resultado",
        { write, writeText },
        TestClipboardItemClass,
      ),
    ).resolves.toBe("rich");

    expect(writeText).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledOnce();
    const item = write.mock.calls[0]?.[0][0] as unknown as TestClipboardItem;
    expect(Object.keys(item.items)).toEqual(["text/html", "text/plain"]);
    await expect(item.items["text/html"]?.text()).resolves.toBe(
      "<p><strong>Resultado</strong></p>",
    );
    await expect(item.items["text/plain"]?.text()).resolves.toBe("Resultado");
  });

  it("uses readable plain text when rich clipboard capability is absent", async () => {
    const writeText = vi.fn(async () => undefined);

    await expect(
      writeRichClipboard("<p>Resultado</p>", "Resultado legible", { writeText }, undefined),
    ).resolves.toBe("plain");

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith("Resultado legible");
  });

  it("does not make a second write when a supported rich write is rejected", async () => {
    const failure = new Error("permission denied");
    const writeText = vi.fn(async () => undefined);
    const write = vi.fn(async (_items: ClipboardItem[]) => {
      throw failure;
    });

    await expect(
      writeRichClipboard(
        "<p>Resultado</p>",
        "Resultado",
        { write, writeText },
        TestClipboardItemClass,
      ),
    ).rejects.toBe(failure);
    expect(write).toHaveBeenCalledOnce();
    expect(writeText).not.toHaveBeenCalled();
  });
});
