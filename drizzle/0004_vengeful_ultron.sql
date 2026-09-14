CREATE TABLE "sms_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" integer NOT NULL,
	"direction" text NOT NULL,
	"body" text NOT NULL,
	"twilio_sid" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sms_threads" (
	"id" serial PRIMARY KEY NOT NULL,
	"contact_id" integer NOT NULL,
	"phone" text NOT NULL,
	"goal" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_reason" text,
	"pending_action_id" integer,
	"telegram_chat_id" text,
	"message_count" integer DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_message_at" timestamp with time zone,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "sms_opted_out_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "sms_messages_thread_idx" ON "sms_messages" USING btree ("thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_messages_sid_uq" ON "sms_messages" USING btree ("twilio_sid");--> statement-breakpoint
CREATE INDEX "sms_threads_phone_idx" ON "sms_threads" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "sms_threads_status_idx" ON "sms_threads" USING btree ("status");