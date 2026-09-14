-- The seeded Instacart rules told the assistant to leave an item out of the
-- cart when the only option was a store brand. The household wants every
-- ingredient in the cart, every time; the brand preference is a preference,
-- not a reason to come home without dill. Reworded in place, guarded on the
-- seed author so a rule the household has since edited by hand is left alone.
UPDATE "shopping_preferences"
SET "text" = 'Do NOT add a store brand or private label when a national brand exists. That includes President''s Choice, No Name, Western Family, Compliments, Signature Select, Our Finest, Great Value, Kirkland, and any other retailer-owned label. If the brand name matches the store, it is a store brand.'
WHERE "position" = 10 AND "created_by" = 'seed';--> statement-breakpoint
UPDATE "shopping_preferences"
SET "text" = 'Every item on the list must end up in the cart. If the ONLY option for an item is a store brand, add that store brand anyway and tell me it was the only choice. Never leave an item out.'
WHERE "position" = 40 AND "created_by" = 'seed';
