import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseManagedRehearsalInitializationDocument } from "../src/load/managed-rehearsal.js";
import { parseProductionInitializationDocument } from "../src/operator/initialization-document.js";
import { readBoundedStdinDocument } from "../src/operator/stdin-document.js";

function document(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    administrator: { email: "administrator@capstone.com.ec" },
    modelPolicy: {
      employeeActiveGenerationLimit: 2,
      maximumOutputTokens: { balanced: 8_192, fast: 4_096, pro: 16_384 },
      monthlyBudgetUsd: "100",
      reservationMarginBasisPoints: 2_000,
    },
    privacyAttestation: {
      attestationVersion: "openrouter-privacy-v1",
      broadcastEnabled: false,
      dataDiscountLoggingEnabled: false,
      inputOutputLoggingEnabled: false,
      verifiedAt: "2026-08-11T12:00:00.000Z",
    },
    schemaVersion: 1,
    workspace: { displayName: "Capstone", identity: "capstone" },
    ...overrides,
  });
}

describe("production initialization document", () => {
  it("normalizes one exact production contract into a stable content-free hash", () => {
    const compact = parseProductionInitializationDocument(document());
    const formatted = parseProductionInitializationDocument(
      JSON.stringify(JSON.parse(document()), null, 2),
    );

    expect(compact).toMatchObject({
      administratorEmail: "administrator@capstone.com.ec",
      employeeActiveGenerationLimit: 2,
      maximumOutputTokens: { balanced: 8_192, fast: 4_096, pro: 16_384 },
      monthlyBudgetUsd: "100",
      reservationMarginBasisPoints: 2_000,
      schemaVersion: 1,
      workspaceDisplayName: "Capstone",
      workspaceIdentity: "capstone",
    });
    expect(compact.documentSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(formatted.documentSha256).toBe(compact.documentSha256);
    expect(JSON.stringify(compact)).not.toContain("broadcastEnabled");
  });

  it("locks the managed rehearsal to its synthetic administrator", () => {
    expect(() => parseManagedRehearsalInitializationDocument(document())).toThrow(
      "fixed synthetic administrator",
    );
    expect(
      parseManagedRehearsalInitializationDocument(
        document({ administrator: { email: "administrator@rehearsal.test" } }),
      ).administratorEmail,
    ).toBe("administrator@rehearsal.test");
  });

  it.each([
    ["unknown root field", { unexpected: true }],
    ["wrong schema", { schemaVersion: 2 }],
    ["wrong workspace", { workspace: { displayName: "Capstone", identity: "other" } }],
    ["unnormalized email", { administrator: { email: "ADMIN@capstone.com.ec" } }],
    [
      "wrong budget",
      {
        modelPolicy: {
          employeeActiveGenerationLimit: 2,
          maximumOutputTokens: { balanced: 8_192, fast: 4_096, pro: 16_384 },
          monthlyBudgetUsd: "101",
          reservationMarginBasisPoints: 2_000,
        },
      },
    ],
  ])("rejects %s without echoing its value", (_label, overrides) => {
    expect(() => parseProductionInitializationDocument(document(overrides))).toThrow();
    try {
      parseProductionInitializationDocument(document(overrides));
    } catch (error: unknown) {
      expect(String(error)).not.toContain("administrator@capstone.com.ec");
    }
  });
});

describe("bounded operator standard input", () => {
  it("reads valid UTF-8 within the configured byte bound", async () => {
    await expect(readBoundedStdinDocument(Readable.from(["á", "b"]), 3)).resolves.toBe("áb");
  });

  it("rejects empty, oversized, and malformed UTF-8 input", async () => {
    await expect(readBoundedStdinDocument(Readable.from([]), 3)).rejects.toThrow("required");
    await expect(readBoundedStdinDocument(Readable.from(["abcd"]), 3)).rejects.toThrow(
      "byte limit",
    );
    await expect(
      readBoundedStdinDocument(Readable.from([Buffer.from([0xc3, 0x28])]), 3),
    ).rejects.toThrow("valid UTF-8");
  });
});
