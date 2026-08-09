import { sql } from "drizzle-orm";
import type { AppDatabaseExecutor } from "../database/database.js";
import type { ApplicableCompaction, ContextTurn } from "./context-planner.js";
import { contextCompactionTuning } from "./context-planner.js";

interface ContextWindowRow extends Record<string, unknown> {
  readonly branchFound: boolean;
  readonly branchValid: boolean;
  readonly previousCompactionId: string | null;
  readonly previousSummary: string | null;
  readonly previousThroughMessageId: string | null;
  readonly recentTurns: unknown;
  readonly sourceOverflow: boolean;
  readonly sourceTurns: unknown;
}

export interface ContextWindow {
  readonly previousCompaction: ApplicableCompaction | null;
  readonly recentTurns: readonly ContextTurn[];
  readonly sourceOverflow: boolean;
  readonly sourceTurns: readonly ContextTurn[];
}

function parseTurns(value: unknown, label: string): readonly ContextTurn[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} context window is invalid`);
  }
  return value.map((candidate) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`${label} context turn is invalid`);
    }
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.userId !== "string" ||
      typeof record.userText !== "string" ||
      typeof record.assistantId !== "string" ||
      typeof record.assistantText !== "string"
    ) {
      throw new Error(`${label} context turn content is invalid`);
    }
    return Object.freeze({
      assistant: Object.freeze({ id: record.assistantId, text: record.assistantText }),
      user: Object.freeze({ id: record.userId, text: record.userText }),
    });
  });
}

export async function loadContextWindow(
  transaction: AppDatabaseExecutor,
  conversationId: string,
  endpointMessageId: string | null,
  maximumSourceBytes: number,
): Promise<ContextWindow> {
  if (endpointMessageId === null) {
    return Object.freeze({
      previousCompaction: null,
      recentTurns: [],
      sourceOverflow: false,
      sourceTurns: [],
    });
  }
  if (!Number.isSafeInteger(maximumSourceBytes) || maximumSourceBytes <= 0) {
    throw new RangeError("Context source byte bound is invalid");
  }

  const result = await transaction.execute<ContextWindowRow>(sql`
    WITH RECURSIVE branch AS (
      SELECT message.id, message.parent_message_id, message.role, 0::integer AS depth
      FROM messages AS message
      WHERE message.conversation_id = ${conversationId}::uuid
        AND message.id = ${endpointMessageId}::uuid
      UNION ALL
      SELECT parent.id, parent.parent_message_id, parent.role, branch.depth + 1
      FROM messages AS parent
      INNER JOIN branch
        ON parent.conversation_id = ${conversationId}::uuid
       AND parent.id = branch.parent_message_id
    ),
    branch_state AS (
      SELECT COUNT(*) > 0 AS branch_found,
        COALESCE(
          BOOL_AND(
            role = CASE WHEN depth % 2 = 0 THEN 'assistant'::conversation_message_role
              ELSE 'user'::conversation_message_role
            END
          )
          AND COUNT(*) % 2 = 0
          AND COUNT(*) FILTER (WHERE parent_message_id IS NULL AND role = 'user') = 1,
          false
        ) AS branch_valid
      FROM branch
    ),
    applicable AS (
      SELECT compaction.id, compaction.summary, compaction.through_message_id, branch.depth
      FROM conversation_compactions AS compaction
      INNER JOIN branch ON branch.id = compaction.through_message_id
      WHERE compaction.conversation_id = ${conversationId}::uuid
        AND compaction.status = 'completed'
        AND compaction.prompt_version = 'capstone-compaction-v1'
        AND branch.role = 'assistant'
      ORDER BY branch.depth ASC, compaction.created_at DESC, compaction.id DESC
      LIMIT 1
    ),
    boundary AS (
      SELECT COALESCE(
        (SELECT depth FROM applicable),
        (SELECT MAX(depth) + 1 FROM branch)
      )::integer AS depth
    ),
    complete_turns AS (
      SELECT assistant_branch.depth,
        user_message.id AS user_id,
        assistant_message.id AS assistant_id,
        128
          + octet_length(COALESCE(user_message.content -> 0 ->> 'text', ''))
          + octet_length(COALESCE(assistant_message.content -> 0 ->> 'text', ''))
          AS turn_bytes
      FROM branch AS assistant_branch
      INNER JOIN branch AS user_branch
        ON user_branch.depth = assistant_branch.depth + 1
       AND assistant_branch.parent_message_id = user_branch.id
      INNER JOIN messages AS assistant_message
        ON assistant_message.conversation_id = ${conversationId}::uuid
       AND assistant_message.id = assistant_branch.id
      INNER JOIN messages AS user_message
        ON user_message.conversation_id = ${conversationId}::uuid
       AND user_message.id = user_branch.id
      CROSS JOIN boundary
      WHERE assistant_branch.role = 'assistant'
        AND user_branch.role = 'user'
        AND assistant_branch.depth < boundary.depth
        AND user_branch.depth < boundary.depth
    ),
    numbered_turns AS (
      SELECT complete_turns.*,
        ROW_NUMBER() OVER (ORDER BY depth ASC) AS newest_rank
      FROM complete_turns
    ),
    recent_turns AS (
      SELECT * FROM numbered_turns
      WHERE newest_rank <= ${contextCompactionTuning.normalRecentTurns}
    ),
    source_ranked AS (
      SELECT numbered_turns.*,
        SUM(turn_bytes) OVER (ORDER BY depth DESC) AS accumulated_bytes
      FROM numbered_turns
      WHERE newest_rank > ${contextCompactionTuning.normalRecentTurns}
    ),
    source_selected AS (
      SELECT * FROM source_ranked
      WHERE accumulated_bytes <= ${maximumSourceBytes}
    )
    SELECT
      (SELECT branch_found FROM branch_state) AS "branchFound",
      (SELECT branch_valid FROM branch_state) AS "branchValid",
      (SELECT id FROM applicable) AS "previousCompactionId",
      (SELECT summary FROM applicable) AS "previousSummary",
      (SELECT through_message_id FROM applicable) AS "previousThroughMessageId",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'userId', recent.user_id,
          'userText', COALESCE(user_message.content -> 0 ->> 'text', ''),
          'assistantId', recent.assistant_id,
          'assistantText', COALESCE(assistant_message.content -> 0 ->> 'text', '')
        ) ORDER BY recent.depth DESC)
        FROM recent_turns AS recent
        INNER JOIN messages AS user_message
          ON user_message.conversation_id = ${conversationId}::uuid
         AND user_message.id = recent.user_id
        INNER JOIN messages AS assistant_message
          ON assistant_message.conversation_id = ${conversationId}::uuid
         AND assistant_message.id = recent.assistant_id
      ), '[]'::jsonb) AS "recentTurns",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'userId', source.user_id,
          'userText', COALESCE(user_message.content -> 0 ->> 'text', ''),
          'assistantId', source.assistant_id,
          'assistantText', COALESCE(assistant_message.content -> 0 ->> 'text', '')
        ) ORDER BY source.depth DESC)
        FROM source_selected AS source
        INNER JOIN messages AS user_message
          ON user_message.conversation_id = ${conversationId}::uuid
         AND user_message.id = source.user_id
        INNER JOIN messages AS assistant_message
          ON assistant_message.conversation_id = ${conversationId}::uuid
         AND assistant_message.id = source.assistant_id
      ), '[]'::jsonb) AS "sourceTurns",
      EXISTS (
        SELECT 1 FROM source_ranked
        WHERE accumulated_bytes > ${maximumSourceBytes}
      ) AS "sourceOverflow"
  `);
  const row = result.rows[0];
  if (row === undefined || !row.branchFound) {
    throw new Error("Selected conversation branch could not be reconstructed");
  }
  if (!row.branchValid) {
    throw new Error("Selected conversation branch must end in complete turns");
  }
  const previousCompaction =
    row.previousCompactionId === null ||
    row.previousSummary === null ||
    row.previousThroughMessageId === null
      ? null
      : Object.freeze({
          id: row.previousCompactionId,
          summary: row.previousSummary,
          throughMessageId: row.previousThroughMessageId,
        });
  const recentTurns = parseTurns(row.recentTurns, "Recent");
  const sourceTurns = parseTurns(row.sourceTurns, "Compaction source");
  if (recentTurns.length > contextCompactionTuning.normalRecentTurns) {
    throw new Error("Recent context window exceeded its bound");
  }
  return Object.freeze({
    previousCompaction,
    recentTurns,
    sourceOverflow: row.sourceOverflow,
    sourceTurns,
  });
}
