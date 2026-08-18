import { describe, expect, it } from "vitest";
import type { CatalogModelCapability } from "../src/model-policy/catalog.js";
import {
  effectiveReasoningBudget,
  type ResolveEffectiveParametersInput,
  resolveEffectiveModelParameters,
} from "../src/model-policy/effective-parameters.js";

function capability(
  reasoning: CatalogModelCapability["reasoning"],
  temperatureSupported = true,
): CatalogModelCapability {
  return Object.freeze({ reasoning: Object.freeze(reasoning), temperatureSupported });
}

const optionalReasoning = capability({
  contractSource: "test",
  defaultEffort: null,
  defaultEnabled: null,
  effortSupport: Object.freeze({ kind: "all" }),
  exclusionVerifiedAt: new Date("2026-08-17T12:00:00.000Z"),
  kind: "optional",
  maxTokensAccepted: false,
  traceSafety: "provider_excluded",
});

function input(
  overrides: Partial<ResolveEffectiveParametersInput> = {},
): ResolveEffectiveParametersInput {
  return {
    capability: optionalReasoning,
    maximumOutputTokens: 8_192,
    purpose: "chat",
    reasoningBudgetTokens: 4_096,
    reasoningEffort: "medium",
    temperaturePreset: "balanced",
    tier: "balanced",
    ...overrides,
  };
}

describe("effective model parameter resolution", () => {
  it("resolves supported temperature and exact optional-reasoning disablement", () => {
    expect(
      resolveEffectiveModelParameters(
        input({ reasoningBudgetTokens: 0, reasoningEffort: "off", temperaturePreset: "creative" }),
      ),
    ).toEqual({
      budgetStatus: { kind: "exact", reason: "reasoning_disabled" },
      configured: {
        reasoningBudgetTokens: 0,
        reasoningEffort: "off",
        temperaturePreset: "creative",
      },
      effortStatus: { kind: "exact", reason: "reasoning_disabled" },
      purpose: "chat",
      reasoning: { enabled: false, exclude: true },
      temperature: 0.8,
      temperatureStatus: { kind: "exact", reason: "supported" },
      tier: "balanced",
      traceExcluded: true,
    });
  });

  it("keeps mandatory reasoning enabled when configured intent is off", () => {
    const mandatory = capability({
      ...optionalReasoning.reasoning,
      kind: "mandatory",
    });
    const resolved = resolveEffectiveModelParameters(
      input({
        capability: mandatory,
        reasoningBudgetTokens: 0,
        reasoningEffort: "off",
      }),
    );

    expect(resolved.reasoning).toEqual({ exclude: true });
    expect(resolved.effortStatus).toEqual({
      kind: "mandatory",
      reason: "mandatory_reasoning",
    });
    expect(resolved.budgetStatus).toEqual({
      kind: "mandatory",
      reason: "mandatory_reasoning",
    });
  });

  it("translates a positive budget inside the unchanged total-output envelope", () => {
    const budgetCapability = capability({
      ...optionalReasoning.reasoning,
      maxTokensAccepted: true,
    });
    expect(effectiveReasoningBudget(8_192, "high", 10_000)).toBe(8_000);
    expect(
      resolveEffectiveModelParameters(
        input({
          capability: budgetCapability,
          maximumOutputTokens: 10_000,
          reasoningBudgetTokens: 8_192,
          reasoningEffort: "high",
        }),
      ),
    ).toMatchObject({
      budgetStatus: {
        kind: "translated",
        reason: "max_tokens_precision_unverified",
      },
      effortStatus: {
        kind: "translated",
        reason: "max_tokens_precision_unverified",
      },
      reasoning: { exclude: true, maxTokens: 8_000 },
    });
  });

  it("chooses the lower-cost effort and canonical effort for deterministic ties", () => {
    const lowerRatioTie = capability({
      ...optionalReasoning.reasoning,
      effortSupport: Object.freeze({
        kind: "listed",
        values: Object.freeze(["low", "high"] as const),
      }),
    });
    expect(resolveEffectiveModelParameters(input({ capability: lowerRatioTie })).reasoning).toEqual(
      {
        effort: "low",
        exclude: true,
      },
    );

    const canonicalTie = capability({
      ...optionalReasoning.reasoning,
      effortSupport: Object.freeze({
        kind: "listed",
        values: Object.freeze(["max", "xhigh"] as const),
      }),
    });
    expect(
      resolveEffectiveModelParameters(input({ capability: canonicalTie, reasoningEffort: "high" }))
        .reasoning,
    ).toEqual({
      effort: "xhigh",
      exclude: true,
    });
  });

  it("uses purpose-isolated hidden parameters and disables optional title reasoning", () => {
    expect(
      resolveEffectiveModelParameters(input({ purpose: "compaction", tier: "fast" })),
    ).toMatchObject({
      effortStatus: { kind: "unsupported", reason: "hidden_compaction_default" },
      purpose: "compaction",
      reasoning: { exclude: true },
      temperature: null,
      tier: "fast",
    });
    expect(
      resolveEffectiveModelParameters(input({ purpose: "title", tier: "fast" })),
    ).toMatchObject({
      effortStatus: { kind: "unsupported", reason: "hidden_title_disabled" },
      purpose: "title",
      reasoning: { enabled: false, exclude: true },
      temperature: null,
      tier: "fast",
    });
  });

  it("fails closed for unverified capabilities", () => {
    const unverified = capability(
      {
        ...optionalReasoning.reasoning,
        effortSupport: Object.freeze({ kind: "none" }),
        exclusionVerifiedAt: null,
        kind: "unverified",
        traceSafety: "unverified",
      },
      false,
    );
    expect(resolveEffectiveModelParameters(input({ capability: unverified }))).toMatchObject({
      budgetStatus: { kind: "unsupported", reason: "capability_unverified" },
      effortStatus: { kind: "unsupported", reason: "capability_unverified" },
      reasoning: null,
      temperature: null,
      temperatureStatus: { kind: "unsupported", reason: "capability_unverified" },
      traceExcluded: false,
    });
  });
});
