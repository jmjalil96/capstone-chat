CREATE TABLE "production_initialization" (
	"singleton_id" integer PRIMARY KEY NOT NULL,
	"schema_version" integer NOT NULL,
	"document_sha256" text NOT NULL,
	"phase" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp (3) with time zone,
	CONSTRAINT "production_initialization_singleton_check" CHECK ("production_initialization"."singleton_id" = 1),
	CONSTRAINT "production_initialization_schema_check" CHECK ("production_initialization"."schema_version" = 1),
	CONSTRAINT "production_initialization_hash_check" CHECK ("production_initialization"."document_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "production_initialization_phase_check" CHECK ("production_initialization"."phase" IN ('claimed', 'identity-complete', 'complete')),
	CONSTRAINT "production_initialization_lifecycle_check" CHECK (("production_initialization"."phase" = 'complete' AND "production_initialization"."completed_at" IS NOT NULL)
        OR ("production_initialization"."phase" <> 'complete' AND "production_initialization"."completed_at" IS NULL)),
	CONSTRAINT "production_initialization_timestamps_check" CHECK ("production_initialization"."updated_at" >= "production_initialization"."created_at"
        AND ("production_initialization"."completed_at" IS NULL OR "production_initialization"."completed_at" >= "production_initialization"."created_at"))
);
