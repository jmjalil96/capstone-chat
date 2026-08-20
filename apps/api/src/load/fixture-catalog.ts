import {
  type CatalogModelSnapshot,
  initialTierModels,
  type ModelTier,
  modelTiers,
} from "../model-policy/catalog.js";

export function createLoadFixtureCatalog(
  validatedAt: Date,
): Readonly<Record<ModelTier, CatalogModelSnapshot>> {
  if (!Number.isFinite(validatedAt.getTime())) {
    throw new Error("Local load fixture catalog time is invalid");
  }
  const maximumOutputTokens = { balanced: 8_192, fast: 4_096, pro: 16_384 } as const;
  return Object.freeze(
    Object.fromEntries(
      modelTiers.map((tier) => [
        tier,
        Object.freeze({
          available: true,
          canonicalSlug: initialTierModels[tier],
          capability: Object.freeze({
            reasoning: Object.freeze({
              contractSource: "local-load-fixture",
              defaultEffort: null,
              defaultEnabled: null,
              effortSupport: Object.freeze({ kind: "all" as const }),
              exclusionVerifiedAt: validatedAt,
              kind: "optional" as const,
              maxTokensAccepted: true,
              traceSafety: "provider_excluded" as const,
            }),
            temperatureSupported: true,
          }),
          completionPricePerToken: "0.000002",
          contextLength: 1_000_000,
          displayName: `Local load fixture ${tier}`,
          inputModalities: Object.freeze(["text"]),
          maximumOutputTokens: maximumOutputTokens[tier],
          metadataSource: "openrouter" as const,
          modelId: initialTierModels[tier],
          outputModalities: Object.freeze(["text"]),
          promptPricePerToken: "0.000001",
          requestPriceUsd: "0",
          supportedParameters: Object.freeze(["max_tokens", "reasoning"]),
          validatedAt,
        }),
      ]),
    ) as Record<ModelTier, CatalogModelSnapshot>,
  );
}
