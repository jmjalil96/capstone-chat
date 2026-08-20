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
	CONSTRAINT "workspace_assistant_prompt_revisions_revision_check" CHECK ("revision" > 0),
	CONSTRAINT "workspace_assistant_prompt_revisions_text_check" CHECK (
		char_length("workspace_text") <= 3200
		AND octet_length("workspace_text") <= 12800
		AND regexp_replace("workspace_text", E'[\\t\\n]', '', 'g') !~ '[[:cntrl:]]'
	),
	CONSTRAINT "workspace_assistant_prompt_revisions_actor_check" CHECK (
		("actor_kind" = 'system' AND "actor_user_id" IS NULL AND "actor_display_name" IS NULL)
		OR (
			"actor_kind" = 'user'
			AND "actor_user_id" IS NOT NULL
			AND "actor_display_name" IS NOT NULL
			AND "actor_display_name" ~ '[^[:space:]]'
		)
	),
	CONSTRAINT "workspace_assistant_prompt_revisions_attribution_check" CHECK (
		("actor_kind" = 'system' AND "change_kind" IN ('bootstrap', 'migration'))
		OR ("actor_kind" = 'user' AND "change_kind" NOT IN ('bootstrap', 'migration'))
	),
	CONSTRAINT "workspace_assistant_prompt_revisions_change_check" CHECK (
		("change_kind" IN ('bootstrap', 'migration', 'save', 'reset') AND "reverted_from_revision" IS NULL)
		OR (
			"change_kind" = 'revert'
			AND "reverted_from_revision" IS NOT NULL
			AND "reverted_from_revision" < "revision"
		)
	)
);
--> statement-breakpoint
CREATE TABLE "workspace_assistant_prompts" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "workspace_assistant_prompts_revision_check" CHECK ("revision" > 0)
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
	CONSTRAINT "workspace_model_policy_revisions_revision_check" CHECK ("revision" > 0),
	CONSTRAINT "workspace_model_policy_revisions_values_check" CHECK (
		"default_tier" IN ('fast', 'balanced', 'pro') AND "monthly_budget_usd" >= 0
	),
	CONSTRAINT "workspace_model_policy_revisions_actor_check" CHECK (
		("actor_kind" = 'system' AND "actor_user_id" IS NULL AND "actor_display_name" IS NULL)
		OR (
			"actor_kind" = 'user'
			AND "actor_user_id" IS NOT NULL
			AND "actor_display_name" IS NOT NULL
			AND "actor_display_name" ~ '[^[:space:]]'
		)
	),
	CONSTRAINT "workspace_model_policy_revisions_attribution_check" CHECK (
		("actor_kind" = 'system' AND "change_kind" IN ('bootstrap', 'migration'))
		OR ("actor_kind" = 'user' AND "change_kind" NOT IN ('bootstrap', 'migration'))
	),
	CONSTRAINT "workspace_model_policy_revisions_change_check" CHECK (
		("change_kind" IN ('bootstrap', 'migration', 'update') AND "reverted_from_revision" IS NULL)
		OR (
			"change_kind" = 'revert'
			AND "reverted_from_revision" IS NOT NULL
			AND "reverted_from_revision" < "revision"
		)
	)
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
	CONSTRAINT "workspace_model_policy_revision_tiers_tier_check" CHECK ("tier" IN ('fast', 'balanced', 'pro')),
	CONSTRAINT "workspace_model_policy_revision_tiers_controls_check" CHECK (
		"maximum_output_tokens" > 0
		AND "reasoning_effort" IN ('off', 'low', 'medium', 'high')
		AND "reasoning_budget_tokens" IN (0, 1024, 2048, 4096, 8192)
		AND (
			("reasoning_effort" = 'off' AND "reasoning_budget_tokens" = 0)
			OR ("reasoning_effort" <> 'off' AND "reasoning_budget_tokens" > 0)
		)
		AND "temperature_preset" IN ('precise', 'balanced', 'flexible', 'creative')
	)
);
--> statement-breakpoint
ALTER TABLE "generations" DROP CONSTRAINT "generations_system_prompt_version_check";
--> statement-breakpoint
ALTER TABLE "model_catalog" DROP CONSTRAINT "model_catalog_array_metadata_check";
--> statement-breakpoint
ALTER TABLE "workspace_model_policies" DROP CONSTRAINT "workspace_model_policies_output_limit_check";
--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "behavior_contract_version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "model_policy_revision" integer;
--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "workspace_prompt_revision" integer;
--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "temperature_supported" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "reasoning_mode" text DEFAULT 'unverified' NOT NULL;
--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "reasoning_effort_support_kind" text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "reasoning_efforts" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "reasoning_default_effort" text;
--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "reasoning_default_enabled" boolean;
--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "reasoning_max_tokens_accepted" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "reasoning_mandatory" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "reasoning_trace_safety" text DEFAULT 'unverified' NOT NULL;
--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "reasoning_contract_source" text DEFAULT 'phase11-migration-unverified' NOT NULL;
--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "reasoning_exclusion_verified_at" timestamp (3) with time zone;
--> statement-breakpoint
ALTER TABLE "workspace_model_policies" ADD COLUMN "reasoning_effort" text DEFAULT 'off' NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspace_model_policies" ADD COLUMN "reasoning_budget_tokens" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspace_model_policies" ADD COLUMN "temperature_preset" text DEFAULT 'balanced' NOT NULL;
--> statement-breakpoint
UPDATE "model_catalog"
SET
	"available" = false,
	"reasoning_contract_source" = 'phase11-migration-unverified',
	"reasoning_default_effort" = NULL,
	"reasoning_default_enabled" = NULL,
	"reasoning_effort_support_kind" = 'none',
	"reasoning_efforts" = '[]'::jsonb,
	"reasoning_exclusion_verified_at" = NULL,
	"reasoning_mandatory" = false,
	"reasoning_max_tokens_accepted" = false,
	"reasoning_mode" = 'unverified',
	"reasoning_trace_safety" = 'unverified',
	"temperature_supported" = false
