import { type PrivacyAttestationInput, verifyPrivacyAttestation } from "../model-policy/catalog.js";

type UnknownRecord = Readonly<Record<string, unknown>>;

function record(value: unknown, label: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be boolean`);
  }
  return value;
}

export function parsePrivacyAttestationDocument(value: unknown) {
  const source = record(value, "privacy attestation");
  const verifiedAtValue = stringValue(source.verifiedAt, "privacy attestation.verifiedAt");
  const verifiedAt = new Date(verifiedAtValue);
  if (!Number.isFinite(verifiedAt.getTime()) || verifiedAt.toISOString() !== verifiedAtValue) {
    throw new Error("privacy attestation.verifiedAt must be a canonical ISO timestamp");
  }
  const version = stringValue(source.attestationVersion, "privacy attestation.attestationVersion");
  if (version !== "openrouter-privacy-v1") {
    throw new Error("Privacy attestation version is unsupported");
  }
  const input: PrivacyAttestationInput = {
    attestationVersion: version,
    broadcastEnabled: booleanValue(source.broadcastEnabled, "privacy attestation.broadcastEnabled"),
    dataDiscountLoggingEnabled: booleanValue(
      source.dataDiscountLoggingEnabled,
      "privacy attestation.dataDiscountLoggingEnabled",
    ),
    inputOutputLoggingEnabled: booleanValue(
      source.inputOutputLoggingEnabled,
      "privacy attestation.inputOutputLoggingEnabled",
    ),
    verifiedAt,
  };
  return verifyPrivacyAttestation(input);
}
