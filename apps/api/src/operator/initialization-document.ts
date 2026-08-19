import { createHash } from "node:crypto";
import { normalizeApprovalEmail } from "../identity/email-normalization.js";
import type { VerifiedPrivacyAttestation } from "../model-policy/catalog.js";
import { canonicalUsd } from "../model-policy/money.js";
import { parsePrivacyAttestationDocument } from "./model-policy-input.js";

type UnknownRecord = Readonly<Record<string, unknown>>;

export interface ProductionInitializationDocument {
  readonly administratorEmail: string;
  readonly documentSha256: string;
  readonly employeeActiveGenerationLimit: 2;
  readonly maximumOutputTokens: Readonly<{
    readonly balanced: 8_192;
    readonly fast: 4_096;
    readonly pro: 16_384;
  }>;
  readonly monthlyBudgetUsd: "100";
  readonly privacyAttestation: VerifiedPrivacyAttestation;
  readonly reservationMarginBasisPoints: 2_000;
  readonly schemaVersion: 1;
  readonly workspaceDisplayName: "Capstone";
  readonly workspaceIdentity: "capstone";
}

function record(value: unknown, label: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contains unsupported fields`);
  }
}

function exactInteger(value: unknown, expected: number, label: string): number {
  if (value !== expected) {
    throw new Error(`${label} must use the approved production value`);
  }
  return expected;
}

function exactString(value: unknown, expected: string, label: string): string {
  if (value !== expected) {
    throw new Error(`${label} must use the approved production value`);
  }
  return expected;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function parseProductionInitializationDocument(
  contents: string,
): ProductionInitializationDocument {
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    throw new Error("Production initialization document must be valid JSON");
  }

  const root = record(value, "production initialization document");
  exactKeys(
    root,
    ["administrator", "modelPolicy", "privacyAttestation", "schemaVersion", "workspace"],
    "production initialization document",
  );

  exactInteger(root.schemaVersion, 1, "schemaVersion");

  const workspace = record(root.workspace, "workspace");
  exactKeys(workspace, ["displayName", "identity"], "workspace");
  exactString(workspace.identity, "capstone", "workspace.identity");
  exactString(workspace.displayName, "Capstone", "workspace.displayName");

  const administrator = record(root.administrator, "administrator");
  exactKeys(administrator, ["email"], "administrator");
  const administratorEmail = stringValue(administrator.email, "administrator.email");
  const normalizedEmail = normalizeApprovalEmail(administratorEmail);
  if (administratorEmail !== normalizedEmail) {
    throw new Error("administrator.email must be normalized lowercase email");
  }

  const modelPolicy = record(root.modelPolicy, "modelPolicy");
  exactKeys(
    modelPolicy,
    [
      "employeeActiveGenerationLimit",
      "maximumOutputTokens",
      "monthlyBudgetUsd",
      "reservationMarginBasisPoints",
    ],
    "modelPolicy",
  );
  const monthlyBudgetUsd = canonicalUsd(
    stringValue(modelPolicy.monthlyBudgetUsd, "modelPolicy.monthlyBudgetUsd"),
    "modelPolicy.monthlyBudgetUsd",
  );
  exactString(monthlyBudgetUsd, "100", "modelPolicy.monthlyBudgetUsd");
  exactInteger(
    modelPolicy.employeeActiveGenerationLimit,
    2,
    "modelPolicy.employeeActiveGenerationLimit",
  );
  exactInteger(
    modelPolicy.reservationMarginBasisPoints,
    2_000,
    "modelPolicy.reservationMarginBasisPoints",
  );
  const limits = record(modelPolicy.maximumOutputTokens, "modelPolicy.maximumOutputTokens");
  exactKeys(limits, ["balanced", "fast", "pro"], "modelPolicy.maximumOutputTokens");
  exactInteger(limits.fast, 4_096, "modelPolicy.maximumOutputTokens.fast");
  exactInteger(limits.balanced, 8_192, "modelPolicy.maximumOutputTokens.balanced");
  exactInteger(limits.pro, 16_384, "modelPolicy.maximumOutputTokens.pro");

  const privacySource = record(root.privacyAttestation, "privacyAttestation");
  exactKeys(
    privacySource,
    [
      "attestationVersion",
      "broadcastEnabled",
      "dataDiscountLoggingEnabled",
      "inputOutputLoggingEnabled",
      "verifiedAt",
    ],
    "privacyAttestation",
  );
  const privacyAttestation = parsePrivacyAttestationDocument(privacySource);
  const verifiedAt = privacyAttestation.verifiedAt.toISOString();

  const canonical = JSON.stringify({
    administrator: { email: normalizedEmail },
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
      verifiedAt,
    },
    schemaVersion: 1,
    workspace: { displayName: "Capstone", identity: "capstone" },
  });

  return Object.freeze({
    administratorEmail: normalizedEmail,
    documentSha256: createHash("sha256").update(canonical, "utf8").digest("hex"),
    employeeActiveGenerationLimit: 2,
    maximumOutputTokens: Object.freeze({ balanced: 8_192, fast: 4_096, pro: 16_384 }),
    monthlyBudgetUsd: "100",
    privacyAttestation,
    reservationMarginBasisPoints: 2_000,
    schemaVersion: 1,
    workspaceDisplayName: "Capstone",
    workspaceIdentity: "capstone",
  });
}
