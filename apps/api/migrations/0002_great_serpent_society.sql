CREATE TYPE "public"."generation_status" AS ENUM('active', 'completed', 'cancelled', 'incomplete', 'failed');--> statement-breakpoint
CREATE TYPE "public"."generation_terminal_reason" AS ENUM('stop', 'length', 'refusal', 'content_filter', 'cancelled', 'error');--> statement-breakpoint
CREATE TABLE "generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" uuid,
	"assistant_message_id" uuid,
	"idempotency_key" uuid NOT NULL,
	"requested_tier" text NOT NULL,
	"system_prompt_version" text NOT NULL,
	"effective_parameters" jsonb NOT NULL,
	"status" "generation_status" NOT NULL,
	"terminal_reason" "generation_terminal_reason",
	"error_code" text,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"first_token_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generations_content_references_check" CHECK (("generations"."conversation_id" IS NULL AND "generations"."assistant_message_id" IS NULL)
        OR ("generations"."conversation_id" IS NOT NULL AND "generations"."assistant_message_id" IS NOT NULL)),
	CONSTRAINT "generations_requested_tier_check" CHECK ("generations"."requested_tier" = 'balanced'),
	CONSTRAINT "generations_system_prompt_version_check" CHECK ("generations"."system_prompt_version" = 'capstone-chat-v1'),
	CONSTRAINT "generations_effective_parameters_check" CHECK (jsonb_typeof("generations"."effective_parameters") = 'object'
        AND "generations"."effective_parameters" = '{}'::jsonb),
	CONSTRAINT "generations_lifecycle_check" CHECK ((
          "generations"."status" = 'active'
          AND "generations"."terminal_reason" IS NULL
          AND "generations"."error_code" IS NULL
          AND "generations"."completed_at" IS NULL
          AND "generations"."conversation_id" IS NOT NULL
          AND "generations"."assistant_message_id" IS NOT NULL
        ) OR (
          "generations"."status" = 'completed'
          AND "generations"."terminal_reason" IN ('stop', 'length', 'refusal', 'content_filter')
          AND "generations"."error_code" IS NULL
          AND "generations"."completed_at" IS NOT NULL
        ) OR (
          "generations"."status" = 'cancelled'
          AND "generations"."terminal_reason" = 'cancelled'
          AND "generations"."error_code" IS NULL
          AND "generations"."completed_at" IS NOT NULL
        ) OR (
          "generations"."status" IN ('incomplete', 'failed')
          AND "generations"."terminal_reason" = 'error'
          AND "generations"."error_code" IN (
            'EMPTY_RESPONSE',
            'GENERATION_FAILED',
            'GENERATION_TIMEOUT',
            'MODEL_UNAVAILABLE',
            'STREAM_INTERRUPTED'
          )
          AND "generations"."completed_at" IS NOT NULL
        )),
	CONSTRAINT "generations_timestamps_check" CHECK ("generations"."started_at" >= "generations"."created_at"
        AND ("generations"."first_token_at" IS NULL OR "generations"."first_token_at" >= "generations"."started_at")
        AND ("generations"."completed_at" IS NULL OR "generations"."completed_at" >= "generations"."started_at")
        AND ("generations"."completed_at" IS NULL OR "generations"."first_token_at" IS NULL
          OR "generations"."completed_at" >= "generations"."first_token_at")
        AND "generations"."updated_at" >= "generations"."created_at"
        AND "generations"."updated_at" >= "generations"."started_at"
        AND ("generations"."first_token_at" IS NULL OR "generations"."updated_at" >= "generations"."first_token_at")
        AND ("generations"."completed_at" IS NULL OR "generations"."updated_at" >= "generations"."completed_at"))
);
--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_owned_conversation_fk" FOREIGN KEY ("workspace_id","user_id","conversation_id") REFERENCES "public"."conversations"("workspace_id","user_id","id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_assistant_message_fk" FOREIGN KEY ("conversation_id","assistant_message_id") REFERENCES "public"."messages"("conversation_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "generations_scoped_idempotency_unique" ON "generations" USING btree ("workspace_id","user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "generations_assistant_message_unique" ON "generations" USING btree ("assistant_message_id") WHERE "generations"."assistant_message_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "generations_active_conversation_unique" ON "generations" USING btree ("conversation_id") WHERE "generations"."status" = 'active' AND "generations"."conversation_id" IS NOT NULL;
