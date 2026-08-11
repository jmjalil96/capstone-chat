CREATE INDEX "generations_conversation_idx" ON "generations" USING btree ("conversation_id") WHERE "generations"."conversation_id" IS NOT NULL;
