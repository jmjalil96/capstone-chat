import {
  type CatalogModelSnapshot,
  initialTierModels,
  type ModelTier,
  modelTiers,
} from "../model-policy/catalog.js";
import {
  type ProductionInitializationDocument,
  parseProductionInitializationDocument,
} from "../operator/initialization-document.js";

export const managedRehearsalAdministratorEmail = "administrator@rehearsal.test";

export function parseManagedRehearsalInitializationDocument(
  contents: string,
): ProductionInitializationDocument {
  const document = parseProductionInitializationDocument(contents);
  if (document.administratorEmail !== managedRehearsalAdministratorEmail) {
    throw new Error("Managed rehearsal initialization requires the fixed synthetic administrator");
  }
  return document;
}

export function createLoadRehearsalCatalog(
  validatedAt: Date,
): Readonly<Record<ModelTier, CatalogModelSnapshot>> {
  if (!Number.isFinite(validatedAt.getTime())) {
    throw new Error("Managed rehearsal catalog time is invalid");
  }
  const maximumOutputTokens = { balanced: 8_192, fast: 4_096, pro: 16_384 } as const;
  return Object.freeze(
    Object.fromEntries(
      modelTiers.map((tier) => [
        tier,
        Object.freeze({
          available: true,
          canonicalSlug: initialTierModels[tier],
          completionPricePerToken: "0.000002",
          contextLength: 1_000_000,
          displayName: `Managed rehearsal ${tier}`,
          inputModalities: Object.freeze(["text"]),
          maximumOutputTokens: maximumOutputTokens[tier],
          // The managed rehearsal exercises OpenRouter-shaped reservation and accounting rules,
          // but this deterministic catalog is not provider privacy or live-route evidence.
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
