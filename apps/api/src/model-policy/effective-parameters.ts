import type {
  AdminParameterSupportKind,
  AdminReasoningBudgetTokens,
  AdminReasoningEffort,
  AdminTemperaturePreset,
} from "@capstone/protocol";
import type { CatalogModelCapability, GatewayEffort, ModelTier } from "./catalog.js";
import { gatewayEfforts } from "./catalog.js";
import { TEMPERATURE_PRESET_VALUES } from "./defaults.js";

export type GenerationPurpose = "chat" | "compaction" | "title";
export type EffectiveParameterReason =
  | "supported"
  | "temperature_unsupported"
  | "non_reasoning_model"
  | "reasoning_disabled"
  | "mandatory_reasoning"
  | "max_tokens_precision_unverified"
  | "effort_nearest_supported"
  | "effort_control_unavailable"
  | "budget_control_unavailable"
  | "provider_default_strength"
  | "hidden_compaction_default"
  | "hidden_title_disabled"
  | "capability_unverified";

export interface EffectiveParameterStatus {
  readonly kind: AdminParameterSupportKind;
  readonly reason: EffectiveParameterReason;
}

export interface EffectiveReasoningWire {
  readonly enabled?: false;
  readonly effort?: GatewayEffort;
  readonly exclude: true;
  readonly maxTokens?: number;
}

export interface EffectiveModelParameters {
  readonly configured: Readonly<{
    reasoningBudgetTokens: AdminReasoningBudgetTokens;
    reasoningEffort: AdminReasoningEffort;
    temperaturePreset: AdminTemperaturePreset;
  }>;
  readonly budgetStatus: EffectiveParameterStatus;
  readonly effortStatus: EffectiveParameterStatus;
  readonly purpose: GenerationPurpose;
  readonly reasoning: EffectiveReasoningWire | null;
  readonly temperature: number | null;
  readonly temperatureStatus: EffectiveParameterStatus;
  readonly tier: ModelTier;
  readonly traceExcluded: boolean;
}

export interface ResolveEffectiveParametersInput {
  readonly capability: CatalogModelCapability;
  readonly maximumOutputTokens: number;
  readonly purpose: GenerationPurpose;
  readonly reasoningBudgetTokens: AdminReasoningBudgetTokens;
  readonly reasoningEffort: AdminReasoningEffort;
  readonly temperaturePreset: AdminTemperaturePreset;
  readonly tier: ModelTier;
}

const effortRatios: Readonly<Record<GatewayEffort, number>> = Object.freeze({
  none: 0,
  minimal: 0.1,
  low: 0.2,
  medium: 0.5,
  high: 0.8,
  xhigh: 0.95,
  max: 0.95,
});

function status(
  kind: AdminParameterSupportKind,
  reason: EffectiveParameterReason,
): EffectiveParameterStatus {
  return Object.freeze({ kind, reason });
}

function supportedEfforts(capability: CatalogModelCapability): readonly GatewayEffort[] {
  const support = capability.reasoning.effortSupport;
  if (support.kind === "none") {
    return Object.freeze([]);
  }
  return support.kind === "all" ? gatewayEfforts : support.values;
}

function configuredGatewayEffort(effort: AdminReasoningEffort): GatewayEffort {
  if (effort === "off") {
    return "none";
  }
  return effort;
}

function nearestEffort(
  configured: Exclude<AdminReasoningEffort, "off">,
  supported: readonly GatewayEffort[],
): GatewayEffort | null {
  const positive = supported.filter((effort) => effort !== "none");
  const configuredRatio = effortRatios[configured];
  return (
    positive.toSorted((left, right) => {
      const distance =
        Math.abs(effortRatios[left] - configuredRatio) -
        Math.abs(effortRatios[right] - configuredRatio);
      if (distance !== 0) {
        return distance;
      }
      const ratio = effortRatios[left] - effortRatios[right];
      if (ratio !== 0) {
        return ratio;
      }
      return gatewayEfforts.indexOf(left) - gatewayEfforts.indexOf(right);
    })[0] ?? null
  );
}

function hiddenParameters(input: ResolveEffectiveParametersInput): EffectiveModelParameters {
  const nonReasoning = input.capability.reasoning.kind === "none";
  const title = input.purpose === "title";
  const hiddenReason = title ? "hidden_title_disabled" : "hidden_compaction_default";
  return Object.freeze({
    budgetStatus: status("unsupported", hiddenReason),
    configured: Object.freeze({
      reasoningBudgetTokens: input.reasoningBudgetTokens,
      reasoningEffort: input.reasoningEffort,
      temperaturePreset: input.temperaturePreset,
    }),
    effortStatus: status("unsupported", hiddenReason),
    purpose: input.purpose,
    reasoning: nonReasoning
      ? null
      : title
        ? Object.freeze({ enabled: false, exclude: true })
        : Object.freeze({ exclude: true }),
    temperature: null,
    temperatureStatus: status("unsupported", "provider_default_strength"),
    tier: input.tier,
    traceExcluded: !nonReasoning,
  });
}

