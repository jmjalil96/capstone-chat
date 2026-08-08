import type { CatalogModelSnapshot } from "./catalog.js";
import type { ModelPolicyService } from "./service.js";

type CatalogRefreshStore = Pick<
  ModelPolicyService,
  "claimCatalogRefresh" | "completeCatalogRefresh" | "releaseCatalogRefresh"
>;

export interface CatalogRefreshSummary {
  readonly available: number;
  readonly claimed: number;
  readonly unavailable: number;
  readonly updated: number;
}

export type CatalogSnapshotLoader = (
  modelIds: readonly string[],
  signal: AbortSignal,
) => Promise<readonly CatalogModelSnapshot[]>;

export interface CatalogRefreshOptions {
  readonly force?: boolean;
  readonly loadSnapshots: CatalogSnapshotLoader;
  readonly modelPolicy: CatalogRefreshStore;
  readonly ownerId: string;
  readonly signal: AbortSignal;
}

const emptySummary = Object.freeze({ available: 0, claimed: 0, unavailable: 0, updated: 0 });

export async function refreshClaimedCatalog(
  options: CatalogRefreshOptions,
): Promise<CatalogRefreshSummary> {
  options.signal.throwIfAborted();
  const claim = options.force
    ? await options.modelPolicy.claimCatalogRefresh(options.ownerId, new Date(), true)
    : await options.modelPolicy.claimCatalogRefresh(options.ownerId);
  if (claim.modelIds.length === 0) {
    return emptySummary;
  }

  try {
    options.signal.throwIfAborted();
    const snapshots = await options.loadSnapshots(
      Object.freeze([...claim.modelIds]),
      options.signal,
    );
    options.signal.throwIfAborted();
    const result = await options.modelPolicy.completeCatalogRefresh(claim, snapshots);
    return Object.freeze({ claimed: claim.modelIds.length, ...result });
  } catch (error: unknown) {
    try {
      await options.modelPolicy.releaseCatalogRefresh(claim);
    } catch {
      // An unreleased lease remains bounded by its database expiry and is safe to retry later.
    }
    throw error;
  }
}
