import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { WORKSPACE_ASSISTANT_RULES_PRESET } from "../src/assistant-rules/defaults.js";
import { parseManagedRehearsalInitializationDocument } from "../src/load/managed-rehearsal.js";
import { INITIAL_TIER_BEHAVIOR_DEFAULTS } from "../src/model-policy/defaults.js";
import {
  assertLocalDevelopmentDatabaseUrl,
  createDevelopmentInitializationDocument,
  developmentAdministratorEmail,
} from "../src/operator/development-initialization.js";
import { parseProductionInitializationDocument } from "../src/operator/initialization-document.js";
import { readBoundedStdinDocument } from "../src/operator/stdin-document.js";

function document(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    administrator: { email: "administrator@capstone.com.ec" },
    assistantRules: { preset: WORKSPACE_ASSISTANT_RULES_PRESET },
    modelPolicy: {
      employeeActiveGenerationLimit: 2,
      maximumOutputTokens: { balanced: 8_192, fast: 4_096, pro: 16_384 },
      monthlyBudgetUsd: "100",
      reservationMarginBasisPoints: 2_000,
      tierBehavior: INITIAL_TIER_BEHAVIOR_DEFAULTS,
    },
    privacyAttestation: {
      attestationVersion: "openrouter-privacy-v1",
      broadcastEnabled: false,
      dataDiscountLoggingEnabled: false,
      inputOutputLoggingEnabled: false,
      verifiedAt: "2026-08-11T12:00:00.000Z",
    },
    schemaVersion: 2,
    workspace: { displayName: "Capstone", identity: "capstone" },
    ...overrides,
  });
}

describe("production initialization document", () => {
  it("creates the fixed local OpenRouter initialization contract from a privacy attestation", () => {
    const source = JSON.parse(document()) as {
      readonly privacyAttestation: Readonly<Record<string, unknown>>;
    };
    const development = createDevelopmentInitializationDocument(
      JSON.stringify(source.privacyAttestation),
    );

    expect(development).toMatchObject({
      administratorEmail: developmentAdministratorEmail,
      schemaVersion: 2,
      workspaceIdentity: "capstone",
    });
    expect(() =>
      assertLocalDevelopmentDatabaseUrl(
        "postgresql://capstone:capstone@127.0.0.1:5432/capstone_chat",
      ),
    ).not.toThrow();
    expect(() =>
      assertLocalDevelopmentDatabaseUrl(
        "postgresql://capstone:capstone@database.example/capstone_chat",
      ),
    ).toThrow("loopback");
  });

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
      schemaVersion: 2,
      tierBehavior: INITIAL_TIER_BEHAVIOR_DEFAULTS,
      workspaceAssistantRulesPreset: WORKSPACE_ASSISTANT_RULES_PRESET,
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
    ["wrong schema", { schemaVersion: 1 }],
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
          tierBehavior: INITIAL_TIER_BEHAVIOR_DEFAULTS,
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
