const finalProductionOrigin = "https://chat.capstone.com.ec";
const finalProductionHostname = new URL(finalProductionOrigin).hostname;
const requiredFlags = new Set(["--confirm-isolated-database", "--confirm-non-production"]);

type StreamLifecycleType =
  | "content.delta"
  | "context.compacted"
  | "context.compacting"
  | "context.warning"
  | "response.cancelled"
  | "response.completed"
  | "response.failed"
  | "response.started";

function normalizedHostname(hostname: string): string {
  return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
}

export interface LoadOptions {
  readonly target: URL;
  readonly waves: number;
}

export interface PostIdleMemorySample {
  readonly heapUsedBytes: number;
  readonly rssBytes: number;
}

export function hasMonotonicMemoryGrowth(samples: readonly PostIdleMemorySample[]): boolean {
  if (samples.length < 3) {
    return false;
  }
  const heapGrew = samples
    .slice(1)
    .every(
      (sample, index) => sample.heapUsedBytes > (samples[index]?.heapUsedBytes ?? Number.MAX_VALUE),
    );
  const rssGrew = samples
    .slice(1)
    .every((sample, index) => sample.rssBytes > (samples[index]?.rssBytes ?? Number.MAX_VALUE));
  return heapGrew || rssGrew;
}

export function parseLoadOptions(argumentsList: readonly string[]): LoadOptions {
  const parsed = new Map<string, string | true>();
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === undefined || !argument.startsWith("--")) {
      throw new Error("Load arguments must use named --flags");
    }
    if (requiredFlags.has(argument)) {
      parsed.set(argument, true);
      continue;
    }
    if (argument !== "--target" && argument !== "--waves") {
      throw new Error("Unknown load argument");
    }
    const value = argumentsList[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("A load argument value is missing");
    }
    parsed.set(argument, value);
    index += 1;
  }

  for (const flag of requiredFlags) {
    if (parsed.get(flag) !== true) {
      throw new Error(`The load harness requires ${flag}`);
    }
  }
  const rawTarget = parsed.get("--target");
  if (typeof rawTarget !== "string") {
    throw new Error("The load harness requires --target");
  }
  const target = new URL(rawTarget);
  if (
    (target.protocol !== "http:" && target.protocol !== "https:") ||
    target.username !== "" ||
    target.password !== "" ||
    target.pathname !== "/" ||
    target.search !== "" ||
    target.hash !== "" ||
    normalizedHostname(target.hostname) === finalProductionHostname
  ) {
    throw new Error(
      "The load target must be a non-production HTTP origin without credentials or a path",
    );
  }
  const rawWaves = parsed.get("--waves") ?? "3";
  if (typeof rawWaves !== "string" || !/^[1-5]$/u.test(rawWaves)) {
    throw new Error("--waves must be an integer from 1 to 5");
  }
  return { target, waves: Number(rawWaves) };
}

export class BoundedNdjsonDecoder {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #encoder = new TextEncoder();
  #buffer = "";

  constructor(readonly maximumLineBytes: number) {
    if (!Number.isSafeInteger(maximumLineBytes) || maximumLineBytes <= 0) {
      throw new Error("The NDJSON line limit must be a positive safe integer");
    }
  }

  push(chunk: Uint8Array | undefined, done: boolean): readonly string[] {
    this.#buffer += this.#decoder.decode(chunk, { stream: !done });
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    if (this.#encoder.encode(this.#buffer).byteLength > this.maximumLineBytes) {
      throw new Error("A synthetic stream exceeded the maximum NDJSON line size");
    }
    const complete = lines.filter((line) => line.length > 0);
    if (complete.some((line) => this.#encoder.encode(line).byteLength > this.maximumLineBytes)) {
      throw new Error("A synthetic stream exceeded the maximum NDJSON line size");
    }
    if (done && this.#buffer.length !== 0) {
      throw new Error("A synthetic stream ended with an incomplete NDJSON line");
    }
    return complete;
  }
}

export class StreamLifecycleGuard {
  #compaction: "compacting" | "none" | "settled" = "none";
  #contentSeen = false;
  #started = false;
  #terminal = false;

  accept(type: StreamLifecycleType): void {
    if (this.#terminal) {
      throw new Error("A synthetic stream emitted data after its terminal event");
    }
    if (!this.#started) {
      if (type !== "response.started") {
        throw new Error("A synthetic stream did not begin with response.started");
      }
      this.#started = true;
      return;
    }
    if (type === "response.started") {
      throw new Error("A synthetic stream emitted response.started twice");
    }
    if (type === "context.compacting") {
      if (this.#compaction !== "none" || this.#contentSeen) {
        throw new Error("A synthetic stream emitted an invalid compaction lifecycle");
      }
      this.#compaction = "compacting";
    } else if (type === "context.compacted") {
      if (this.#compaction !== "compacting") {
        throw new Error("A synthetic stream emitted an invalid compaction lifecycle");
      }
      this.#compaction = "settled";
    } else if (type === "context.warning") {
      if (this.#compaction === "settled" || this.#contentSeen) {
        throw new Error("A synthetic stream emitted an invalid compaction lifecycle");
      }
      this.#compaction = "settled";
    } else if (type === "content.delta") {
      if (this.#compaction === "compacting") {
        throw new Error("A synthetic stream emitted content before compaction settled");
      }
      this.#contentSeen = true;
    }
    if (
      type === "response.cancelled" ||
      type === "response.completed" ||
      type === "response.failed"
    ) {
      if (this.#compaction === "compacting" && type === "response.completed") {
        throw new Error("A synthetic stream completed before compaction settled");
      }
      this.#terminal = true;
    }
  }

  finish(): void {
    if (!this.#started || !this.#terminal) {
      throw new Error("A synthetic stream ended without its required lifecycle events");
    }
  }
}
