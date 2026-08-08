CREATE TYPE "public"."conversation_compaction_status" AS ENUM('active', 'completed', 'failed', 'cancelled', 'incomplete');--> statement-breakpoint
DROP INDEX "public"."generations_active_conversation_unique";--> statement-breakpoint
ALTER TABLE "generations" DROP CONSTRAINT "generations_lifecycle_check";--> statement-breakpoint
ALTER TYPE "public"."generation_status" RENAME TO "generation_status_phase6";--> statement-breakpoint
CREATE TYPE "public"."generation_status" AS ENUM('preparing', 'active', 'completed', 'cancelled', 'incomplete', 'failed');--> statement-breakpoint
ALTER TABLE "generations" ALTER COLUMN "status" TYPE "public"."generation_status" USING "status"::text::"public"."generation_status";--> statement-breakpoint
DROP TYPE "public"."generation_status_phase6";--> statement-breakpoint
CREATE UNIQUE INDEX "generations_active_conversation_unique" ON "generations" USING btree ("conversation_id") WHERE "generations"."status" = 'active' AND "generations"."conversation_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE "conversation_compactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"through_message_id" uuid NOT NULL,
	"previous_compaction_id" uuid,
	"generation_id" uuid NOT NULL,
	"summary" text,
	"source_token_count" bigint,
	"summary_token_count" bigint,
	"model_used" text NOT NULL,
	"prompt_version" text NOT NULL,
	"status" "conversation_compaction_status" NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp (3) with time zone,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_compactions_conversation_id_id_unique" UNIQUE("conversation_id","id"),
	CONSTRAINT "conversation_compactions_previous_not_self_check" CHECK ("conversation_compactions"."previous_compaction_id" IS NULL OR "conversation_compactions"."previous_compaction_id" <> "conversation_compactions"."id"),
	CONSTRAINT "conversation_compactions_nonempty_text_check" CHECK ("conversation_compactions"."model_used" ~ '[^[:space:]]'
        AND "conversation_compactions"."prompt_version" = 'capstone-compaction-v1'),
	CONSTRAINT "conversation_compactions_lifecycle_check" CHECK ((
          "conversation_compactions"."status" = 'active'
          AND "conversation_compactions"."summary" IS NULL
          AND "conversation_compactions"."source_token_count" IS NULL
          AND "conversation_compactions"."summary_token_count" IS NULL
          AND "conversation_compactions"."completed_at" IS NULL
        ) OR (
          "conversation_compactions"."status" = 'completed'
          AND "conversation_compactions"."summary" IS NOT NULL
          AND "conversation_compactions"."summary" ~ '[^[:space:]]'
          AND "conversation_compactions"."source_token_count" IS NOT NULL
          AND "conversation_compactions"."source_token_count" >= 0
          AND "conversation_compactions"."summary_token_count" IS NOT NULL
          AND "conversation_compactions"."summary_token_count" >= 0
          AND "conversation_compactions"."completed_at" IS NOT NULL
        ) OR (
          "conversation_compactions"."status" IN ('failed', 'cancelled', 'incomplete')
          AND "conversation_compactions"."summary" IS NULL
          AND "conversation_compactions"."source_token_count" IS NULL
          AND "conversation_compactions"."summary_token_count" IS NULL
          AND "conversation_compactions"."completed_at" IS NOT NULL
        )),
	CONSTRAINT "conversation_compactions_timestamps_check" CHECK ("conversation_compactions"."updated_at" >= "conversation_compactions"."created_at"
        AND ("conversation_compactions"."completed_at" IS NULL OR "conversation_compactions"."completed_at" >= "conversation_compactions"."created_at")
        AND ("conversation_compactions"."completed_at" IS NULL OR "conversation_compactions"."updated_at" >= "conversation_compactions"."completed_at"))
);
--> statement-breakpoint
CREATE TABLE "workspace_catalog_approvals" (
	"workspace_id" uuid NOT NULL,
	"model_catalog_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_catalog_approvals_workspace_catalog_pk" PRIMARY KEY("workspace_id","model_catalog_id")
);
--> statement-breakpoint
ALTER TABLE "generations" DROP CONSTRAINT "generations_content_references_check";--> statement-breakpoint
ALTER TABLE "generations" DROP CONSTRAINT "generations_system_prompt_version_check";--> statement-breakpoint
ALTER TABLE "generations" DROP CONSTRAINT "generations_accounting_check";--> statement-breakpoint
ALTER TABLE "workspace_memberships" ADD COLUMN "monthly_soft_budget_usd" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "workspace_cost_policies" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_compactions" ADD CONSTRAINT "conversation_compactions_generation_id_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."generations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_compactions" ADD CONSTRAINT "conversation_compactions_owned_conversation_fk" FOREIGN KEY ("workspace_id","user_id","conversation_id") REFERENCES "public"."conversations"("workspace_id","user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_compactions" ADD CONSTRAINT "conversation_compactions_through_message_fk" FOREIGN KEY ("conversation_id","through_message_id") REFERENCES "public"."messages"("conversation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_compactions" ADD CONSTRAINT "conversation_compactions_previous_compaction_fk" FOREIGN KEY ("conversation_id","previous_compaction_id") REFERENCES "public"."conversation_compactions"("conversation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_catalog_approvals" ADD CONSTRAINT "workspace_catalog_approvals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_catalog_approvals" ADD CONSTRAINT "workspace_catalog_approvals_model_catalog_id_model_catalog_id_fk" FOREIGN KEY ("model_catalog_id") REFERENCES "public"."model_catalog"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
INSERT INTO "workspace_catalog_approvals" ("workspace_id", "model_catalog_id", "created_at")
SELECT "workspace_id", "model_catalog_id", min("created_at")
FROM "workspace_model_policies"
GROUP BY "workspace_id", "model_catalog_id"
ON CONFLICT ("workspace_id", "model_catalog_id") DO NOTHING;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_compactions_generation_unique" ON "conversation_compactions" USING btree ("generation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_compactions_completed_boundary_unique" ON "conversation_compactions" USING btree ("conversation_id","through_message_id","prompt_version") WHERE "conversation_compactions"."status" = 'completed';--> statement-breakpoint
CREATE INDEX "conversation_compactions_conversation_status_idx" ON "conversation_compactions" USING btree ("conversation_id","status","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "conversation_compactions_previous_idx" ON "conversation_compactions" USING btree ("conversation_id","previous_compaction_id");--> statement-breakpoint
CREATE INDEX "workspace_catalog_approvals_catalog_idx" ON "workspace_catalog_approvals" USING btree ("model_catalog_id");--> statement-breakpoint
CREATE UNIQUE INDEX "generations_chat_workflow_conversation_unique" ON "generations" USING btree ("conversation_id") WHERE "generations"."status" IN ('preparing', 'active')
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
          AND "generations"."purpose" = 'compaction'
        ));--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_system_prompt_version_check" CHECK ((
          "generations"."purpose" IS NOT NULL
          AND "generations"."purpose" = 'compaction'
          AND "generations"."system_prompt_version" = 'capstone-compaction-v1'
        ) OR (
          ("generations"."purpose" IS NULL OR "generations"."purpose" = 'chat')
          AND "generations"."system_prompt_version" = 'capstone-chat-v1'
        ));--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_accounting_check" CHECK ((
          "generations"."accounting_status" IS NULL
          AND (
            "generations"."purpose" IS NULL
            OR "generations"."purpose" = 'chat'
            OR "generations"."purpose" = 'compaction'
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
          AND "generations"."purpose" IN ('chat', 'compaction')
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
              AND "generations"."purpose" = 'compaction'
            )
          )
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
        ));--> statement-breakpoint
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_soft_budget_check" CHECK ("workspace_memberships"."monthly_soft_budget_usd" IS NULL OR "workspace_memberships"."monthly_soft_budget_usd" >= 0);--> statement-breakpoint
ALTER TABLE "workspace_cost_policies" ADD CONSTRAINT "workspace_cost_policies_revision_check" CHECK ("workspace_cost_policies"."revision" > 0);