WHERE "metadata_source" = 'openrouter';
--> statement-breakpoint
UPDATE "model_catalog"
SET
	"available" = true,
	"reasoning_contract_source" = 'simulated',
	"reasoning_default_effort" = NULL,
	"reasoning_default_enabled" = NULL,
	"reasoning_effort_support_kind" = 'all',
	"reasoning_efforts" = '[]'::jsonb,
	"reasoning_exclusion_verified_at" = "validated_at",
	"reasoning_mandatory" = false,
	"reasoning_max_tokens_accepted" = true,
	"reasoning_mode" = 'optional',
	"reasoning_trace_safety" = 'provider_excluded',
	"supported_parameters" = '["max_tokens","reasoning","reasoning_effort","temperature"]'::jsonb,
	"temperature_supported" = true
WHERE "metadata_source" = 'simulated';
--> statement-breakpoint
UPDATE "workspace_model_policies"
SET
	"reasoning_effort" = CASE WHEN "tier" = 'pro' THEN 'high' ELSE 'off' END,
	"reasoning_budget_tokens" = CASE WHEN "tier" = 'pro' THEN 8192 ELSE 0 END,
	"temperature_preset" = CASE WHEN "tier" = 'fast' THEN 'precise' ELSE 'balanced' END;
--> statement-breakpoint
INSERT INTO "workspace_assistant_prompt_revisions" (
	"workspace_id", "revision", "workspace_text", "actor_kind", "change_kind", "created_at"
)
SELECT
	"id",
	1,
	'Eres el asistente interno de Capstone en Ecuador. Usa USD como moneda predeterminada y considera, cuando corresponda, la normativa del SRI, el IESS y el Código del Trabajo. Cuando no tengas una cifra exacta o información suficiente, dilo con claridad; nunca inventes datos financieros. Trata a las personas de «usted» salvo que pidan otro tratamiento.',
	'system',
	'migration',
	now()
