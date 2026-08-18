DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "account"
		UNION ALL SELECT 1 FROM "answer_reports"
		UNION ALL SELECT 1 FROM "client_error_rate_limit_windows"
		UNION ALL SELECT 1 FROM "conversation_compactions"
		UNION ALL SELECT 1 FROM "conversations"
		UNION ALL SELECT 1 FROM "drafts"
		UNION ALL SELECT 1 FROM "employee_approvals"
		UNION ALL SELECT 1 FROM "generations"
		UNION ALL SELECT 1 FROM "messages"
		UNION ALL SELECT 1 FROM "model_catalog"
		UNION ALL SELECT 1 FROM "openrouter_privacy_attestations"
		UNION ALL SELECT 1 FROM "operational_recovery_markers"
		UNION ALL SELECT 1 FROM "production_initialization"
		UNION ALL SELECT 1 FROM "rate_limit"
		UNION ALL SELECT 1 FROM "session"
		UNION ALL SELECT 1 FROM "user"
		UNION ALL SELECT 1 FROM "verification"
		UNION ALL SELECT 1 FROM "workspace_catalog_approvals"
		UNION ALL SELECT 1 FROM "workspace_cost_policies"
		UNION ALL SELECT 1 FROM "workspace_memberships"
		UNION ALL SELECT 1 FROM "workspace_model_policies"
		UNION ALL SELECT 1 FROM "workspaces"
		LIMIT 1
	) THEN
		RAISE EXCEPTION
			'0009_workspace_behavior_controls requires an application-empty database'
			USING ERRCODE = '55000';
	END IF;
