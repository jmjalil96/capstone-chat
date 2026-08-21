export interface ClipboardWriter {
  writeText(value: string): Promise<void>;
}

export interface RichClipboardWriter extends ClipboardWriter {
  write?(items: ClipboardItem[]): Promise<void>;
}

export interface ClipboardItemConstructor {
  readonly supports?: (type: string) => boolean;
  new (items: Record<string, Blob>): ClipboardItem;
}

export type RichClipboardResult = "plain" | "rich";

export async function writeClipboardText(
  source: string,
  writer: ClipboardWriter | null | undefined = globalThis.navigator?.clipboard,
): Promise<void> {
  if (!writer) {
    throw new Error("Clipboard API unavailable");
  }

  await writer.writeText(source);
}

export async function writeRichClipboard(
  html: string,
  text: string,
  writer: RichClipboardWriter | null | undefined = globalThis.navigator?.clipboard,
  ClipboardItemClass: ClipboardItemConstructor | undefined = globalThis.ClipboardItem,
): Promise<RichClipboardResult> {
  if (!writer) {
    throw new Error("Clipboard API unavailable");
  }

  if (
    writer.write === undefined ||
    ClipboardItemClass === undefined ||
    (ClipboardItemClass.supports !== undefined &&
      (!ClipboardItemClass.supports("text/html") || !ClipboardItemClass.supports("text/plain")))
  ) {
    await writer.writeText(text);
    return "plain";
  }

  const item = new ClipboardItemClass({
    "text/html": new Blob([html], { type: "text/html" }),
    "text/plain": new Blob([text], { type: "text/plain" }),
  });
  await writer.write([item]);
  return "rich";
}
