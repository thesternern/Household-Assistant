ALTER TABLE "grocery_lists" ADD COLUMN "source_hash" text;--> statement-breakpoint
ALTER TABLE "grocery_lists" ADD COLUMN "refined" jsonb;