CREATE TABLE "shopping_list_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"quantity_text" text,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"urgent" boolean DEFAULT false NOT NULL,
	"added_by" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "shopping_list_items_status_idx" ON "shopping_list_items" USING btree ("status");