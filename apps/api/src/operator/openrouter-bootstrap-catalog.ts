import {
  type CatalogModelSnapshot,
  initialTierModels,
  type ModelTier,
  modelTiers,
} from "../model-policy/catalog.js";
import { OpenRouterCatalogClient } from "../openrouter/catalog-client.js";

export async function loadApprovedOpenRouterCatalog(
  apiKey: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<Readonly<Record<ModelTier, CatalogModelSnapshot>>> {
  const client = new OpenRouterCatalogClient({ apiKey });
  const snapshots = await client.loadSnapshots(
    modelTiers.map((tier) => initialTierModels[tier]),
    signal,
  );
  const byModel = new Map(snapshots.map((snapshot) => [snapshot.modelId, snapshot]));
  const catalog = {} as Record<ModelTier, CatalogModelSnapshot>;
  for (const tier of modelTiers) {
    const snapshot = byModel.get(initialTierModels[tier]);
    if (snapshot === undefined) {
      throw new Error(`The approved ${tier} model has no eligible OpenRouter route`);
    }
    catalog[tier] = snapshot;
  }
  return Object.freeze(catalog);
}
