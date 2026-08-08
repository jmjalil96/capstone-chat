CREATE TABLE "model_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"openrouter_model_id" text NOT NULL,
	"display_name" text NOT NULL,
	"canonical_slug" text,
	"input_modalities" jsonb NOT NULL,
	"output_modalities" jsonb NOT NULL,
	"supported_parameters" jsonb NOT NULL,
	"context_length" integer NOT NULL,
	"maximum_output_tokens" integer NOT NULL,
	"prompt_price_per_token" numeric(38, 24) NOT NULL,
	"completion_price_per_token" numeric(38, 24) NOT NULL,
	"request_price_usd" numeric(38, 18) NOT NULL,
	"metadata_source" text NOT NULL,
	"approved" boolean DEFAULT true NOT NULL,
	"available" boolean NOT NULL,
	"validated_at" timestamp (3) with time zone NOT NULL,
	"refresh_attempted_at" timestamp (3) with time zone,
	"refresh_lease_owner" uuid,
	"refresh_lease_expires_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_catalog_nonempty_text_check" CHECK ("model_catalog"."openrouter_model_id" ~ '[^[:space:]]'
        AND "model_catalog"."display_name" ~ '[^[:space:]]'
        AND ("model_catalog"."canonical_slug" IS NULL OR "model_catalog"."canonical_slug" ~ '[^[:space:]]')),
	CONSTRAINT "model_catalog_array_metadata_check" CHECK (jsonb_typeof("model_catalog"."input_modalities") = 'array'
        AND jsonb_typeof("model_catalog"."output_modalities") = 'array'
        AND jsonb_typeof("model_catalog"."supported_parameters") = 'array'),
	CONSTRAINT "model_catalog_limits_check" CHECK ("model_catalog"."context_length" > 0
        AND "model_catalog"."maximum_output_tokens" > 0
        AND "model_catalog"."maximum_output_tokens" <= "model_catalog"."context_length"),
	CONSTRAINT "model_catalog_prices_check" CHECK ("model_catalog"."prompt_price_per_token" >= 0
        AND "model_catalog"."completion_price_per_token" >= 0
        AND "model_catalog"."request_price_usd" >= 0),
	CONSTRAINT "model_catalog_source_check" CHECK ("model_catalog"."metadata_source" IN ('openrouter', 'simulated')),
	CONSTRAINT "model_catalog_refresh_lease_check" CHECK (("model_catalog"."refresh_lease_owner" IS NULL AND "model_catalog"."refresh_lease_expires_at" IS NULL)
        OR ("model_catalog"."refresh_lease_owner" IS NOT NULL AND "model_catalog"."refresh_lease_expires_at" IS NOT NULL)),
	CONSTRAINT "model_catalog_timestamps_check" CHECK ("model_catalog"."updated_at" >= "model_catalog"."created_at"
        AND "model_catalog"."updated_at" >= "model_catalog"."validated_at"
        AND ("model_catalog"."refresh_attempted_at" IS NULL
          OR ("model_catalog"."refresh_attempted_at" >= "model_catalog"."validated_at"
            AND "model_catalog"."updated_at" >= "model_catalog"."refresh_attempted_at")))
);
--> statement-breakpoint
CREATE TABLE "openrouter_privacy_attestations" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"attestation_version" text NOT NULL,
	"verified_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openrouter_privacy_attestations_version_check" CHECK ("openrouter_privacy_attestations"."attestation_version" = 'openrouter-privacy-v1'),
	CONSTRAINT "openrouter_privacy_attestations_timestamps_check" CHECK ("openrouter_privacy_attestations"."updated_at" >= "openrouter_privacy_attestations"."created_at"
        AND "openrouter_privacy_attestations"."updated_at" >= "openrouter_privacy_attestations"."verified_at")
);
--> statement-breakpoint
CREATE TABLE "workspace_cost_policies" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"monthly_budget_usd" numeric(38, 18) NOT NULL,
	"default_tier" text NOT NULL,
	"employee_active_generation_limit" integer NOT NULL,
	"reservation_margin_basis_points" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_cost_policies_budget_check" CHECK ("workspace_cost_policies"."monthly_budget_usd" >= 0),
	CONSTRAINT "workspace_cost_policies_default_tier_check" CHECK ("workspace_cost_policies"."default_tier" IN ('fast', 'balanced', 'pro')),
	CONSTRAINT "workspace_cost_policies_generation_limit_check" CHECK ("workspace_cost_policies"."employee_active_generation_limit" > 0),
	CONSTRAINT "workspace_cost_policies_margin_check" CHECK ("workspace_cost_policies"."reservation_margin_basis_points" >= 0
        AND "workspace_cost_policies"."reservation_margin_basis_points" <= 1000000),
	CONSTRAINT "workspace_cost_policies_timestamps_check" CHECK ("workspace_cost_policies"."updated_at" >= "workspace_cost_policies"."created_at")
);
--> statement-breakpoint
CREATE TABLE "workspace_model_policies" (
	"workspace_id" uuid NOT NULL,
	"tier" text NOT NULL,
	"model_catalog_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"maximum_output_tokens" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_model_policies_workspace_tier_pk" PRIMARY KEY("workspace_id","tier"),
	CONSTRAINT "workspace_model_policies_tier_check" CHECK ("workspace_model_policies"."tier" IN ('fast', 'balanced', 'pro')),
	CONSTRAINT "workspace_model_policies_output_limit_check" CHECK ("workspace_model_policies"."maximum_output_tokens" > 0),
	CONSTRAINT "workspace_model_policies_timestamps_check" CHECK ("workspace_model_policies"."updated_at" >= "workspace_model_policies"."created_at")
);
--> statement-breakpoint
ALTER TABLE "generations" DROP CONSTRAINT "generations_requested_tier_check";--> statement-breakpoint
ALTER TABLE "generations" DROP CONSTRAINT "generations_effective_parameters_check";--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "preferred_tier" text DEFAULT 'balanced' NOT NULL;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "requested_model" text;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "resolved_model" text;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "openrouter_generation_id" text;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "prompt_tokens" bigint;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "completion_tokens" bigint;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "reasoning_tokens" bigint;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "cached_tokens" bigint;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "cost_usd" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "cost_basis" text;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "accounting_status" text;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "estimated_input_tokens" bigint;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "maximum_output_tokens" integer;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "reserved_cost_usd" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "prompt_price_ceiling_per_token" numeric(38, 24);--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "completion_price_ceiling_per_token" numeric(38, 24);--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "request_price_ceiling_usd" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "reservation_margin_basis_points" integer;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "budget_period_start" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "budget_period_end" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "reservation_expires_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "accounting_settled_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "openrouter_privacy_attestations" ADD CONSTRAINT "openrouter_privacy_attestations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_cost_policies" ADD CONSTRAINT "workspace_cost_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_model_policies" ADD CONSTRAINT "workspace_model_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_model_policies" ADD CONSTRAINT "workspace_model_policies_model_catalog_id_model_catalog_id_fk" FOREIGN KEY ("model_catalog_id") REFERENCES "public"."model_catalog"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_catalog_openrouter_model_id_unique" ON "model_catalog" USING btree ("openrouter_model_id");--> statement-breakpoint
CREATE INDEX "model_catalog_refresh_lease_idx" ON "model_catalog" USING btree ("refresh_lease_expires_at");--> statement-breakpoint
CREATE INDEX "workspace_model_policies_catalog_idx" ON "workspace_model_policies" USING btree ("model_catalog_id");--> statement-breakpoint
CREATE UNIQUE INDEX "generations_openrouter_generation_id_unique" ON "generations" USING btree ("openrouter_generation_id") WHERE "generations"."openrouter_generation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "generations_workspace_budget_period_idx" ON "generations" USING btree ("workspace_id","budget_period_start","accounting_status");--> statement-breakpoint
CREATE INDEX "generations_reserved_expiry_idx" ON "generations" USING btree ("reservation_expires_at","id") WHERE "generations"."accounting_status" = 'reserved';--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_preferred_tier_check" CHECK ("conversations"."preferred_tier" IN ('fast', 'balanced', 'pro'));--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_accounting_check" CHECK ((
          "generations"."accounting_status" IS NULL
          AND "generations"."purpose" IS NULL
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
ALTER TABLE "generations" ADD CONSTRAINT "generations_token_counts_check" CHECK (("generations"."prompt_tokens" IS NULL OR "generations"."prompt_tokens" >= 0)
        AND ("generations"."completion_tokens" IS NULL OR "generations"."completion_tokens" >= 0)
        AND ("generations"."reasoning_tokens" IS NULL OR "generations"."reasoning_tokens" >= 0)
        AND ("generations"."cached_tokens" IS NULL OR "generations"."cached_tokens" >= 0));--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_requested_tier_check" CHECK ("generations"."requested_tier" IN ('fast', 'balanced', 'pro'));--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_effective_parameters_check" CHECK (jsonb_typeof("generations"."effective_parameters") = 'object');
