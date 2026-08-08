import { describe, expect, it, vi } from "vitest";

import { writeClipboardText } from "./clipboard";

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