export function effectiveReasoningBudget(
  configuredBudget: AdminReasoningBudgetTokens,
  effort: Exclude<AdminReasoningEffort, "off">,
  maximumOutputTokens: number,
): number {
  return Math.min(
    maximumOutputTokens,
    Math.max(
      1_024,
      Math.min(configuredBudget, Math.floor(effortRatios[effort] * maximumOutputTokens)),
    ),
  );
}

export function resolveEffectiveModelParameters(
  input: ResolveEffectiveParametersInput,
): EffectiveModelParameters {
  if (input.capability.reasoning.kind === "unverified") {
    return Object.freeze({
      budgetStatus: status("unsupported", "capability_unverified"),
      configured: Object.freeze({
        reasoningBudgetTokens: input.reasoningBudgetTokens,
        reasoningEffort: input.reasoningEffort,
        temperaturePreset: input.temperaturePreset,
      }),
      effortStatus: status("unsupported", "capability_unverified"),
      purpose: input.purpose,
      reasoning: null,
      temperature: null,
      temperatureStatus: status("unsupported", "capability_unverified"),
      tier: input.tier,
      traceExcluded: false,
    });
  }
  if (input.purpose !== "chat") {
    return hiddenParameters(input);
  }

  const configured = Object.freeze({
    reasoningBudgetTokens: input.reasoningBudgetTokens,
    reasoningEffort: input.reasoningEffort,
    temperaturePreset: input.temperaturePreset,
  });
  const temperature = input.capability.temperatureSupported
    ? TEMPERATURE_PRESET_VALUES[input.temperaturePreset]
    : null;
  const temperatureStatus = input.capability.temperatureSupported
    ? status("exact", "supported")
    : status("unsupported", "temperature_unsupported");

  if (input.capability.reasoning.kind === "none") {
    return Object.freeze({
      budgetStatus: status("unsupported", "non_reasoning_model"),
      configured,
      effortStatus: status("unsupported", "non_reasoning_model"),
      purpose: input.purpose,
      reasoning: null,
      temperature,
      temperatureStatus,
      tier: input.tier,
      traceExcluded: false,
    });
  }

  if (input.reasoningEffort === "off") {
    const mandatory = input.capability.reasoning.kind === "mandatory";
    return Object.freeze({
      budgetStatus: status(
        mandatory ? "mandatory" : "exact",
        mandatory ? "mandatory_reasoning" : "reasoning_disabled",
      ),
      configured,
      effortStatus: status(
        mandatory ? "mandatory" : "exact",
        mandatory ? "mandatory_reasoning" : "reasoning_disabled",
      ),
      purpose: input.purpose,
      reasoning: mandatory
        ? Object.freeze({ exclude: true })
        : Object.freeze({ enabled: false, exclude: true }),
      temperature,
      temperatureStatus,
      tier: input.tier,
      traceExcluded: true,
    });
  }

  if (input.capability.reasoning.maxTokensAccepted) {
    return Object.freeze({
      budgetStatus: status("translated", "max_tokens_precision_unverified"),
      configured,
      effortStatus: status("translated", "max_tokens_precision_unverified"),
      purpose: input.purpose,
      reasoning: Object.freeze({
        exclude: true,
        maxTokens: effectiveReasoningBudget(
          input.reasoningBudgetTokens,
          input.reasoningEffort,
          input.maximumOutputTokens,
        ),
      }),
      temperature,
      temperatureStatus,
      tier: input.tier,
      traceExcluded: true,
    });
  }

  const configuredEffort = configuredGatewayEffort(input.reasoningEffort);
  const chosenEffort = nearestEffort(input.reasoningEffort, supportedEfforts(input.capability));
  if (chosenEffort !== null) {
    return Object.freeze({
      budgetStatus: status("unsupported", "budget_control_unavailable"),
      configured,
      effortStatus:
        chosenEffort === configuredEffort
          ? status("exact", "supported")
          : status("translated", "effort_nearest_supported"),
      purpose: input.purpose,
      reasoning: Object.freeze({ effort: chosenEffort, exclude: true }),
      temperature,
      temperatureStatus,
      tier: input.tier,
      traceExcluded: true,
    });
  }

  return Object.freeze({
    budgetStatus: status("unsupported", "budget_control_unavailable"),
    configured,
    effortStatus: status("unsupported", "effort_control_unavailable"),
    purpose: input.purpose,
    reasoning: Object.freeze({ exclude: true }),
    temperature,
    temperatureStatus,
    tier: input.tier,
    traceExcluded: true,
  });
}
