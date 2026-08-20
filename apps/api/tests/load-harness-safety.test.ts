import { describe, expect, it } from "vitest";
import {
  BoundedNdjsonDecoder,
  diagnosticsAuthorization,
  hasMonotonicMemoryGrowth,
  maximumDurableUpdatePolls,
  parseLoadOptions,
  StreamLifecycleGuard,
} from "../src/load/harness-safety.js";

const confirmations = ["--confirm-isolated-database", "--confirm-non-production"];

describe("load harness safety", () => {
  it("requires an explicit isolated non-production target and bounded wave count", () => {
    expect(
      parseLoadOptions(["--target", "http://127.0.0.1:3015", "--waves", "5", ...confirmations]),
    ).toMatchObject({
      employees: 20,
      responseStartedP95ObjectiveMilliseconds: 500,
      waves: 5,
    });
    expect(
      parseLoadOptions([
        "--target",
        "http://127.0.0.1:3015",
        "--employees",
        "100",
        ...confirmations,
      ]),
    ).toMatchObject({ employees: 100 });
    expect(() => parseLoadOptions(["--target", "http://127.0.0.1:3015"])).toThrow(
      "--confirm-isolated-database",
    );
    expect(() =>
      parseLoadOptions(["--target", "https://chat.capstone.com.ec", ...confirmations]),
    ).toThrow("loopback HTTP origin");
    expect(() =>
      parseLoadOptions(["--target", "http://chat.capstone.com.ec", ...confirmations]),
    ).toThrow("loopback HTTP origin");
    expect(() =>
      parseLoadOptions(["--target", "https://chat.capstone.com.ec.", ...confirmations]),
    ).toThrow("loopback HTTP origin");
    expect(() =>
      parseLoadOptions(["--target", "http://user:secret@127.0.0.1:3015/path", ...confirmations]),
    ).toThrow("loopback HTTP origin");
    expect(() =>
      parseLoadOptions(["--target", "http://127.0.0.1:3015", "--waves", "6", ...confirmations]),
    ).toThrow("--waves");
    for (const employees of ["3", "101", "04", "4.5"]) {
      expect(() =>
        parseLoadOptions([
          "--target",
          "http://127.0.0.1:3015",
          "--employees",
          employees,
          ...confirmations,
        ]),
      ).toThrow("--employees");
    }
  });

  it("keeps diagnostics credentials on a confirmed loopback target", () => {
    const secret = "local-diagnostics-secret-with-at-least-32-characters";
    expect(diagnosticsAuthorization(secret)).toEqual({
      authorization: `Bearer ${secret}`,
    });
    expect(() => diagnosticsAuthorization("short")).toThrow("bounded secret");
    for (const target of ["https://staging.chat.capstone.com.ec", "https://evil.example"]) {
      expect(() => parseLoadOptions(["--target", target, ...confirmations])).toThrow(
        "loopback HTTP origin",
      );
    }
  });

  it("accepts only the allowlisted response-start p95 objectives", () => {
    expect(
      parseLoadOptions([
        "--target",
        "http://127.0.0.1:3015",
        "--response-start-p95-ms",
        "750",
        ...confirmations,
      ]),
    ).toMatchObject({ responseStartedP95ObjectiveMilliseconds: 750 });

    expect(() =>
      parseLoadOptions([
        "--target",
        "http://127.0.0.1:3015",
        "--response-start-p95-ms",
        ...confirmations,
      ]),
    ).toThrow("value is missing");
    for (const objective of [
      "",
      "0500",
      "0750",
      "500.0",
      "five-hundred",
      "0",
      "499",
      "501",
      "749",
      "751",
    ]) {
      expect(() =>
        parseLoadOptions([
          "--target",
          "http://127.0.0.1:3015",
          "--response-start-p95-ms",
          objective,
          ...confirmations,
        ]),
      ).toThrow("--response-start-p95-ms");
    }
  });

  it("parses fragmented lines and rejects oversized or incomplete NDJSON", () => {
    const decoder = new BoundedNdjsonDecoder(16);
    expect(decoder.push(new TextEncoder().encode('{"ok":'), false)).toEqual([]);
    expect(decoder.push(new TextEncoder().encode("true}\n"), false)).toEqual(['{"ok":true}']);
    expect(decoder.push(undefined, true)).toEqual([]);

    const oversized = new BoundedNdjsonDecoder(4);
    expect(() => oversized.push(new TextEncoder().encode("12345"), false)).toThrow(
      "maximum NDJSON line size",
    );

    const incomplete = new BoundedNdjsonDecoder(16);
    incomplete.push(new TextEncoder().encode("unfinished"), false);
    expect(() => incomplete.push(undefined, true)).toThrow("incomplete NDJSON line");

    const malformedUtf8 = new BoundedNdjsonDecoder(16);
    expect(() => malformedUtf8.push(new Uint8Array([0xc3, 0x28]), false)).toThrow();
  });

  it("rejects missing, duplicate, out-of-order, and post-terminal stream events", () => {
    const valid = new StreamLifecycleGuard();
    valid.accept("response.started");
    valid.accept("context.compacting");
    valid.accept("stream.heartbeat");
    valid.accept("context.compacted");
    valid.accept("content.delta");
    valid.accept("response.completed");
    expect(() => valid.finish()).not.toThrow();
    expect(() => valid.accept("content.delta")).toThrow("after its terminal");

    const missingStart = new StreamLifecycleGuard();
    expect(() => missingStart.accept("content.delta")).toThrow("did not begin");

    const duplicateStart = new StreamLifecycleGuard();
    duplicateStart.accept("response.started");
    expect(() => duplicateStart.accept("response.started")).toThrow("twice");

    const missingTerminal = new StreamLifecycleGuard();
    missingTerminal.accept("response.started");
    expect(() => missingTerminal.finish()).toThrow("required lifecycle events");

    const missingCompacting = new StreamLifecycleGuard();
    missingCompacting.accept("response.started");
    expect(() => missingCompacting.accept("context.compacted")).toThrow(
      "invalid compaction lifecycle",
    );

    const contentDuringCompaction = new StreamLifecycleGuard();
    contentDuringCompaction.accept("response.started");
    contentDuringCompaction.accept("context.compacting");
    expect(() => contentDuringCompaction.accept("content.delta")).toThrow(
      "before compaction settled",
    );

    const namingWithoutContent = new StreamLifecycleGuard();
    namingWithoutContent.accept("response.started");
    expect(() => namingWithoutContent.accept("conversation.naming")).toThrow(
      "invalid naming lifecycle",
    );

    const namingDuringCompaction = new StreamLifecycleGuard();
    namingDuringCompaction.accept("response.started");
    namingDuringCompaction.accept("context.compacting");
    expect(() => namingDuringCompaction.accept("conversation.naming")).toThrow(
      "invalid naming lifecycle",
    );

    const contentAfterNaming = new StreamLifecycleGuard();
    contentAfterNaming.accept("response.started");
    contentAfterNaming.accept("content.delta");
    contentAfterNaming.accept("conversation.naming");
    expect(() => contentAfterNaming.accept("content.delta")).toThrow("after naming began");
    expect(() => contentAfterNaming.accept("context.warning")).toThrow(
      "invalid compaction lifecycle",
    );

    const duplicateNaming = new StreamLifecycleGuard();
    duplicateNaming.accept("response.started");
    duplicateNaming.accept("content.delta");
    duplicateNaming.accept("conversation.naming");
    expect(() => duplicateNaming.accept("conversation.naming")).toThrow("invalid naming lifecycle");
  });

  it("detects a repeated post-idle heap or RSS increase", () => {
    expect(
      hasMonotonicMemoryGrowth([
        { heapUsedBytes: 100, rssBytes: 200 },
        { heapUsedBytes: 101, rssBytes: 199 },
        { heapUsedBytes: 102, rssBytes: 198 },
      ]),
    ).toBe(true);
    expect(
      hasMonotonicMemoryGrowth([
        { heapUsedBytes: 100, rssBytes: 200 },
        { heapUsedBytes: 102, rssBytes: 202 },
        { heapUsedBytes: 101, rssBytes: 201 },
      ]),
    ).toBe(false);
    expect(hasMonotonicMemoryGrowth([{ heapUsedBytes: 100, rssBytes: 200 }])).toBe(false);
  });

  it("bounds durable update requests by elapsed time at the configured cadence", () => {
    expect(maximumDurableUpdatePolls(0, 500)).toBe(2);
    expect(maximumDurableUpdatePolls(500, 500)).toBe(3);
    expect(maximumDurableUpdatePolls(501, 500)).toBe(4);
    expect(() => maximumDurableUpdatePolls(-1, 500)).toThrow("nonnegative");
    expect(() => maximumDurableUpdatePolls(1_000, 0)).toThrow("positive");
  });
});
