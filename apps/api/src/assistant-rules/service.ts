import {
  type AdminAssistantRulesResponse,
  ASSISTANT_RULES_HISTORY_PAGE_SIZE,
  ASSISTANT_RULES_MAX_CODE_POINTS,
  ASSISTANT_RULES_MAX_UTF8_BYTES,
  ASSISTANT_RULES_REVISION_MAX,
  type AssistantRulesActor,
  type AssistantRulesChangeKind,
  type AssistantRulesHistoryResponse,
  type AssistantRulesRevision,
  type MemberAssistantRulesResponse,
  type PreviewAssistantRulesResponse,
} from "@capstone/protocol";
import { Decimal } from "decimal.js";
import { and, desc, eq, lt } from "drizzle-orm";
import { type CursorCodec, cursorInteger, cursorString } from "../conversations/cursor.js";
import {
  workspaceAssistantPromptRevisions,
  workspaceAssistantPrompts,
} from "../database/assistant-rules-schema.js";
import type { AppDatabase, AppDatabaseExecutor, AppTransaction } from "../database/database.js";
import { workspaces } from "../database/identity-schema.js";
import { modelCatalog, workspaceModelPolicies } from "../database/model-policy-schema.js";
import type { RequestActor } from "../identity/authorization.js";
import { DEFAULT_WORKSPACE_ASSISTANT_RULES } from "./defaults.js";
import {
  AssistantRulesChangedError,
  AssistantRulesConflictError,
  AssistantRulesNotFoundError,
} from "./errors.js";
import {
  assistantRulesCounts,
  composeAssistantSystemPrompt,
  createSystemPromptSnapshot,
  lockedAssistantBase,
  normalizeWorkspaceAssistantRules,
  type SystemPromptSnapshot,
} from "./prompt.js";

const historyCursorKind = "assistant-rules-history";
const PercentageDecimal = Decimal.clone({
  precision: 80,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -1_000,
  toExpPos: 1_000,
});

interface PromptRevisionRow {
  readonly actorDisplayName: string | null;
  readonly actorKind: string;
  readonly actorUserId: string | null;
  readonly changeKind: string;
  readonly createdAt: Date;
  readonly revertedFromRevision: number | null;
  readonly revision: number;
  readonly workspaceText: string;
}

export interface AssistantRulesServiceOptions {
  readonly cursorCodec?: CursorCodec;
  readonly now?: () => Date;
}

function actorFromRow(row: PromptRevisionRow): AssistantRulesActor {
  if (row.actorKind === "system") {
    return Object.freeze({ kind: "system", label: "Sistema" });
  }
  if (row.actorKind !== "user" || row.actorUserId === null || row.actorDisplayName === null) {
    throw new AssistantRulesConflictError("Stored assistant-rules actor is invalid");
  }
  return Object.freeze({
    displayName: row.actorDisplayName,
    kind: "user",
    userId: row.actorUserId,
  });
}

function changeKindFromRow(value: string): AssistantRulesChangeKind {
  if (
    value !== "bootstrap" &&
    value !== "migration" &&
    value !== "save" &&
    value !== "reset" &&
    value !== "revert"
  ) {
    throw new AssistantRulesConflictError("Stored assistant-rules change kind is invalid");
  }
  return value;
}

function promptRevisionSelection() {
  return {
    actorDisplayName: workspaceAssistantPromptRevisions.actorDisplayName,
    actorKind: workspaceAssistantPromptRevisions.actorKind,
    actorUserId: workspaceAssistantPromptRevisions.actorUserId,
    changeKind: workspaceAssistantPromptRevisions.changeKind,
    createdAt: workspaceAssistantPromptRevisions.createdAt,
    revertedFromRevision: workspaceAssistantPromptRevisions.revertedFromRevision,
    revision: workspaceAssistantPromptRevisions.revision,
    workspaceText: workspaceAssistantPromptRevisions.workspaceText,
  } as const;
}

