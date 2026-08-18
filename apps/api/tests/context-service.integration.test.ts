import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { user } from "../src/database/auth-schema.generated.js";
import { conversationCompactions } from "../src/database/compaction-schema.js";
import { conversations, messages } from "../src/database/conversation-schema.js";
import { type AppDatabase, createDatabase } from "../src/database/database.js";
import { generations } from "../src/database/generation-schema.js";
import { workspaces } from "../src/database/identity-schema.js";
import { migrateDatabase } from "../src/database/migrate.js";
import { compactionPrompt } from "../src/generations/compaction-prompt.js";
import type { ContextTurn } from "../src/generations/context-planner.js";
import { loadContextWindow } from "../src/generations/context-service.js";
import { seedTestPolicyRevision } from "./support/workspace-behavior.js";

const workspaceId = "10000000-0000-4000-8000-000000000071";
const userId = "phase-seven-context-user";

interface StoredTurn extends ContextTurn {
  readonly turnBytes: number;
}

async function insertConversation(database: AppDatabase): Promise<string> {
  const id = randomUUID();
  await database.insert(conversations).values({ id, userId, workspaceId });
  return id;
}

async function insertTurns(
  database: AppDatabase,
  conversationId: string,
  count: number,
  prefix: string,
  parentMessageId: string | null = null,
  paddingBytes = 0,
): Promise<readonly StoredTurn[]> {
  const stored: StoredTurn[] = [];
  let parentId = parentMessageId;
  for (let index = 1; index <= count; index += 1) {
    const userMessage = {
      id: randomUUID(),
      text: `${prefix}-user-${index}:${"u".repeat(paddingBytes)}`,
    };
    await database.insert(messages).values({
      content: [{ text: userMessage.text, type: "text" }],
      conversationId,
      id: userMessage.id,
      parentMessageId: parentId,
      role: "user",
    });
    const assistantMessage = {
      id: randomUUID(),
      text: `${prefix}-assistant-${index}:${"a".repeat(paddingBytes)}`,
    };
    await database.insert(messages).values({
      content: [{ text: assistantMessage.text, type: "text" }],
      conversationId,
      id: assistantMessage.id,
      parentMessageId: userMessage.id,
      role: "assistant",
    });
    stored.push({
      assistant: assistantMessage,
      turnBytes:
        128 +
        Buffer.byteLength(userMessage.text, "utf8") +
        Buffer.byteLength(assistantMessage.text, "utf8"),
      user: userMessage,
    });
    parentId = assistantMessage.id;
  }
  return stored;
}

async function insertCompletedCompaction(
  database: AppDatabase,
  conversationId: string,
  throughMessageId: string,
  summary: string,
): Promise<string> {
  const now = new Date();
  const generationId = randomUUID();
  await database.insert(generations).values({
    completedAt: now,
    conversationId,
    createdAt: now,
    effectiveParameters: {},
    id: generationId,
    idempotencyKey: randomUUID(),
    modelPolicyRevision: 1,
    purpose: "compaction",
    requestedTier: "fast",
    startedAt: now,
    status: "completed",
    systemPromptVersion: compactionPrompt.version,
    terminalReason: "stop",
    updatedAt: now,
    userId,
    workspaceId,
  });
  const rows = await database
    .insert(conversationCompactions)
    .values({
      completedAt: now,
      conversationId,
      createdAt: now,
      generationId,
      modelUsed: "capstone/fake-compactor",
      promptVersion: compactionPrompt.version,
      sourceTokenCount: 10n,
      status: "completed",
      summary,
      summaryTokenCount: 4n,
      throughMessageId,
      updatedAt: now,
      userId,
      workspaceId,
    })
    .returning({ id: conversationCompactions.id });
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error("Compaction insert did not return an identifier");
  }
  return id;
}

async function contextWindow(
  database: AppDatabase,
  conversationId: string,
  endpointMessageId: string,
  maximumSourceBytes = 1_000_000,
) {
  return database.transaction((transaction) =>
    loadContextWindow(transaction, conversationId, endpointMessageId, maximumSourceBytes),
  );
}

