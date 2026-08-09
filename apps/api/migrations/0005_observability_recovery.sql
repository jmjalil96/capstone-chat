CREATE TABLE "client_error_rate_limit_windows" (
	"scope" text NOT NULL,
	"key_hash" text NOT NULL,
	"window_started_at" timestamp (0) with time zone NOT NULL,
	"request_count" integer NOT NULL,
	"expires_at" timestamp (0) with time zone NOT NULL,
	CONSTRAINT "client_error_rate_limit_windows_pk" PRIMARY KEY("scope","key_hash","window_started_at"),
	CONSTRAINT "client_error_rate_limit_scope_check" CHECK ("client_error_rate_limit_windows"."scope" IN ('global', 'client')),
	CONSTRAINT "client_error_rate_limit_hash_check" CHECK ("client_error_rate_limit_windows"."key_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "client_error_rate_limit_count_check" CHECK ("client_error_rate_limit_windows"."request_count" > 0 AND "client_error_rate_limit_windows"."request_count" <= 200),
	CONSTRAINT "client_error_rate_limit_window_check" CHECK ("client_error_rate_limit_windows"."expires_at" > "client_error_rate_limit_windows"."window_started_at")
);
--> statement-breakpoint
CREATE INDEX "client_error_rate_limit_expiry_idx" ON "client_error_rate_limit_windows" USING btree ("expires_at");
--> statement-breakpoint
CREATE TABLE "operational_recovery_markers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operational_recovery_markers_kind_check" CHECK ("operational_recovery_markers"."kind" IN ('pre', 'post'))
);
