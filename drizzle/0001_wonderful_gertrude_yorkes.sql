DROP INDEX "google_tokens_user_uq";--> statement-breakpoint
ALTER TABLE "google_tokens" ADD COLUMN "role" text DEFAULT 'personal' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "google_tokens_role_uq" ON "google_tokens" USING btree ("role");