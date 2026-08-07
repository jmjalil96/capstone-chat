CREATE TYPE "public"."conversation_message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"title" text,
	"selected_leaf_message_id" uuid,
	"revision" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_revision_nonnegative_check" CHECK ("conversations"."revision" >= 0),
	CONSTRAINT "conversations_title_nonempty_check" CHECK ("conversations"."title" IS NULL OR "conversations"."title" ~ '[^[:space:]]')
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" uuid,
	"content" text DEFAULT '' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drafts_revision_nonnegative_check" CHECK ("drafts"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"parent_message_id" uuid,
	"role" "conversation_message_role" NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_conversation_id_id_unique" UNIQUE("conversation_id","id"),
	CONSTRAINT "messages_content_array_check" CHECK (jsonb_typeof("messages"."content") = 'array' AND jsonb_array_length("messages"."content") = 1),
	CONSTRAINT "messages_root_user_check" CHECK ("messages"."parent_message_id" IS NOT NULL OR "messages"."role" = 'user')
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_owner_id_unique" ON "conversations" USING btree ("workspace_id","user_id","id");--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_owned_conversation_fk" FOREIGN KEY ("workspace_id","user_id","conversation_id") REFERENCES "public"."conversations"("workspace_id","user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_same_conversation_parent_fk" FOREIGN KEY ("conversation_id","parent_message_id") REFERENCES "public"."messages"("conversation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_owner_active_history_idx" ON "conversations" USING btree ("workspace_id","user_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "conversations"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "conversations_owner_archived_history_idx" ON "conversations" USING btree ("workspace_id","user_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "conversations"."archived_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "drafts_conversation_scope_unique" ON "drafts" USING btree ("workspace_id","user_id","conversation_id") WHERE "drafts"."conversation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "drafts_new_chat_scope_unique" ON "drafts" USING btree ("workspace_id","user_id") WHERE "drafts"."conversation_id" IS NULL;--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_parent_idx" ON "messages" USING btree ("conversation_id","parent_message_id");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_same_conversation_selected_leaf_fk" FOREIGN KEY ("id", "selected_leaf_message_id") REFERENCES "public"."messages"("conversation_id", "id") DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "unaccent";--> statement-breakpoint
CREATE FUNCTION public.capstone_search_normalize(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $function$
  SELECT lower(public.unaccent('public.unaccent', value))
$function$;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "title_search_vector" tsvector GENERATED ALWAYS AS (
	to_tsvector('simple', public.capstone_search_normalize(coalesce("title", '')))
) STORED;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "content_search_vector" tsvector GENERATED ALWAYS AS (
	to_tsvector('simple', public.capstone_search_normalize(coalesce("content" -> 0 ->> 'text', '')))
) STORED;--> statement-breakpoint
CREATE INDEX "conversations_title_search_idx" ON "conversations" USING gin ("title_search_vector");--> statement-breakpoint
CREATE INDEX "messages_content_search_idx" ON "messages" USING gin ("content_search_vector");