async function currentRevision(
  executor: AppDatabaseExecutor,
  workspaceId: string,
): Promise<PromptRevisionRow> {
  const rows = await executor
    .select(promptRevisionSelection())
    .from(workspaceAssistantPrompts)
    .innerJoin(
      workspaceAssistantPromptRevisions,
      and(
        eq(workspaceAssistantPromptRevisions.workspaceId, workspaceAssistantPrompts.workspaceId),
        eq(workspaceAssistantPromptRevisions.revision, workspaceAssistantPrompts.revision),
      ),
    )
    .where(eq(workspaceAssistantPrompts.workspaceId, workspaceId))
    .limit(1)
    .for("share");
  const row = rows[0];
  if (row === undefined) {
    throw new AssistantRulesConflictError("Workspace assistant rules are not initialized");
  }
  return row;
}

async function balancedCostImpact(
  executor: AppDatabaseExecutor,
  workspaceId: string,
  approximateInputTokens: number,
): Promise<string | null> {
  const rows = await executor
    .select({
      completionPricePerToken: modelCatalog.completionPricePerToken,
      maximumOutputTokens: workspaceModelPolicies.maximumOutputTokens,
      promptPricePerToken: modelCatalog.promptPricePerToken,
    })
    .from(workspaceModelPolicies)
    .innerJoin(modelCatalog, eq(modelCatalog.id, workspaceModelPolicies.modelCatalogId))
    .where(
      and(
        eq(workspaceModelPolicies.workspaceId, workspaceId),
        eq(workspaceModelPolicies.tier, "balanced"),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined || row.maximumOutputTokens <= 0) {
    return null;
  }
  const maximumResponseCost = new PercentageDecimal(row.completionPricePerToken).mul(
    row.maximumOutputTokens,
  );
  if (maximumResponseCost.isZero()) {
    return null;
  }
  return new PercentageDecimal(row.promptPricePerToken)
    .mul(approximateInputTokens)
    .div(maximumResponseCost)
    .mul(100)
    .toFixed(2)
    .replace(/(\.\d*?)0+$/u, "$1")
    .replace(/\.$/u, "");
}

async function estimate(executor: AppDatabaseExecutor, workspaceId: string, workspaceText: string) {
  const counts = assistantRulesCounts(workspaceText);
  return Object.freeze({
    balancedMaximumResponseCostPercent: await balancedCostImpact(
      executor,
      workspaceId,
      counts.approximateInputTokens,
    ),
    counts,
  });
}

export async function bootstrapAssistantRulesInTransaction(
  transaction: AppTransaction,
  workspaceId: string,
  createdAt: Date,
): Promise<void> {
  const existing = await transaction
    .select({ revision: workspaceAssistantPrompts.revision })
    .from(workspaceAssistantPrompts)
    .where(eq(workspaceAssistantPrompts.workspaceId, workspaceId))
    .limit(1)
    .for("update");
  if (existing.length === 1) {
    return;
  }
  if (existing.length > 1) {
    throw new AssistantRulesConflictError("Workspace assistant-rules head is ambiguous");
  }
  const normalized = normalizeWorkspaceAssistantRules(DEFAULT_WORKSPACE_ASSISTANT_RULES);
  await transaction.insert(workspaceAssistantPromptRevisions).values({
    actorKind: "system",
    changeKind: "bootstrap",
    createdAt,
    revision: 1,
    workspaceId,
    workspaceText: normalized,
  });
  await transaction.insert(workspaceAssistantPrompts).values({
    revision: 1,
    workspaceId,
  });
}

export function createAssistantRulesService(
  database: AppDatabase,
  options: AssistantRulesServiceOptions,
) {
  const now = options.now ?? (() => new Date());

  async function preview(
    workspaceId: string,
    workspaceText: string,
  ): Promise<PreviewAssistantRulesResponse> {
    const normalizedWorkspaceText = normalizeWorkspaceAssistantRules(workspaceText);
    return Object.freeze({
      effectivePrompt: composeAssistantSystemPrompt(normalizedWorkspaceText),
      estimate: await estimate(database, workspaceId, normalizedWorkspaceText),
      normalizedWorkspaceText,
    });
  }

  async function readMember(workspaceId: string): Promise<MemberAssistantRulesResponse> {
    const current = await currentRevision(database, workspaceId);
    return Object.freeze({
      baseText: lockedAssistantBase.text,
      baseVersion: lockedAssistantBase.version,
      effectivePrompt: composeAssistantSystemPrompt(current.workspaceText),
      updatedAt: current.createdAt.toISOString(),
      workspaceText: current.workspaceText,
    });
  }

  async function readAdmin(workspaceId: string): Promise<AdminAssistantRulesResponse> {
    const current = await currentRevision(database, workspaceId);
    return Object.freeze({
      actor: actorFromRow(current),
      baseText: lockedAssistantBase.text,
      baseVersion: lockedAssistantBase.version,
      changeKind: changeKindFromRow(current.changeKind),
      disclosure: Object.freeze({
        retainedInImmutableHistory: true,
        sentToConfiguredZdrProvider: true,
        visibleToActiveMembers: true,
      }),
      effectivePrompt: composeAssistantSystemPrompt(current.workspaceText),
      estimate: await estimate(database, workspaceId, current.workspaceText),
      limits: Object.freeze({
        maximumCodePoints: ASSISTANT_RULES_MAX_CODE_POINTS,
        maximumUtf8Bytes: ASSISTANT_RULES_MAX_UTF8_BYTES,
      }),
      revertedFromRevision: current.revertedFromRevision,
      revision: current.revision,
      updatedAt: current.createdAt.toISOString(),
      workspaceText: current.workspaceText,
    });
  }

  async function append(
    workspaceId: string,
    actor: RequestActor,
    observedRevision: number,
    workspaceText: string,
    changeKind: "save" | "reset" | "revert",
    revertedFromRevision: number | null,
  ): Promise<AdminAssistantRulesResponse> {
    const normalizedWorkspaceText = normalizeWorkspaceAssistantRules(workspaceText);
    await database.transaction(async (transaction) => {
      const workspaceRows = await transaction
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1)
        .for("update");
      if (workspaceRows[0] === undefined) {
        throw new AssistantRulesConflictError("Workspace does not exist");
      }
      const headRows = await transaction
        .select({ revision: workspaceAssistantPrompts.revision })
        .from(workspaceAssistantPrompts)
        .where(eq(workspaceAssistantPrompts.workspaceId, workspaceId))
        .limit(1)
        .for("update");
      const head = headRows[0];
      if (head === undefined) {
        throw new AssistantRulesConflictError("Workspace assistant rules are not initialized");
      }
      if (head.revision !== observedRevision) {
        throw new AssistantRulesChangedError();
      }
      if (head.revision >= ASSISTANT_RULES_REVISION_MAX) {
        throw new AssistantRulesConflictError("Workspace assistant-rules revision is exhausted");
      }
      const revision = head.revision + 1;
      const createdAt = now();
      await transaction.insert(workspaceAssistantPromptRevisions).values({
        actorDisplayName: actor.employee.name,
        actorKind: "user",
        actorUserId: actor.employee.id,
        changeKind,
        createdAt,
        revertedFromRevision,
        revision,
        workspaceId,
        workspaceText: normalizedWorkspaceText,
      });
      await transaction
        .update(workspaceAssistantPrompts)
        .set({ revision })
        .where(
          and(
            eq(workspaceAssistantPrompts.workspaceId, workspaceId),
            eq(workspaceAssistantPrompts.revision, observedRevision),
          ),
        );
    });
    return readAdmin(workspaceId);
  }

  async function save(
    workspaceId: string,
    actor: RequestActor,
    observedRevision: number,
    workspaceText: string,
  ): Promise<AdminAssistantRulesResponse> {
    return append(workspaceId, actor, observedRevision, workspaceText, "save", null);
  }

  async function reset(
    workspaceId: string,
    actor: RequestActor,
    observedRevision: number,
  ): Promise<AdminAssistantRulesResponse> {
    return append(
      workspaceId,
      actor,
      observedRevision,
      DEFAULT_WORKSPACE_ASSISTANT_RULES,
      "reset",
      null,
    );
  }

  async function revert(
    workspaceId: string,
    actor: RequestActor,
    sourceRevision: number,
    observedRevision: number,
  ): Promise<AdminAssistantRulesResponse> {
    const rows = await database
      .select({ workspaceText: workspaceAssistantPromptRevisions.workspaceText })
      .from(workspaceAssistantPromptRevisions)
      .where(
        and(
          eq(workspaceAssistantPromptRevisions.workspaceId, workspaceId),
          eq(workspaceAssistantPromptRevisions.revision, sourceRevision),
        ),
      )
      .limit(1);
    const source = rows[0];
    if (source === undefined) {
      throw new AssistantRulesNotFoundError();
    }
    return append(
      workspaceId,
      actor,
      observedRevision,
      source.workspaceText,
      "revert",
      sourceRevision,
    );
  }

  async function history(
    workspaceId: string,
    cursor?: string,
  ): Promise<AssistantRulesHistoryResponse> {
    let beforeRevision: number | null = null;
    if (cursor !== undefined) {
      if (options.cursorCodec === undefined) {
        throw new AssistantRulesConflictError("Assistant-rules cursor support is not configured");
      }
      const payload = options.cursorCodec.decode(cursor, historyCursorKind);
      if (cursorString(payload, "workspaceId") !== workspaceId) {
        throw new AssistantRulesNotFoundError();
      }
      beforeRevision = cursorInteger(payload, "beforeRevision");
    }
    const rows = await database
      .select(promptRevisionSelection())
      .from(workspaceAssistantPromptRevisions)
      .where(
        and(
          eq(workspaceAssistantPromptRevisions.workspaceId, workspaceId),
          beforeRevision === null
            ? undefined
            : lt(workspaceAssistantPromptRevisions.revision, beforeRevision),
        ),
      )
      .orderBy(desc(workspaceAssistantPromptRevisions.revision))
      .limit(ASSISTANT_RULES_HISTORY_PAGE_SIZE + 1);
    const visible = rows.slice(0, ASSISTANT_RULES_HISTORY_PAGE_SIZE);
    const items = visible.map(
      (row): AssistantRulesRevision =>
        Object.freeze({
          actor: actorFromRow(row),
          changeKind: changeKindFromRow(row.changeKind),
          createdAt: row.createdAt.toISOString(),
          revertedFromRevision: row.revertedFromRevision,
          revision: row.revision,
          workspaceText: row.workspaceText,
        }),
    );
    const last = visible.at(-1);
    if (
      rows.length > ASSISTANT_RULES_HISTORY_PAGE_SIZE &&
      last !== undefined &&
      options.cursorCodec === undefined
    ) {
      throw new AssistantRulesConflictError("Assistant-rules cursor support is not configured");
    }
    return Object.freeze({
      items,
      nextCursor:
        rows.length <= ASSISTANT_RULES_HISTORY_PAGE_SIZE || last === undefined
          ? null
          : (options.cursorCodec?.encode({
              beforeRevision: last.revision,
              kind: historyCursorKind,
              version: 1,
              workspaceId,
            }) ?? null),
    });
  }

  async function capturePromptSnapshot(
    executor: AppDatabaseExecutor,
    workspaceId: string,
  ): Promise<SystemPromptSnapshot> {
    const current = await currentRevision(executor, workspaceId);
    return createSystemPromptSnapshot(current.revision, current.workspaceText);
  }

  return Object.freeze({
    capturePromptSnapshot,
    history,
    preview,
    readAdmin,
    readMember,
    reset,
    revert,
    save,
  });
}

export type AssistantRulesService = ReturnType<typeof createAssistantRulesService>;
