import { describe, expect, it, vi } from "vitest";
import type { CatalogModelSnapshot } from "../src/model-policy/catalog.js";
import { refreshClaimedCatalog } from "../src/model-policy/catalog-refresh.js";
import type { ModelPolicyService } from "../src/model-policy/service.js";

const ownerId = "00000000-0000-4000-8000-000000000061";
const claim = Object.freeze({ modelIds: Object.freeze(["approved/model"]), ownerId });
const snapshot: CatalogModelSnapshot = Object.freeze({
  available: true,
  canonicalSlug: "approved/model",
  completionPricePerToken: "0.000002",
  contextLength: 128_000,
  displayName: "Approved model",
  inputModalities: Object.freeze(["text"]),
  maximumOutputTokens: 8_192,
  metadataSource: "openrouter",
  modelId: "approved/model",
  outputModalities: Object.freeze(["text"]),
  promptPricePerToken: "0.000001",
  requestPriceUsd: "0",
  supportedParameters: Object.freeze(["max_tokens", "reasoning"]),
  validatedAt: new Date("2026-08-08T12:00:00.000Z"),
});

type RefreshStore = Pick<
  ModelPolicyService,
  "claimCatalogRefresh" | "completeCatalogRefresh" | "releaseCatalogRefresh"
>;

describe("catalog refresh orchestration", () => {
  it("loads snapshots only between the claim and apply transactions", async () => {
    const phases: string[] = [];
    let storePhaseActive = false;
    const store: RefreshStore = {
      async claimCatalogRefresh() {
        storePhaseActive = true;
        phases.push("claim");
        storePhaseActive = false;
        return claim;
      },
      async completeCatalogRefresh() {
        expect(storePhaseActive).toBe(false);
        storePhaseActive = true;
        phases.push("apply");
        storePhaseActive = false;
        return { available: 1, unavailable: 0, updated: 1 };
      },
      releaseCatalogRefresh: vi.fn(async () => 0),
    };

    await expect(
      refreshClaimedCatalog({
        loadSnapshots: async (modelIds) => {
          expect(storePhaseActive).toBe(false);
          expect(modelIds).toEqual(["approved/model"]);
          phases.push("load");
          return [snapshot];
        },
        modelPolicy: store,
        ownerId,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ available: 1, claimed: 1, unavailable: 0, updated: 1 });
    expect(phases).toEqual(["claim", "load", "apply"]);
  });

  it("does not call the loader or apply phase for an empty claim", async () => {
    const loadSnapshots = vi.fn(async () => [snapshot]);
    const completeCatalogRefresh = vi.fn(async () => ({
      available: 0,
      unavailable: 0,
      updated: 0,
    }));
    const store: RefreshStore = {
      claimCatalogRefresh: vi.fn(async () => ({ modelIds: [], ownerId })),
      completeCatalogRefresh,
      releaseCatalogRefresh: vi.fn(async () => 0),
    };

    await expect(
      refreshClaimedCatalog({
        loadSnapshots,
        modelPolicy: store,
        ownerId,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ available: 0, claimed: 0, unavailable: 0, updated: 0 });
    expect(loadSnapshots).not.toHaveBeenCalled();
    expect(completeCatalogRefresh).not.toHaveBeenCalled();
  });

  it("lets the explicit operator path bypass only the due-time predicate", async () => {
    const claimCatalogRefresh = vi.fn(async () => ({ modelIds: [], ownerId }));
    const store: RefreshStore = {
      claimCatalogRefresh,
      completeCatalogRefresh: vi.fn(async () => ({
        available: 0,
        unavailable: 0,
        updated: 0,
      })),
      releaseCatalogRefresh: vi.fn(async () => 0),
    };

    await refreshClaimedCatalog({
      force: true,
      loadSnapshots: vi.fn(async () => []),
      modelPolicy: store,
      ownerId,
      signal: new AbortController().signal,
    });

    expect(claimCatalogRefresh).toHaveBeenCalledWith(ownerId, expect.any(Date), true);
  });

  it("releases the claimed lease when loading fails", async () => {
    const releaseCatalogRefresh = vi.fn(async () => 1);
    const store: RefreshStore = {
      claimCatalogRefresh: vi.fn(async () => claim),
      completeCatalogRefresh: vi.fn(async () => ({
        available: 0,
        unavailable: 0,
        updated: 0,
      })),
      releaseCatalogRefresh,
    };
    const failure = new Error("Synthetic loader failure");

    await expect(
      refreshClaimedCatalog({
        loadSnapshots: async () => {
          throw failure;
        },
        modelPolicy: store,
        ownerId,
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(failure);
    expect(releaseCatalogRefresh).toHaveBeenCalledExactlyOnceWith(claim);
  });
});
