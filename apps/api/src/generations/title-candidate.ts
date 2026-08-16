import { sql } from "drizzle-orm";
import type { AppDatabaseExecutor } from "../database/database.js";

interface InitialTitleCandidateRow extends Record<string, unknown> {
  readonly candidate: boolean;
}

/**
 * True when the generation is the oldest assistant child of the oldest root prompt and the
 * conversation's one automatic naming opportunity is still pending.
 */
export async function isInitialTitleCandidate(
  executor: AppDatabaseExecutor,
  generationId: string,
): Promise<boolean> {
  const result = await executor.execute<InitialTitleCandidateRow>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM generations AS generation
      INNER JOIN conversations AS conversation ON conversation.id = generation.conversation_id
      INNER JOIN messages AS answer ON answer.id = generation.assistant_message_id
        AND answer.conversation_id = generation.conversation_id
      INNER JOIN messages AS prompt ON prompt.id = answer.parent_message_id
        AND prompt.conversation_id = generation.conversation_id
      WHERE generation.id = ${generationId}::uuid
        AND (generation.purpose IS NULL OR generation.purpose = 'chat')
        AND conversation.automatic_title_pending
        AND prompt.parent_message_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM messages AS earlier_root
          WHERE earlier_root.conversation_id = generation.conversation_id
            AND earlier_root.parent_message_id IS NULL
            AND (earlier_root.created_at, earlier_root.id) < (prompt.created_at, prompt.id)
        )
        AND NOT EXISTS (
          SELECT 1 FROM messages AS earlier_answer
          WHERE earlier_answer.conversation_id = generation.conversation_id
            AND earlier_answer.parent_message_id = prompt.id
            AND (earlier_answer.created_at, earlier_answer.id) < (answer.created_at, answer.id)
        )
    ) AS candidate
  `);
  return result.rows[0]?.candidate === true;
}
