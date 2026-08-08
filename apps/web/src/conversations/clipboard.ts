export interface ClipboardWriter {
  writeText(value: string): Promise<void>;
}

export async function writeClipboardText(
  source: string,
  writer: ClipboardWriter | null | undefined = globalThis.navigator?.clipboard,
): Promise<void> {
  if (!writer) {
    throw new Error("Clipboard API unavailable");
  }

  await writer.writeText(source);
}
