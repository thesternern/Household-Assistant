CREATE TABLE "shopping_preferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"position" integer DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "shopping_preferences_active_idx" ON "shopping_preferences" USING btree ("active");--> statement-breakpoint
-- The defaults the household validated against Instacart's assistant before
-- this shipped. Seeded as ordinary rows, so they can be reworded or dropped
-- one at a time without a deploy.
INSERT INTO "shopping_preferences" ("text", "position", "created_by") VALUES
  ('Do NOT add any store brand or private label. That includes President''s Choice, No Name, Western Family, Compliments, Signature Select, Our Finest, Great Value, Kirkland, and any other retailer-owned label. If the brand name matches the store, it is banned.', 10, 'seed'),
  ('Add only national name brands — the ones a manufacturer sells across multiple retailers. Where several national brands exist, pick the premium one.', 20, 'seed'),
  ('Price is not a factor. Do not choose a cheaper option to save me money. I have decided this already.', 30, 'seed'),
  ('If the ONLY option for an item is a store brand, do not substitute it. Leave that item out of the cart and list it separately as skipped.', 40, 'seed'),
  ('Before you add anything, tell me the exact brand and product you picked for each item. I want to see your choices, not a summary.', 50, 'seed');