describe.sequential("bounded selected-branch context query", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let database: AppDatabase;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18.4-alpine")
      .withDatabase("capstone_context_service")
      .withUsername("capstone")
      .withPassword("capstone-test-password")
      .start();
    await migrateDatabase(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    database = createDatabase(pool);
    await database.insert(workspaces).values({
      displayName: "Context Workspace",
      id: workspaceId,
      identity: "phase-seven-context",
    });
    await database.insert(user).values({
      email: "context@example.test",
      emailVerified: true,
      id: userId,
      name: "Context Employee",
    });
    await seedTestPolicyRevision(database, workspaceId, new Date());
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it("returns the newest eight turns and the chronological aged prefix without alternatives", async () => {
    const conversationId = await insertConversation(database);
    const selected = await insertTurns(database, conversationId, 12, "selected");
    const alternativeText = "ALTERNATIVE-CONTENT-MUST-NOT-LEAK";
    await database.insert(messages).values({
      content: [{ text: alternativeText, type: "text" }],
      conversationId,
      parentMessageId: selected[9]?.user.id,
      role: "assistant",
    });

    const window = await contextWindow(
      database,
      conversationId,
      selected.at(-1)?.assistant.id ?? "",
    );

    expect(window.previousCompaction).toBeNull();
    expect(window.sourceOverflow).toBe(false);
    expect(window.sourceTurns.map((turn) => turn.assistant.id)).toEqual(
      selected.slice(0, 4).map((turn) => turn.assistant.id),
    );
    expect(window.recentTurns.map((turn) => turn.assistant.id)).toEqual(
      selected.slice(4).map((turn) => turn.assistant.id),
    );
    expect(window.recentTurns).toHaveLength(8);
    expect(JSON.stringify(window)).not.toContain(alternativeText);
  });

  it("returns only the oldest contiguous source turns within the byte bound plus overflow", async () => {
    const conversationId = await insertConversation(database);
    const selected = await insertTurns(database, conversationId, 14, "bounded", null, 180);
    const firstTwoBytes = (selected[0]?.turnBytes ?? 0) + (selected[1]?.turnBytes ?? 0);

    const window = await contextWindow(
      database,
      conversationId,
      selected.at(-1)?.assistant.id ?? "",
      firstTwoBytes,
    );

    expect(window.recentTurns.map((turn) => turn.assistant.id)).toEqual(
      selected.slice(6).map((turn) => turn.assistant.id),
    );
    expect(window.sourceTurns.map((turn) => turn.assistant.id)).toEqual(
      selected.slice(0, 2).map((turn) => turn.assistant.id),
    );
    expect(window.sourceOverflow).toBe(true);
  });

  it("selects only the newest completed compaction on the fixed ancestry", async () => {
    const conversationId = await insertConversation(database);
    const selected = await insertTurns(database, conversationId, 12, "main");
    const commonCompactionId = await insertCompletedCompaction(
      database,
      conversationId,
      selected[1]?.assistant.id ?? "",
      "Common summary",
    );
    const selectedCompactionId = await insertCompletedCompaction(
      database,
      conversationId,
      selected[5]?.assistant.id ?? "",
      "Selected summary",
    );
    const alternative = await insertTurns(
      database,
      conversationId,
      5,
      "alternative",
      selected[1]?.assistant.id ?? null,
    );

    const selectedWindow = await contextWindow(
      database,
      conversationId,
      selected.at(-1)?.assistant.id ?? "",
    );
    expect(selectedWindow.previousCompaction).toEqual({
      id: selectedCompactionId,
      summary: "Selected summary",
      throughMessageId: selected[5]?.assistant.id,
    });
    expect(selectedWindow.sourceTurns).toEqual([]);
    expect(selectedWindow.recentTurns.map((turn) => turn.assistant.id)).toEqual(
      selected.slice(6).map((turn) => turn.assistant.id),
    );

    const alternativeWindow = await contextWindow(
      database,
      conversationId,
      alternative.at(-1)?.assistant.id ?? "",
    );
    expect(alternativeWindow.previousCompaction).toEqual({
      id: commonCompactionId,
      summary: "Common summary",
      throughMessageId: selected[1]?.assistant.id,
    });
    expect(alternativeWindow.recentTurns.map((turn) => turn.assistant.id)).toEqual(
      alternative.map((turn) => turn.assistant.id),
    );
    expect(JSON.stringify(alternativeWindow)).not.toContain("Selected summary");
  });

  it("fails closed for a missing or incomplete selected endpoint", async () => {
    const conversationId = await insertConversation(database);
    const selected = await insertTurns(database, conversationId, 1, "invalid-endpoint");
    const otherConversationId = await insertConversation(database);
    const other = await insertTurns(database, otherConversationId, 1, "other");

    await expect(
      contextWindow(database, conversationId, other[0]?.assistant.id ?? ""),
    ).rejects.toThrow("Selected conversation branch could not be reconstructed");
    await expect(
      contextWindow(database, conversationId, selected[0]?.user.id ?? ""),
    ).rejects.toThrow("Selected conversation branch must end in complete turns");
  });
});
