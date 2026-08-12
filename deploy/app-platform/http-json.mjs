import { TextDecoder } from "node:util";

const MAXIMUM_JSON_BYTES = 2 * 1024 * 1024;

export async function boundedJson(response, label, maximumBytes = MAXIMUM_JSON_BYTES) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${label} response exceeded its reviewed bound`);
  }
  if (response.body === null) {
    throw new Error(`${label} returned invalid JSON`);
  }
  const chunks = [];
  let length = 0;
  const reader = response.body.getReader();
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      length += value.byteLength;
      if (length > maximumBytes) {
        throw new Error(`${label} response exceeded its reviewed bound`);
      }
      chunks.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(chunks, length);
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return JSON.parse(text);
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError) {
        throw new Error(`${label} returned invalid JSON`);
      }
      throw error;
    } finally {
      bytes.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}
