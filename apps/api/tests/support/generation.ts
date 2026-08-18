import type { GenerationModelTier } from "@capstone/protocol";
import {
  createSystemPromptSnapshot,
  type SystemPromptSnapshot,
} from "../../src/assistant-rules/prompt.js";
import type { CatalogModelCapability } from "../../src/model-policy/catalog.js";
import type {
  EffectiveModelParameters,
  GenerationPurpose,
} from "../../src/model-policy/effective-parameters.js";
import { resolveEffectiveModelParameters } from "../../src/model-policy/effective-parameters.js";

export const testCatalogCapability: CatalogModelCapability = Object.freeze({
  reasoning: Object.freeze({
    contractSource: "test",
    defaultEffort: null,
    defaultEnabled: null,
    effortSupport: Object.freeze({ kind: "none" }),
    exclusionVerifiedAt: new Date("2026-08-17T12:00:00.000Z"),
    kind: "optional",
    maxTokensAccepted: false,
    traceSafety: "provider_excluded",
  }),
  temperatureSupported: false,
});

export const testPromptSnapshot: SystemPromptSnapshot = createSystemPromptSnapshot(1, "");

export function testEffectiveParameters(
  purpose: GenerationPurpose = "chat",
  tier: GenerationModelTier = purpose === "chat" ? "balanced" : "fast",
): EffectiveModelParameters {
  return resolveEffectiveModelParameters({
    capability: testCatalogCapability,
    maximumOutputTokens: 4_096,
    purpose,
    reasoningBudgetTokens: 1_024,
    reasoningEffort: "high",
    temperaturePreset: "balanced",
    tier,
  });
}
