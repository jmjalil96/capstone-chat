import { WORKSPACE_ASSISTANT_RULES_PRESET } from "../assistant-rules/defaults.js";
import { INITIAL_TIER_BEHAVIOR_DEFAULTS } from "../model-policy/defaults.js";
import {
  type ProductionInitializationDocument,
  parseProductionInitializationDocument,
} from "./initialization-document.js";

export const developmentAdministratorEmail = "admin@example.test";

export function assertLocalDevelopmentDatabaseUrl(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("Development initialization requires PostgreSQL");
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") {
    throw new Error("Development initialization requires a loopback PostgreSQL database");
  }
}

export function createDevelopmentInitializationDocument(
  privacyAttestationContents: string,
): ProductionInitializationDocument {
  let privacyAttestation: unknown;
  try {
    privacyAttestation = JSON.parse(privacyAttestationContents) as unknown;
  } catch {
    throw new Error("Local OpenRouter privacy attestation must be valid JSON");
  }

  return parseProductionInitializationDocument(
    JSON.stringify({
      administrator: { email: developmentAdministratorEmail },
      assistantRules: { preset: WORKSPACE_ASSISTANT_RULES_PRESET },
      modelPolicy: {
        employeeActiveGenerationLimit: 2,
        maximumOutputTokens: { balanced: 8_192, fast: 4_096, pro: 16_384 },
        monthlyBudgetUsd: "100",
        reservationMarginBasisPoints: 2_000,
        tierBehavior: INITIAL_TIER_BEHAVIOR_DEFAULTS,
      },
      privacyAttestation,
      schemaVersion: 2,
      workspace: { displayName: "Capstone", identity: "capstone" },
    }),
  );
}
