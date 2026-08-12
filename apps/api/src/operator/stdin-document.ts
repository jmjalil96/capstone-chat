import type { Readable } from "node:stream";
import { TextDecoder } from "node:util";

export const maximumOperatorDocumentBytes = 32 * 1_024;

export async function readBoundedStdinDocument(
  input: Readable = process.stdin,
  maximumBytes = maximumOperatorDocumentBytes,
): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("Operator document byte limit is invalid");
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of input) {
      const buffer = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk));
      bytes += buffer.byteLength;
      if (bytes > maximumBytes) {
        buffer.fill(0);
        throw new Error("Operator document exceeds the supported byte limit");
      }
      chunks.push(buffer);
    }

    if (bytes === 0) {
      throw new Error("Operator document is required on standard input");
    }

    const contents = Buffer.concat(chunks, bytes);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(contents);
    } catch {
      throw new Error("Operator document must be valid UTF-8");
    } finally {
      contents.fill(0);
    }
  } finally {
    for (const chunk of chunks) {
      chunk.fill(0);
    }
  }
}
