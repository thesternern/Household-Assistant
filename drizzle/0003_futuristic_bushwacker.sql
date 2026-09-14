ALTER TABLE "contacts" ADD COLUMN "birthday" date;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "household" boolean DEFAULT false NOT NULL;