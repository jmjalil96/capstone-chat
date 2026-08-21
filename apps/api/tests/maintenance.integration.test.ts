import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppDatabase, createDatabase } from "../src/database/database.js";
import { workspaces } from "../src/database/identity-schema.js";
import { migrateDatabase } from "../src/database/migrate.js";
import { initialTierModels, verifyPrivacyAttestation } from "../src/model-policy/catalog.js";
import { createModelPolicyService } from "../src/model-policy/service.js";
import { costControlTuning } from "../src/model-policy/settings.js";
import { tierCatalogFixture } from "./support/catalog.js";

function catalog(validatedAt: Date): ReturnType<typeof tierCatalogFixture> {
  return tierCatalogFixture(validatedAt, (tier) => ({
    displayName: `Model ${tier}`,
    maximumOutputTokens: 16_384,
  }));
}

describe.sequential("catalog refresh lease cadence", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let database: AppDatabase;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18.4-alpine")
      .withDatabase("capstone_maintenance")
      .withUsername("capstone")
      .withPassword("capstone-test-password")
      .start();
    await migrateDatabase(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    database = createDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it("claims only due rows and recovers an expired lease", async () => {
    const workspaceIdentity = `maintenance-${randomUUID()}`;
    await database.insert(workspaces).values({
      displayName: "Maintenance workspace",
      identity: workspaceIdentity,
      timezone: "America/Guayaquil",
    });
    const service = createModelPolicyService(database);
    const validatedAt = new Date();
    const bootstrap = await service.bootstrap({
      catalog: catalog(validatedAt),
      employeeActiveGenerationLimit: 2,
      maximumOutputTokens: { balanced: 8_192, fast: 4_096, pro: 16_384 },
      mode: "openrouter",
      monthlyBudgetUsd: "100",
      privacyAttestation: verifyPrivacyAttestation({
        attestationVersion: "openrouter-privacy-v1",
        broadcastEnabled: false,
        dataDiscountLoggingEnabled: false,
        inputOutputLoggingEnabled: false,
        verifiedAt: validatedAt,
      }),
      reservationMarginBasisPoints: 2_000,
      workspaceIdentity,
    });

    const firstOwner = randomUUID();
    const secondOwner = randomUUID();
    const beforeDue = new Date(
      validatedAt.getTime() + costControlTuning.catalogRefreshIntervalMs - 1,
    );
    await expect(service.claimCatalogRefresh(firstOwner, beforeDue)).resolves.toEqual({
      modelIds: [],
      ownerId: firstOwner,
    });

    const dueAt = new Date(validatedAt.getTime() + costControlTuning.catalogRefreshIntervalMs);
    const firstClaim = await service.claimCatalogRefresh(firstOwner, dueAt);
    expect(new Set(firstClaim.modelIds)).toEqual(new Set(Object.values(initialTierModels)));
    await expect(service.claimCatalogRefresh(secondOwner, dueAt)).resolves.toEqual({
      modelIds: [],
      ownerId: secondOwner,
    });

    const leaseExpiredAt = new Date(dueAt.getTime() + costControlTuning.catalogRefreshLeaseMs);
    const recovered = await service.claimCatalogRefresh(secondOwner, leaseExpiredAt);
    expect(new Set(recovered.modelIds)).toEqual(new Set(Object.values(initialTierModels)));
    await expect(service.releaseCatalogRefresh(recovered, leaseExpiredAt)).resolves.toBe(3);

    const forced = await service.claimCatalogRefresh(firstOwner, new Date(), true);
    const refreshed = catalog(new Date());
    await expect(
      service.completeCatalogRefresh(forced, [refreshed.balanced, refreshed.pro]),
    ).resolves.toEqual({ available: 2, unavailable: 1, updated: 3 });
    await expect(
      service.readEmployeeTierPolicy(bootstrap.workspaceId, "openrouter"),
    ).resolves.toEqual({
      defaultTier: "balanced",
      tiers: [
        { available: false, enabled: true, tier: "fast" },
        { available: true, enabled: true, tier: "balanced" },
        { available: true, enabled: true, tier: "pro" },
      ],
    });
  });
});