FROM "workspaces";
--> statement-breakpoint
INSERT INTO "workspace_assistant_prompts" ("workspace_id", "revision")
SELECT "id", 1 FROM "workspaces";
--> statement-breakpoint
INSERT INTO "workspace_model_policy_revisions" (
	"workspace_id",
	"revision",
	"default_tier",
	"monthly_budget_usd",
	"actor_kind",
	"change_kind",
	"created_at"
)
SELECT
	"workspace_id",
	"revision",
	"default_tier",
	"monthly_budget_usd",
	'system',
	'migration',
	now()
FROM "workspace_cost_policies";
--> statement-breakpoint
INSERT INTO "workspace_model_policy_revision_tiers" (
	"workspace_id",
	"revision",
	"tier",
	"model_catalog_id",
	"enabled",
	"maximum_output_tokens",
	"reasoning_effort",
	"reasoning_budget_tokens",
	"temperature_preset"
)
SELECT
	policy."workspace_id",
	cost."revision",
	policy."tier",
	policy."model_catalog_id",
	policy."enabled",
	policy."maximum_output_tokens",
	policy."reasoning_effort",
	policy."reasoning_budget_tokens",
	policy."temperature_preset"
FROM "workspace_model_policies" AS policy
INNER JOIN "workspace_cost_policies" AS cost ON cost."workspace_id" = policy."workspace_id";
--> statement-breakpoint
ALTER TABLE "workspace_assistant_prompt_revisions" ADD CONSTRAINT "workspace_assistant_prompt_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_assistant_prompt_revisions" ADD CONSTRAINT "workspace_assistant_prompt_revisions_actor_membership_fk" FOREIGN KEY ("workspace_id","actor_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_assistant_prompt_revisions" ADD CONSTRAINT "workspace_assistant_prompt_revisions_reverted_from_fk" FOREIGN KEY ("workspace_id","reverted_from_revision") REFERENCES "public"."workspace_assistant_prompt_revisions"("workspace_id","revision") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_assistant_prompts" ADD CONSTRAINT "workspace_assistant_prompts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_assistant_prompts" ADD CONSTRAINT "workspace_assistant_prompts_revision_fk" FOREIGN KEY ("workspace_id","revision") REFERENCES "public"."workspace_assistant_prompt_revisions"("workspace_id","revision") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_model_policy_revisions" ADD CONSTRAINT "workspace_model_policy_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_model_policy_revisions" ADD CONSTRAINT "workspace_model_policy_revisions_actor_membership_fk" FOREIGN KEY ("workspace_id","actor_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_model_policy_revisions" ADD CONSTRAINT "workspace_model_policy_revisions_reverted_from_fk" FOREIGN KEY ("workspace_id","reverted_from_revision") REFERENCES "public"."workspace_model_policy_revisions"("workspace_id","revision") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_model_policy_revision_tiers" ADD CONSTRAINT "workspace_model_policy_revision_tiers_model_catalog_id_model_catalog_id_fk" FOREIGN KEY ("model_catalog_id") REFERENCES "public"."model_catalog"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_model_policy_revision_tiers" ADD CONSTRAINT "workspace_model_policy_revision_tiers_revision_fk" FOREIGN KEY ("workspace_id","revision") REFERENCES "public"."workspace_model_policy_revisions"("workspace_id","revision") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "workspace_model_policy_revision_tiers_catalog_idx" ON "workspace_model_policy_revision_tiers" USING btree ("model_catalog_id");
--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_model_policy_revision_fk" FOREIGN KEY ("workspace_id","model_policy_revision") REFERENCES "public"."workspace_model_policy_revisions"("workspace_id","revision") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_workspace_prompt_revision_fk" FOREIGN KEY ("workspace_id","workspace_prompt_revision") REFERENCES "public"."workspace_assistant_prompt_revisions"("workspace_id","revision") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_cost_policies" ADD CONSTRAINT "workspace_cost_policies_revision_fk" FOREIGN KEY ("workspace_id","revision") REFERENCES "public"."workspace_model_policy_revisions"("workspace_id","revision") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "model_catalog" ADD CONSTRAINT "model_catalog_reasoning_check" CHECK (
	"reasoning_mode" IN ('none', 'optional', 'mandatory', 'unverified')
	AND "reasoning_effort_support_kind" IN ('none', 'all', 'listed')
	AND ("reasoning_effort_support_kind" <> 'listed' OR jsonb_array_length("reasoning_efforts") > 0)
	AND (
		"reasoning_default_effort" IS NULL
		OR "reasoning_default_effort" IN ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')
	)
	AND "reasoning_trace_safety" IN ('non_reasoning', 'provider_excluded', 'unverified')
	AND "reasoning_contract_source" ~ '[^[:space:]]'
	AND (
		(
			"reasoning_mode" = 'none'
			AND "reasoning_mandatory" = false
			AND "reasoning_max_tokens_accepted" = false
			AND "reasoning_trace_safety" = 'non_reasoning'
			AND "reasoning_exclusion_verified_at" IS NULL
		)
		OR (
			"reasoning_mode" IN ('optional', 'mandatory')
			AND "reasoning_trace_safety" = 'provider_excluded'
			AND "reasoning_exclusion_verified_at" IS NOT NULL
			AND "reasoning_mandatory" = ("reasoning_mode" = 'mandatory')
		)
		OR (
			"reasoning_mode" = 'unverified'
			AND "reasoning_trace_safety" = 'unverified'
			AND "reasoning_exclusion_verified_at" IS NULL
		)
	)
);
--> statement-breakpoint
ALTER TABLE "model_catalog" ADD CONSTRAINT "model_catalog_array_metadata_check" CHECK (
	jsonb_typeof("input_modalities") = 'array'
	AND jsonb_typeof("output_modalities") = 'array'
	AND jsonb_typeof("supported_parameters") = 'array'
	AND jsonb_typeof("reasoning_efforts") = 'array'
);
--> statement-breakpoint
ALTER TABLE "workspace_model_policies" ADD CONSTRAINT "workspace_model_policies_controls_check" CHECK (
	"maximum_output_tokens" > 0
	AND "reasoning_effort" IN ('off', 'low', 'medium', 'high')
	AND "reasoning_budget_tokens" IN (0, 1024, 2048, 4096, 8192)
	AND (
		("reasoning_effort" = 'off' AND "reasoning_budget_tokens" = 0)
		OR ("reasoning_effort" <> 'off' AND "reasoning_budget_tokens" > 0)
	)
	AND "temperature_preset" IN ('precise', 'balanced', 'flexible', 'creative')
);
--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_system_prompt_version_check" CHECK (
	(
		"behavior_contract_version" = 1
		AND "model_policy_revision" IS NULL
		AND "workspace_prompt_revision" IS NULL
		AND (
			("purpose" = 'compaction' AND "system_prompt_version" = 'capstone-compaction-v1')
			OR ("purpose" = 'title' AND "system_prompt_version" = 'capstone-title-v1')
			OR (("purpose" IS NULL OR "purpose" = 'chat') AND "system_prompt_version" = 'capstone-chat-v1')
		)
	)
	OR (
		"behavior_contract_version" = 2
		AND "model_policy_revision" IS NOT NULL
		AND (
			("purpose" = 'compaction' AND "system_prompt_version" = 'capstone-compaction-v1' AND "workspace_prompt_revision" IS NULL)
			OR ("purpose" = 'title' AND "system_prompt_version" = 'capstone-title-v1' AND "workspace_prompt_revision" IS NULL)
			OR (("purpose" IS NULL OR "purpose" = 'chat') AND "system_prompt_version" = 'capstone-chat-base-v2' AND "workspace_prompt_revision" IS NOT NULL)
		)
	)
);
