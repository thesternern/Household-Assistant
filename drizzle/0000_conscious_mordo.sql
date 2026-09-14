CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"event" text NOT NULL,
	"category" text,
	"tool_name" text,
	"args_json" jsonb,
	"result_summary" text,
	"ok" boolean DEFAULT true NOT NULL,
	"pending_action_id" integer
);
--> statement-breakpoint
CREATE TABLE "call_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"vapi_call_id" text,
	"goal" text NOT NULL,
	"callee_name" text,
	"callee_number" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"transcript" text,
	"summary" text,
	"structured_data" jsonb,
	"success" boolean,
	"cost_usd" double precision,
	"dry_run" boolean DEFAULT false NOT NULL,
	"conversation_id" integer,
	"agent_session_id" text,
	"pending_action_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"phone" text,
	"email" text,
	"address" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"telegram_chat_id" text NOT NULL,
	"agent_session_id" text,
	"summary" text,
	"last_turn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extracted_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"watcher_id" integer NOT NULL,
	"source_ref" text NOT NULL,
	"content_hash" text NOT NULL,
	"title" text NOT NULL,
	"event_date" text,
	"event_time" text,
	"kind" text DEFAULT 'event' NOT NULL,
	"calendar_event_id" text,
	"todo_id" integer,
	"reminder_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "followups" (
	"id" serial PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"next_nag_at" timestamp with time zone,
	"nag_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"related_todo_id" integer,
	"telegram_chat_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "google_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"email" text,
	"refresh_token_encrypted" text NOT NULL,
	"scope" text,
	"invalid" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grocery_lists" (
	"id" serial PRIMARY KEY NOT NULL,
	"plan_id" integer NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"items" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checked_items" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "households" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text DEFAULT 'Household' NOT NULL,
	"timezone" text DEFAULT 'America/Los_Angeles' NOT NULL,
	"family_calendar_id" text,
	"quiet_hours_start" integer DEFAULT 21 NOT NULL,
	"quiet_hours_end" integer DEFAULT 7 NOT NULL,
	"brief_hour" integer DEFAULT 7 NOT NULL,
	"setup_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meal_plan_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"plan_id" integer NOT NULL,
	"recipe_id" integer NOT NULL,
	"day_of_week" integer NOT NULL,
	"meal_type" text DEFAULT 'dinner' NOT NULL,
	"servings_override" text,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "meal_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"week_start" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_facts" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"fact" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'chat' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"id" serial PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"telegram_user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"tool_name" text NOT NULL,
	"args_json" jsonb NOT NULL,
	"category" text NOT NULL,
	"human_summary" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"execution_result" jsonb,
	"telegram_chat_id" text,
	"telegram_message_ids" jsonb,
	"conversation_id" integer,
	"agent_session_id" text,
	"origin" text DEFAULT 'agent' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" serial PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"mode" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_url" text NOT NULL,
	"author" text,
	"description" text,
	"total_time_minutes" integer,
	"active_time_minutes" integer,
	"servings" text,
	"difficulty" text,
	"ingredients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"family_score" integer,
	"family_notes" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"grocery_categories" jsonb,
	"image_url" text,
	"scraped_at" timestamp with time zone DEFAULT now() NOT NULL,
	"times_planned" integer DEFAULT 0 NOT NULL,
	"last_planned_date" text,
	"is_archived" boolean DEFAULT false NOT NULL,
	"freshness_category" text DEFAULT 'moderate' NOT NULL,
	"freezer_friendly" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" serial PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"fire_at" timestamp with time zone NOT NULL,
	"recurrence" text,
	"boss_job_id" text,
	"telegram_chat_id" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "setup_state" (
	"id" serial PRIMARY KEY NOT NULL,
	"telegram_chat_id" text NOT NULL,
	"step_id" text NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"site" text NOT NULL,
	"username" text NOT NULL,
	"secret_encrypted" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "todos" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"status" text DEFAULT 'open' NOT NULL,
	"assignee" text,
	"due_date" text,
	"source" text DEFAULT 'chat' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "turn_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"num_turns" integer DEFAULT 0 NOT NULL,
	"trigger" text DEFAULT 'chat' NOT NULL,
	"ok" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"telegram_user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"google_connected" boolean DEFAULT false NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watchers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_log_ts_idx" ON "audit_log" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "audit_log_event_idx" ON "audit_log" USING btree ("event");--> statement-breakpoint
CREATE UNIQUE INDEX "call_records_vapi_id_uq" ON "call_records" USING btree ("vapi_call_id");--> statement-breakpoint
CREATE INDEX "contacts_role_idx" ON "contacts" USING btree ("role");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_chat_uq" ON "conversations" USING btree ("telegram_chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "extracted_events_hash_uq" ON "extracted_events" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "followups_next_nag_idx" ON "followups" USING btree ("next_nag_at");--> statement-breakpoint
CREATE INDEX "followups_status_idx" ON "followups" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "google_tokens_user_uq" ON "google_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "grocery_lists_plan_idx" ON "grocery_lists" USING btree ("plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meal_plan_items_slot_uq" ON "meal_plan_items" USING btree ("plan_id","day_of_week","meal_type");--> statement-breakpoint
CREATE INDEX "meal_plans_week_idx" ON "meal_plans" USING btree ("week_start");--> statement-breakpoint
CREATE INDEX "memory_facts_subject_idx" ON "memory_facts" USING btree ("subject");--> statement-breakpoint
CREATE INDEX "memory_facts_active_idx" ON "memory_facts" USING btree ("active");--> statement-breakpoint
CREATE INDEX "pending_actions_status_idx" ON "pending_actions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "pending_actions_expires_idx" ON "pending_actions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "policies_category_uq" ON "policies" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "recipes_source_url_uq" ON "recipes" USING btree ("source_url");--> statement-breakpoint
CREATE INDEX "recipes_family_score_idx" ON "recipes" USING btree ("family_score");--> statement-breakpoint
CREATE INDEX "recipes_archived_idx" ON "recipes" USING btree ("is_archived");--> statement-breakpoint
CREATE INDEX "reminders_fire_at_idx" ON "reminders" USING btree ("fire_at");--> statement-breakpoint
CREATE INDEX "reminders_status_idx" ON "reminders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "rules_active_idx" ON "rules" USING btree ("active");--> statement-breakpoint
CREATE UNIQUE INDEX "setup_state_chat_uq" ON "setup_state" USING btree ("telegram_chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "site_credentials_site_uq" ON "site_credentials" USING btree ("site");--> statement-breakpoint
CREATE INDEX "todos_status_idx" ON "todos" USING btree ("status");--> statement-breakpoint
CREATE INDEX "turn_metrics_ts_idx" ON "turn_metrics" USING btree ("ts");--> statement-breakpoint
CREATE UNIQUE INDEX "users_telegram_user_id_uq" ON "users" USING btree ("telegram_user_id");--> statement-breakpoint
CREATE INDEX "watchers_active_idx" ON "watchers" USING btree ("active");