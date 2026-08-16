CREATE TYPE "public"."answer_report_reason" AS ENUM('incorrect', 'outdated', 'incomplete', 'instructions_not_followed', 'unsafe', 'other');--> statement-breakpoint
ALTER TABLE "generations" DROP CONSTRAINT "generations_content_references_check";--> statement-breakpoint
ALTER TABLE "generations" DROP CONSTRAINT "generations_system_prompt_version_check";--> statement-breakpoint
ALTER TABLE "generations" DROP CONSTRAINT "generations_accounting_check";--> statement-breakpoint
ALTER TABLE "generations" DROP CONSTRAINT "generations_lifecycle_check";--> statement-breakpoint
DROP INDEX "public"."generations_active_conversation_unique";--> statement-breakpoint
DROP INDEX "generations_chat_workflow_conversation_unique";--> statement-breakpoint
ALTER TYPE "public"."generation_status" RENAME TO "generation_status_phase9";--> statement-breakpoint
CREATE TYPE "public"."generation_status" AS ENUM('preparing', 'active', 'finalizing', 'completed', 'cancelled', 'incomplete', 'failed');--> statement-breakpoint
ALTER TABLE "generations" ALTER COLUMN "status" TYPE "public"."generation_status" USING "status"::text::"public"."generation_status";--> statement-breakpoint
DROP TYPE "public"."generation_status_phase9";--> statement-breakpoint
CREATE UNIQUE INDEX "generations_active_conversation_unique" ON "generations" USING btree ("conversation_id") WHERE "generations"."status" = 'active' AND "generations"."conversation_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE "answer_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"generation_id" uuid NOT NULL,
	"assistant_message_id" uuid NOT NULL,
	"reason" "answer_report_reason" NOT NULL,
	"note" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answer_reports_note_check" CHECK ("answer_reports"."note" IS NULL OR ("answer_reports"."note" ~ '[^[:space:]]' AND char_length("answer_reports"."note") <= 1000))
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "automatic_title_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "automatic_title_pending" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "automatic_title_settled_revision" integer;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_automatic_title_settled_revision_check" CHECK ("conversations"."automatic_title_settled_revision" IS NULL OR (
	NOT "conversations"."automatic_title_pending"
	AND "conversations"."automatic_title_settled_revision" >= 0
	AND "conversations"."automatic_title_settled_revision" <= "conversations"."revision"
));--> statement-breakpoint
ALTER TABLE "answer_reports" ADD CONSTRAINT "answer_reports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_reports" ADD CONSTRAINT "answer_reports_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_reports" ADD CONSTRAINT "answer_reports_generation_id_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_reports" ADD CONSTRAINT "answer_reports_owned_conversation_fk" FOREIGN KEY ("workspace_id","user_id","conversation_id") REFERENCES "public"."conversations"("workspace_id","user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_reports" ADD CONSTRAINT "answer_reports_assistant_message_fk" FOREIGN KEY ("conversation_id","assistant_message_id") REFERENCES "public"."messages"("conversation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "answer_reports_generation_unique" ON "answer_reports" USING btree ("generation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "answer_reports_assistant_message_unique" ON "answer_reports" USING btree ("assistant_message_id");--> statement-breakpoint
CREATE INDEX "answer_reports_workspace_inbox_idx" ON "answer_reports" USING btree ("workspace_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "generations_title_conversation_unique" ON "generations" USING btree ("conversation_id") WHERE "generations"."purpose" = 'title' AND "generations"."conversation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "generations_finalizing_completed_idx" ON "generations" USING btree ("completed_at") WHERE "generations"."status" = 'finalizing';--> statement-breakpoint
CREATE UNIQUE INDEX "generations_chat_workflow_conversation_unique" ON "generations" USING btree ("conversation_id") WHERE "generations"."status" IN ('preparing', 'active', 'finalizing')
          AND "generations"."conversation_id" IS NOT NULL
          AND "generations"."assistant_message_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_content_references_check" CHECK (("generations"."conversation_id" IS NULL AND "generations"."assistant_message_id" IS NULL)
        OR (
          "generations"."conversation_id" IS NOT NULL
          AND "generations"."assistant_message_id" IS NOT NULL
          AND ("generations"."purpose" IS NULL OR "generations"."purpose" = 'chat')
        )
        OR (
          "generations"."conversation_id" IS NOT NULL
          AND "generations"."assistant_message_id" IS NULL
          AND "generations"."purpose" IS NOT NULL
          AND "generations"."purpose" IN ('compaction', 'title')
        ));--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_system_prompt_version_check" CHECK ((
          "generations"."purpose" IS NOT NULL
          AND "generations"."purpose" = 'compaction'
          AND "generations"."system_prompt_version" = 'capstone-compaction-v1'
        ) OR (
          "generations"."purpose" IS NOT NULL
          AND "generations"."purpose" = 'title'
          AND "generations"."system_prompt_version" = 'capstone-title-v1'
        ) OR (
          ("generations"."purpose" IS NULL OR "generations"."purpose" = 'chat')
          AND "generations"."system_prompt_version" = 'capstone-chat-v1'
        ));--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_accounting_check" CHECK ((
          "generations"."accounting_status" IS NULL
          AND (
            "generations"."purpose" IS NULL
            OR "generations"."purpose" IN ('chat', 'compaction', 'title')
          )
          AND "generations"."requested_model" IS NULL
          AND "generations"."resolved_model" IS NULL
          AND "generations"."provider" IS NULL
          AND "generations"."openrouter_generation_id" IS NULL
          AND "generations"."prompt_tokens" IS NULL
          AND "generations"."completion_tokens" IS NULL
          AND "generations"."reasoning_tokens" IS NULL
          AND "generations"."cached_tokens" IS NULL
          AND "generations"."cost_usd" IS NULL
          AND "generations"."cost_basis" IS NULL
          AND "generations"."estimated_input_tokens" IS NULL
          AND "generations"."maximum_output_tokens" IS NULL
          AND "generations"."reserved_cost_usd" IS NULL
          AND "generations"."prompt_price_ceiling_per_token" IS NULL
          AND "generations"."completion_price_ceiling_per_token" IS NULL
          AND "generations"."request_price_ceiling_usd" IS NULL
          AND "generations"."reservation_margin_basis_points" IS NULL
          AND "generations"."budget_period_start" IS NULL
          AND "generations"."budget_period_end" IS NULL
          AND "generations"."reservation_expires_at" IS NULL
          AND "generations"."accounting_settled_at" IS NULL
        ) OR (
          "generations"."accounting_status" IS NOT NULL
          AND "generations"."accounting_status" IN ('reserved', 'actual', 'estimated')
          AND "generations"."purpose" IS NOT NULL
          AND "generations"."purpose" IN ('chat', 'compaction', 'title')
          AND "generations"."requested_model" IS NOT NULL
          AND "generations"."requested_model" ~ '[^[:space:]]'
          AND "generations"."resolved_model" IS NOT NULL
          AND "generations"."resolved_model" ~ '[^[:space:]]'
          AND "generations"."estimated_input_tokens" IS NOT NULL
          AND "generations"."estimated_input_tokens" >= 0
          AND "generations"."maximum_output_tokens" IS NOT NULL
          AND "generations"."maximum_output_tokens" > 0
          AND "generations"."reserved_cost_usd" IS NOT NULL
          AND "generations"."reserved_cost_usd" >= 0
          AND "generations"."prompt_price_ceiling_per_token" IS NOT NULL
          AND "generations"."prompt_price_ceiling_per_token" >= 0
          AND "generations"."completion_price_ceiling_per_token" IS NOT NULL
          AND "generations"."completion_price_ceiling_per_token" >= 0
          AND "generations"."request_price_ceiling_usd" IS NOT NULL
          AND "generations"."request_price_ceiling_usd" >= 0
          AND "generations"."reservation_margin_basis_points" IS NOT NULL
          AND "generations"."reservation_margin_basis_points" >= 0
          AND "generations"."budget_period_start" IS NOT NULL
          AND "generations"."budget_period_end" IS NOT NULL
          AND "generations"."budget_period_start" < "generations"."budget_period_end"
          AND "generations"."reservation_expires_at" IS NOT NULL
          AND "generations"."reservation_expires_at" > "generations"."started_at"
          AND (
            "generations"."accounting_status" = 'reserved'
            AND "generations"."cost_usd" IS NULL
            AND "generations"."cost_basis" IS NULL
            AND "generations"."accounting_settled_at" IS NULL
          OR
            "generations"."accounting_status" IN ('actual', 'estimated')
            AND "generations"."cost_usd" IS NOT NULL
            AND "generations"."cost_usd" >= 0
            AND "generations"."cost_basis" IS NOT NULL
            AND "generations"."cost_basis" = "generations"."accounting_status"
            AND "generations"."accounting_settled_at" IS NOT NULL
          )
        ));--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_lifecycle_check" CHECK ((
          "generations"."status" = 'preparing'
          AND "generations"."purpose" IS NOT NULL
          AND "generations"."purpose" = 'chat'
          AND "generations"."terminal_reason" IS NULL
          AND "generations"."error_code" IS NULL
          AND "generations"."first_token_at" IS NULL
          AND "generations"."completed_at" IS NULL
          AND "generations"."conversation_id" IS NOT NULL
          AND "generations"."assistant_message_id" IS NOT NULL
        ) OR (
          "generations"."status" = 'active'
          AND "generations"."terminal_reason" IS NULL
          AND "generations"."error_code" IS NULL
          AND "generations"."completed_at" IS NULL
          AND "generations"."conversation_id" IS NOT NULL
          AND (
            (
              "generations"."assistant_message_id" IS NOT NULL
              AND ("generations"."purpose" IS NULL OR "generations"."purpose" = 'chat')
            )
            OR (
              "generations"."assistant_message_id" IS NULL
              AND "generations"."purpose" IS NOT NULL
              AND "generations"."purpose" IN ('compaction', 'title')
            )
          )
        ) OR (
          "generations"."status" = 'finalizing'
          AND "generations"."purpose" IS NOT NULL
          AND "generations"."purpose" = 'chat'
          AND "generations"."terminal_reason" IS NOT NULL
          AND "generations"."terminal_reason" IN ('stop', 'length')
          AND "generations"."error_code" IS NULL
          AND "generations"."completed_at" IS NOT NULL
          AND "generations"."conversation_id" IS NOT NULL
          AND "generations"."assistant_message_id" IS NOT NULL
        ) OR (
          "generations"."status" = 'completed'
          AND "generations"."terminal_reason" IS NOT NULL
          AND "generations"."terminal_reason" IN ('stop', 'length', 'refusal', 'content_filter')
          AND "generations"."error_code" IS NULL
          AND "generations"."completed_at" IS NOT NULL
        ) OR (
          "generations"."status" = 'cancelled'
          AND "generations"."terminal_reason" IS NOT NULL
          AND "generations"."terminal_reason" = 'cancelled'
          AND "generations"."error_code" IS NULL
          AND "generations"."completed_at" IS NOT NULL
        ) OR (
          "generations"."status" IN ('incomplete', 'failed')
          AND "generations"."terminal_reason" IS NOT NULL
          AND "generations"."terminal_reason" = 'error'
          AND "generations"."error_code" IS NOT NULL
          AND "generations"."error_code" IN (
            'EMPTY_RESPONSE',
            'GENERATION_FAILED',
            'GENERATION_TIMEOUT',
            'MODEL_UNAVAILABLE',
            'STREAM_INTERRUPTED'
          )
          AND "generations"."completed_at" IS NOT NULL
        ));
