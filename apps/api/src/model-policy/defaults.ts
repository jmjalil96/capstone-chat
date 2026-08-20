import type {
  AdminReasoningBudgetTokens,
  AdminReasoningEffort,
  AdminTemperaturePreset,
} from "@capstone/protocol";
import type { ModelTier } from "./catalog.js";

export interface TierBehaviorDefaults {
  readonly reasoningBudgetTokens: AdminReasoningBudgetTokens;
  readonly reasoningEffort: AdminReasoningEffort;
  readonly temperaturePreset: AdminTemperaturePreset;
}

export const INITIAL_TIER_BEHAVIOR_DEFAULTS: Readonly<Record<ModelTier, TierBehaviorDefaults>> =
  Object.freeze({
    fast: Object.freeze({
      reasoningBudgetTokens: 0,
      reasoningEffort: "off",
      temperaturePreset: "precise",
    }),
    balanced: Object.freeze({
      reasoningBudgetTokens: 0,
      reasoningEffort: "off",
      temperaturePreset: "balanced",
    }),
    pro: Object.freeze({
      reasoningBudgetTokens: 8_192,
      reasoningEffort: "high",
      temperaturePreset: "balanced",
    }),
  });

export const TEMPERATURE_PRESET_VALUES = Object.freeze({
  precise: 0.2,
  balanced: 0.4,
  flexible: 0.6,
  creative: 0.8,
} as const);
