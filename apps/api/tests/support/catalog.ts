import {
  type CatalogMetadataSource,
  type CatalogModelCapability,
  type CatalogModelSnapshot,
  initialTierModels,
  type ModelTier,
  modelTiers,
} from "../../src/model-policy/catalog.js";
import { testCatalogCapability } from "./generation.js";

const textModalities = Object.freeze(["text"]);
const basicParameters = Object.freeze(["max_tokens", "reasoning"]);

export interface CatalogSnapshotFixtureOptions {
  readonly available?: boolean;
  readonly canonicalSlug?: string | null;
  readonly capability?: CatalogModelCapability;
  readonly completionPricePerToken?: string;
  readonly contextLength?: number;
  readonly displayName?: string;
  readonly inputModalities?: readonly string[];
  readonly maximumOutputTokens: number;
  readonly metadataSource?: CatalogMetadataSource;
  readonly modelId: string;
  readonly outputModalities?: readonly string[];
  readonly promptPricePerToken?: string;
  readonly requestPriceUsd?: string;
  readonly supportedParameters?: readonly string[];
  readonly validatedAt: Date;
}

export function catalogSnapshotFixture(
  options: CatalogSnapshotFixtureOptions,
): CatalogModelSnapshot {
  const {
    available = true,
    canonicalSlug = options.modelId,
    capability = testCatalogCapability,
    completionPricePerToken = "0.000002",
    contextLength = 128_000,
    displayName = `Model ${options.modelId}`,
    inputModalities = textModalities,
    maximumOutputTokens,
    metadataSource = "openrouter",
    modelId,
    outputModalities = textModalities,
    promptPricePerToken = "0.000001",
    requestPriceUsd = "0",
    supportedParameters = basicParameters,
    validatedAt,
  } = options;
  return Object.freeze({
    available,
    canonicalSlug,
    capability,
    completionPricePerToken,
    contextLength,
    displayName,
    inputModalities: Object.freeze([...inputModalities]),
    maximumOutputTokens,
    metadataSource,
    modelId,
    outputModalities: Object.freeze([...outputModalities]),
    promptPricePerToken,
    requestPriceUsd,
    supportedParameters: Object.freeze([...supportedParameters]),
    validatedAt,
  });
}

type TierCatalogOptions = Omit<CatalogSnapshotFixtureOptions, "modelId" | "validatedAt">;

export function tierCatalogFixture(
  validatedAt: Date,
  options: (tier: ModelTier) => TierCatalogOptions,
): Readonly<Record<ModelTier, CatalogModelSnapshot>> {
  return Object.freeze(
    Object.fromEntries(
      modelTiers.map((tier) => [
        tier,
        catalogSnapshotFixture({
          ...options(tier),
          modelId: initialTierModels[tier],
          validatedAt,
        }),
      ]),
    ) as Record<ModelTier, CatalogModelSnapshot>,
  );
}
