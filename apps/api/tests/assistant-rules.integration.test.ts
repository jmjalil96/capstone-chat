import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE_ASSISTANT_RULES } from "../src/assistant-rules/defaults.js";
import {
  AssistantRulesChangedError,
  AssistantRulesNotFoundError,
} from "../src/assistant-rules/errors.js";
import {
  bootstrapAssistantRulesInTransaction,
  createAssistantRulesService,
} from "../src/assistant-rules/service.js";
import { createCursorCodec } from "../src/conversations/cursor.js";
import { user } from "../src/database/auth-schema.generated.js";
import { type AppDatabase, createDatabase } from "../src/database/database.js";
import { workspaceMemberships, workspaces } from "../src/database/identity-schema.js";
import { migrateDatabase } from "../src/database/migrate.js";
import { modelCatalog, workspaceModelPolicies } from "../src/database/model-policy-schema.js";
import type { RequestActor } from "../src/identity/authorization.js";

describe.sequential("assistant-rules revision ledger", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let database: AppDatabase;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18.4-alpine")
      .withDatabase("capstone_assistant_rules")
      .withUsername("capstone")
      .withPassword("capstone-test-password")
      .start();
    await migrateDatabase(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    database = createDatabase(pool);
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE TABLE "workspace_memberships", "user", "workspaces", "model_catalog" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it("appends actor-attributed save, reset, and revert snapshots without rewriting history", async () => {
    const workspaceId = randomUUID();
    const userId = `assistant-rules-admin-${randomUUID()}`;
    const bootstrapAt = new Date("2026-08-17T12:00:00.000Z");
    await database.insert(workspaces).values({
      displayName: "Assistant Rules",
      id: workspaceId,
      identity: `assistant-rules-${workspaceId}`,
    });
    await database.insert(user).values({
      email: `${userId}@example.test`,
      emailVerified: true,
      id: userId,
      name: "Nombre original",
    });
    await database.insert(workspaceMemberships).values({
      role: "admin",
      status: "active",
      userId,
      workspaceId,
    });
    await database.transaction((transaction) =>
      bootstrapAssistantRulesInTransaction(transaction, workspaceId, bootstrapAt),
    );

    let now = bootstrapAt.getTime();
    const service = createAssistantRulesService(database, {
      cursorCodec: createCursorCodec("assistant-rules-ledger-test-secret-with-sufficient-length"),
      now: () => {
        now += 1_000;
        return new Date(now);
      },
    });
    const actor: RequestActor = {
      employee: {
        email: `${userId}@example.test`,
        id: userId,
        name: "Nombre original",
      },
      role: "admin",
      session: {
        createdAt: bootstrapAt,
        expiresAt: new Date("2026-08-18T12:00:00.000Z"),
        id: "assistant-rules-session",
      },
      workspace: {
        id: workspaceId,
        identity: "assistant-rules",
        name: "Assistant Rules",
      },
    };

    const saved = await service.save(workspaceId, actor, 1, "  Cafe\u0301\r\nRegla  ");
    expect(saved).toMatchObject({
      actor: {
        displayName: "Nombre original",
        kind: "user",
        userId,
      },
      changeKind: "save",
      revertedFromRevision: null,
      revision: 2,
      workspaceText: "Café\nRegla",
    });
    await expect(service.save(workspaceId, actor, 1, "stale")).rejects.toBeInstanceOf(
      AssistantRulesChangedError,
    );

    const reset = await service.reset(workspaceId, actor, 2);
    expect(reset).toMatchObject({
      changeKind: "reset",
      revision: 3,
      workspaceText: DEFAULT_WORKSPACE_ASSISTANT_RULES,
    });
    const reverted = await service.revert(workspaceId, actor, 2, 3);
    expect(reverted).toMatchObject({
      changeKind: "revert",
      revertedFromRevision: 2,
      revision: 4,
      workspaceText: "Café\nRegla",
    });

    const history = await service.history(workspaceId);
    expect(history.nextCursor).toBeNull();
    expect(history.items.map(({ revision }) => revision)).toEqual([4, 3, 2, 1]);
    expect(history.items).toMatchObject([
      {
        actor: { displayName: "Nombre original", kind: "user", userId },
        changeKind: "revert",
        revertedFromRevision: 2,
      },
      {
        actor: { displayName: "Nombre original", kind: "user", userId },
        changeKind: "reset",
      },
      {
        actor: { displayName: "Nombre original", kind: "user", userId },
        changeKind: "save",
      },
      {
        actor: { kind: "system", label: "Sistema" },
        changeKind: "bootstrap",
      },
    ]);
    await expect(service.revert(workspaceId, actor, 99, 4)).rejects.toBeInstanceOf(
      AssistantRulesNotFoundError,
    );
  });

  it("preserves zeroes in round balanced cost percentages", async () => {
    const workspaceId = randomUUID();
    const createdAt = new Date("2026-08-17T12:00:00.000Z");
    await database.insert(workspaces).values({
      displayName: "Assistant Rules Cost",
      id: workspaceId,
      identity: `assistant-rules-cost-${workspaceId}`,
    });
    const catalogRows = await database
      .insert(modelCatalog)
      .values({
        available: true,
        canonicalSlug: "fixture/balanced-cost",
        completionPricePerToken: "1",
        contextLength: 4_096,
        createdAt,
        displayName: "Balanced Cost Fixture",
        inputModalities: ["text"],
        maximumOutputTokens: 4_096,
        metadataSource: "openrouter",
        openRouterModelId: "fixture/balanced-cost",
        outputModalities: ["text"],
        promptPricePerToken: "1",
        reasoningContractSource: "non-reasoning fixture",
        reasoningDefaultEffort: null,
        reasoningDefaultEnabled: null,
        reasoningEffortSupportKind: "none",
        reasoningEfforts: [],
        reasoningExclusionVerifiedAt: null,
        reasoningMandatory: false,
        reasoningMaxTokensAccepted: false,
        reasoningMode: "none",
        reasoningTraceSafety: "non_reasoning",
        requestPriceUsd: "0",
        supportedParameters: ["max_tokens"],
        temperatureSupported: true,
        updatedAt: createdAt,
        validatedAt: createdAt,
      })
      .returning({ id: modelCatalog.id });
    const modelCatalogId = catalogRows[0]?.id;
    if (modelCatalogId === undefined) {
      throw new Error("Balanced cost catalog fixture insert failed");
    }
    await database.insert(workspaceModelPolicies).values({
      createdAt,
      enabled: true,
      maximumOutputTokens: 10,
      modelCatalogId,
      reasoningBudgetTokens: 0,
      reasoningEffort: "off",
      temperaturePreset: "balanced",
      tier: "balanced",
      updatedAt: createdAt,
      workspaceId,
    });

    const service = createAssistantRulesService(database, {});
    const estimates = await Promise.all(
      ["", "a", "a".repeat(5), "a".repeat(40)].map(async (workspaceText) => {
        const preview = await service.preview(workspaceId, workspaceText);
        return preview.estimate.balancedMaximumResponseCostPercent;
      }),
    );
    expect(estimates).toEqual(["0", "10", "20", "100"]);

    await database
      .update(workspaceModelPolicies)
      .set({ maximumOutputTokens: 400 })
      .where(eq(workspaceModelPolicies.workspaceId, workspaceId));
    await expect(service.preview(workspaceId, "a")).resolves.toMatchObject({
      estimate: { balancedMaximumResponseCostPercent: "0.25" },
    });
  });
});
