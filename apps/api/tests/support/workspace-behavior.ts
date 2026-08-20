import { DEFAULT_WORKSPACE_ASSISTANT_RULES } from "../../src/assistant-rules/defaults.js";
import { bootstrapAssistantRulesInTransaction } from "../../src/assistant-rules/service.js";
import { workspaceAssistantPromptRevisions } from "../../src/database/assistant-rules-schema.js";
import type { AppDatabase, AppDatabaseExecutor } from "../../src/database/database.js";
import { workspaceModelPolicyRevisions } from "../../src/database/model-policy-schema.js";

export async function bootstrapTestAssistantRules(
  database: AppDatabase,
  workspaceId: string,
  createdAt = new Date(),
): Promise<void> {
  await database.transaction((transaction) =>
    bootstrapAssistantRulesInTransaction(transaction, workspaceId, createdAt),
  );
}

export async function seedTestBehaviorRevisions(
  database: AppDatabaseExecutor,
  workspaceId: string,
  createdAt: Date,
  revision = 1,
): Promise<void> {
  await seedTestPolicyRevision(database, workspaceId, createdAt, revision);
  await seedTestPromptRevision(database, workspaceId, createdAt, revision);
}

export async function seedTestPolicyRevision(
  database: AppDatabaseExecutor,
  workspaceId: string,
  createdAt: Date,
  revision = 1,
): Promise<void> {
  await database
    .insert(workspaceModelPolicyRevisions)
    .values({
      actorKind: "system",
      changeKind: "bootstrap",
      createdAt,
      defaultTier: "balanced",
      monthlyBudgetUsd: "100",
      revision,
      workspaceId,
    })
    .onConflictDoNothing();
}

export async function seedTestPromptRevision(
  database: AppDatabaseExecutor,
  workspaceId: string,
  createdAt: Date,
  revision = 1,
): Promise<void> {
  await database
    .insert(workspaceAssistantPromptRevisions)
    .values({
      actorKind: "system",
      changeKind: "bootstrap",
      createdAt,
      revision,
      workspaceId,
      workspaceText: DEFAULT_WORKSPACE_ASSISTANT_RULES,
    })
    .onConflictDoNothing();
}