END
$$;
--> statement-breakpoint
CREATE TABLE "workspace_assistant_prompt_revisions" (
	"workspace_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"workspace_text" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" text,
	"actor_display_name" text,
	"change_kind" text NOT NULL,
	"reverted_from_revision" integer,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_assistant_prompt_revisions_workspace_revision_pk" PRIMARY KEY("workspace_id","revision"),
	CONSTRAINT "workspace_assistant_prompt_revisions_revision_check" CHECK ("workspace_assistant_prompt_revisions"."revision" > 0),
	CONSTRAINT "workspace_assistant_prompt_revisions_text_check" CHECK (char_length("workspace_assistant_prompt_revisions"."workspace_text") <= 3200
        AND octet_length("workspace_assistant_prompt_revisions"."workspace_text") <= 12800
        AND regexp_replace("workspace_assistant_prompt_revisions"."workspace_text", E'[\t\n]', '', 'g') !~ '[[:cntrl:]]'),
	CONSTRAINT "workspace_assistant_prompt_revisions_actor_check" CHECK ((
          "workspace_assistant_prompt_revisions"."actor_kind" = 'system'
          AND "workspace_assistant_prompt_revisions"."actor_user_id" IS NULL
          AND "workspace_assistant_prompt_revisions"."actor_display_name" IS NULL
        ) OR (
          "workspace_assistant_prompt_revisions"."actor_kind" = 'user'
          AND "workspace_assistant_prompt_revisions"."actor_user_id" IS NOT NULL
          AND "workspace_assistant_prompt_revisions"."actor_display_name" IS NOT NULL
          AND "workspace_assistant_prompt_revisions"."actor_display_name" ~ '[^[:space:]]'
        )),
	CONSTRAINT "workspace_assistant_prompt_revisions_attribution_check" CHECK ((
          "workspace_assistant_prompt_revisions"."actor_kind" = 'system'
          AND "workspace_assistant_prompt_revisions"."change_kind" = 'bootstrap'
        ) OR (
          "workspace_assistant_prompt_revisions"."actor_kind" = 'user'
          AND "workspace_assistant_prompt_revisions"."change_kind" <> 'bootstrap'
        )),
	CONSTRAINT "workspace_assistant_prompt_revisions_change_check" CHECK ((
          "workspace_assistant_prompt_revisions"."change_kind" IN ('bootstrap', 'save', 'reset')
          AND "workspace_assistant_prompt_revisions"."reverted_from_revision" IS NULL
        ) OR (
          "workspace_assistant_prompt_revisions"."change_kind" = 'revert'
          AND "workspace_assistant_prompt_revisions"."reverted_from_revision" IS NOT NULL
          AND "workspace_assistant_prompt_revisions"."reverted_from_revision" < "workspace_assistant_prompt_revisions"."revision"
        ))
);
--> statement-breakpoint
CREATE TABLE "workspace_assistant_prompts" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "workspace_assistant_prompts_revision_check" CHECK ("workspace_assistant_prompts"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_model_policy_revision_tiers" (
	"workspace_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"tier" text NOT NULL,
	"model_catalog_id" uuid NOT NULL,
	"enabled" boolean NOT NULL,
	"maximum_output_tokens" integer NOT NULL,
	"reasoning_effort" text NOT NULL,
	"reasoning_budget_tokens" integer NOT NULL,
	"temperature_preset" text NOT NULL,
	CONSTRAINT "workspace_model_policy_revision_tiers_workspace_revision_tier_pk" PRIMARY KEY("workspace_id","revision","tier"),
	CONSTRAINT "workspace_model_policy_revision_tiers_tier_check" CHECK ("workspace_model_policy_revision_tiers"."tier" IN ('fast', 'balanced', 'pro')),
	CONSTRAINT "workspace_model_policy_revision_tiers_controls_check" CHECK ("workspace_model_policy_revision_tiers"."maximum_output_tokens" > 0
        AND "workspace_model_policy_revision_tiers"."reasoning_effort" IN ('off', 'low', 'medium', 'high')
        AND "workspace_model_policy_revision_tiers"."reasoning_budget_tokens" IN (0, 1024, 2048, 4096, 8192)
        AND (
          ("workspace_model_policy_revision_tiers"."reasoning_effort" = 'off' AND "workspace_model_policy_revision_tiers"."reasoning_budget_tokens" = 0)
          OR (
            "workspace_model_policy_revision_tiers"."reasoning_effort" <> 'off'
            AND "workspace_model_policy_revision_tiers"."reasoning_budget_tokens" > 0
            AND "workspace_model_policy_revision_tiers"."reasoning_budget_tokens" <= "workspace_model_policy_revision_tiers"."maximum_output_tokens" - 1024
          )
        )
        AND "workspace_model_policy_revision_tiers"."temperature_preset" IN ('precise', 'balanced', 'flexible', 'creative'))
);
--> statement-breakpoint
CREATE TABLE "workspace_model_policy_revisions" (
	"workspace_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"default_tier" text NOT NULL,
	"monthly_budget_usd" numeric(38, 18) NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" text,
	"actor_display_name" text,
	"change_kind" text NOT NULL,
	"reverted_from_revision" integer,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_model_policy_revisions_workspace_revision_pk" PRIMARY KEY("workspace_id","revision"),
	CONSTRAINT "workspace_model_policy_revisions_revision_check" CHECK ("workspace_model_policy_revisions"."revision" > 0),
	CONSTRAINT "workspace_model_policy_revisions_values_check" CHECK ("workspace_model_policy_revisions"."default_tier" IN ('fast', 'balanced', 'pro')
        AND "workspace_model_policy_revisions"."monthly_budget_usd" >= 0),
	CONSTRAINT "workspace_model_policy_revisions_actor_check" CHECK ((
          "workspace_model_policy_revisions"."actor_kind" = 'system'
          AND "workspace_model_policy_revisions"."actor_user_id" IS NULL
          AND "workspace_model_policy_revisions"."actor_display_name" IS NULL
        ) OR (
          "workspace_model_policy_revisions"."actor_kind" = 'user'
          AND "workspace_model_policy_revisions"."actor_user_id" IS NOT NULL
          AND "workspace_model_policy_revisions"."actor_display_name" IS NOT NULL
          AND "workspace_model_policy_revisions"."actor_display_name" ~ '[^[:space:]]'
        )),
	CONSTRAINT "workspace_model_policy_revisions_attribution_check" CHECK ((
          "workspace_model_policy_revisions"."actor_kind" = 'system'
          AND "workspace_model_policy_revisions"."change_kind" = 'bootstrap'
        ) OR (
          "workspace_model_policy_revisions"."actor_kind" = 'user'
          AND "workspace_model_policy_revisions"."change_kind" <> 'bootstrap'
        )),
	CONSTRAINT "workspace_model_policy_revisions_change_check" CHECK ((
          "workspace_model_policy_revisions"."change_kind" IN ('bootstrap', 'update')
          AND "workspace_model_policy_revisions"."reverted_from_revision" IS NULL
        ) OR (
          "workspace_model_policy_revisions"."change_kind" = 'revert'
          AND "workspace_model_policy_revisions"."reverted_from_revision" IS NOT NULL
          AND "workspace_model_policy_revisions"."reverted_from_revision" < "workspace_model_policy_revisions"."revision"
        ))
);
--> statement-breakpoint
ALTER TABLE "generations" DROP CONSTRAINT "generations_system_prompt_version_check";--> statement-breakpoint
ALTER TABLE "production_initialization" DROP CONSTRAINT "production_initialization_schema_check";--> statement-breakpoint
ALTER TABLE "production_initialization" DROP CONSTRAINT "production_initialization_phase_check";--> statement-breakpoint
ALTER TABLE "model_catalog" DROP CONSTRAINT "model_catalog_array_metadata_check";--> statement-breakpoint
ALTER TABLE "workspace_model_policies" DROP CONSTRAINT "workspace_model_policies_output_limit_check";--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "model_policy_revision" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "workspace_prompt_revision" integer;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "temperature_supported" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "reasoning_mode" text NOT NULL;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "reasoning_effort_support_kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "reasoning_efforts" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "reasoning_default_effort" text;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "reasoning_default_enabled" boolean;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "reasoning_max_tokens_accepted" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "reasoning_mandatory" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "reasoning_trace_safety" text NOT NULL;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "reasoning_contract_source" text NOT NULL;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "reasoning_exclusion_verified_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "workspace_model_policies" ADD COLUMN "reasoning_effort" text NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_model_policies" ADD COLUMN "reasoning_budget_tokens" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_model_policies" ADD COLUMN "temperature_preset" text NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_assistant_prompt_revisions" ADD CONSTRAINT "workspace_assistant_prompt_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_assistant_prompt_revisions" ADD CONSTRAINT "workspace_assistant_prompt_revisions_actor_membership_fk" FOREIGN KEY ("workspace_id","actor_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_assistant_prompt_revisions" ADD CONSTRAINT "workspace_assistant_prompt_revisions_reverted_from_fk" FOREIGN KEY ("workspace_id","reverted_from_revision") REFERENCES "public"."workspace_assistant_prompt_revisions"("workspace_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_assistant_prompts" ADD CONSTRAINT "workspace_assistant_prompts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_assistant_prompts" ADD CONSTRAINT "workspace_assistant_prompts_revision_fk" FOREIGN KEY ("workspace_id","revision") REFERENCES "public"."workspace_assistant_prompt_revisions"("workspace_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_model_policy_revision_tiers" ADD CONSTRAINT "workspace_model_policy_revision_tiers_model_catalog_id_model_catalog_id_fk" FOREIGN KEY ("model_catalog_id") REFERENCES "public"."model_catalog"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_model_policy_revision_tiers" ADD CONSTRAINT "workspace_model_policy_revision_tiers_revision_fk" FOREIGN KEY ("workspace_id","revision") REFERENCES "public"."workspace_model_policy_revisions"("workspace_id","revision") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_model_policy_revisions" ADD CONSTRAINT "workspace_model_policy_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_model_policy_revisions" ADD CONSTRAINT "workspace_model_policy_revisions_actor_membership_fk" FOREIGN KEY ("workspace_id","actor_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_model_policy_revisions" ADD CONSTRAINT "workspace_model_policy_revisions_reverted_from_fk" FOREIGN KEY ("workspace_id","reverted_from_revision") REFERENCES "public"."workspace_model_policy_revisions"("workspace_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_model_policy_revision_tiers_catalog_idx" ON "workspace_model_policy_revision_tiers" USING btree ("model_catalog_id");--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_model_policy_revision_fk" FOREIGN KEY ("workspace_id","model_policy_revision") REFERENCES "public"."workspace_model_policy_revisions"("workspace_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_workspace_prompt_revision_fk" FOREIGN KEY ("workspace_id","workspace_prompt_revision") REFERENCES "public"."workspace_assistant_prompt_revisions"("workspace_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_cost_policies" ADD CONSTRAINT "workspace_cost_policies_revision_fk" FOREIGN KEY ("workspace_id","revision") REFERENCES "public"."workspace_model_policy_revisions"("workspace_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_system_prompt_version_check" CHECK ((
          "generations"."purpose" IS NOT NULL
          AND "generations"."purpose" = 'compaction'
          AND "generations"."system_prompt_version" = 'capstone-compaction-v1'
          AND "generations"."workspace_prompt_revision" IS NULL
        ) OR (
          "generations"."purpose" IS NOT NULL
          AND "generations"."purpose" = 'title'
          AND "generations"."system_prompt_version" = 'capstone-title-v1'
          AND "generations"."workspace_prompt_revision" IS NULL
        ) OR (
          ("generations"."purpose" IS NULL OR "generations"."purpose" = 'chat')
          AND "generations"."system_prompt_version" = 'capstone-chat-base-v2'
          AND "generations"."workspace_prompt_revision" IS NOT NULL
        ));--> statement-breakpoint
ALTER TABLE "production_initialization" ADD CONSTRAINT "production_initialization_schema_check" CHECK ("production_initialization"."schema_version" = 2);--> statement-breakpoint
ALTER TABLE "production_initialization" ADD CONSTRAINT "production_initialization_phase_check" CHECK ("production_initialization"."phase" IN ('claimed', 'complete'));--> statement-breakpoint
ALTER TABLE "model_catalog" ADD CONSTRAINT "model_catalog_reasoning_check" CHECK ("model_catalog"."reasoning_mode" IN ('none', 'optional', 'mandatory', 'unverified')
        AND "model_catalog"."reasoning_effort_support_kind" IN ('none', 'all', 'listed')
        AND (
          "model_catalog"."reasoning_effort_support_kind" <> 'listed'
          OR jsonb_array_length("model_catalog"."reasoning_efforts") > 0
        )
        AND (
          "model_catalog"."reasoning_default_effort" IS NULL
          OR "model_catalog"."reasoning_default_effort"
            IN ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')
        )
        AND "model_catalog"."reasoning_trace_safety"
          IN ('non_reasoning', 'provider_excluded', 'unverified')
        AND "model_catalog"."reasoning_contract_source" ~ '[^[:space:]]'
        AND (
          "model_catalog"."reasoning_mode" = 'none'
          AND "model_catalog"."reasoning_mandatory" = false
          AND "model_catalog"."reasoning_max_tokens_accepted" = false
          AND "model_catalog"."reasoning_trace_safety" = 'non_reasoning'
          AND "model_catalog"."reasoning_exclusion_verified_at" IS NULL
        OR
          "model_catalog"."reasoning_mode" IN ('optional', 'mandatory')
          AND "model_catalog"."reasoning_trace_safety" = 'provider_excluded'
          AND "model_catalog"."reasoning_exclusion_verified_at" IS NOT NULL
          AND "model_catalog"."reasoning_mandatory" = ("model_catalog"."reasoning_mode" = 'mandatory')
        OR
          "model_catalog"."reasoning_mode" = 'unverified'
          AND "model_catalog"."reasoning_trace_safety" = 'unverified'
          AND "model_catalog"."reasoning_exclusion_verified_at" IS NULL
        ));--> statement-breakpoint
ALTER TABLE "model_catalog" ADD CONSTRAINT "model_catalog_array_metadata_check" CHECK (jsonb_typeof("model_catalog"."input_modalities") = 'array'
        AND jsonb_typeof("model_catalog"."output_modalities") = 'array'
        AND jsonb_typeof("model_catalog"."supported_parameters") = 'array'
        AND jsonb_typeof("model_catalog"."reasoning_efforts") = 'array');--> statement-breakpoint
ALTER TABLE "workspace_model_policies" ADD CONSTRAINT "workspace_model_policies_controls_check" CHECK ("workspace_model_policies"."maximum_output_tokens" > 0
        AND "workspace_model_policies"."reasoning_effort" IN ('off', 'low', 'medium', 'high')
        AND "workspace_model_policies"."reasoning_budget_tokens" IN (0, 1024, 2048, 4096, 8192)
        AND (
          ("workspace_model_policies"."reasoning_effort" = 'off' AND "workspace_model_policies"."reasoning_budget_tokens" = 0)
          OR (
            "workspace_model_policies"."reasoning_effort" <> 'off'
            AND "workspace_model_policies"."reasoning_budget_tokens" > 0
            AND "workspace_model_policies"."reasoning_budget_tokens" <= "workspace_model_policies"."maximum_output_tokens" - 1024
          )
        )
        AND "workspace_model_policies"."temperature_preset" IN ('precise', 'balanced', 'flexible', 'creative'));