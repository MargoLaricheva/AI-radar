CREATE TABLE "ai_analyses" (
	"id" serial PRIMARY KEY NOT NULL,
	"opportunity_id" integer,
	"conversation_id" integer,
	"model" text NOT NULL,
	"tokens_in" integer NOT NULL,
	"tokens_out" integer NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"id" serial PRIMARY KEY NOT NULL,
	"tg_chat_id" bigint NOT NULL,
	"title" text NOT NULL,
	"username" text,
	"type" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"category" text,
	"watch_weight" real DEFAULT 1 NOT NULL,
	"msg_cap_exceeded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" integer NOT NULL,
	"kind" text NOT NULL,
	"root_msg_id" bigint NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"first_ts" timestamp with time zone NOT NULL,
	"last_ts" timestamp with time zone NOT NULL,
	"msg_count" integer DEFAULT 0 NOT NULL,
	"topic" text,
	"last_analyzed_at" timestamp with time zone,
	"analyses_today" integer DEFAULT 0 NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "examples" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_text" text NOT NULL,
	"source" text,
	"topic" text NOT NULL,
	"note" text,
	"embedding" real[],
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"opportunity_id" integer NOT NULL,
	"chat_id" integer,
	"kind" text NOT NULL,
	"topic" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"stage" text NOT NULL,
	"model" text NOT NULL,
	"tokens_in" integer NOT NULL,
	"tokens_out" integer NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"chat_id" integer NOT NULL,
	"tg_msg_id" bigint NOT NULL,
	"author_id" bigint,
	"author_name" text,
	"text" text NOT NULL,
	"lang" text,
	"ts" timestamp with time zone NOT NULL,
	"is_outgoing" boolean DEFAULT false NOT NULL,
	"reply_to_tg_msg_id" bigint,
	"thread_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"opportunity_id" integer,
	"tg_card_msg_id" bigint,
	"kind" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"chat_id" integer NOT NULL,
	"type" text NOT NULL,
	"signal_track" text NOT NULL,
	"relatedness" text NOT NULL,
	"stage" text,
	"topic" text,
	"scores" jsonb NOT NULL,
	"client_probability" real NOT NULL,
	"priority" real NOT NULL,
	"summary" text NOT NULL,
	"reasoning" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"talking_points" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"avoid" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recommended_action" text NOT NULL,
	"suggested_message" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"tg_card_msg_id" bigint,
	"last_activity_ts" timestamp with time zone NOT NULL,
	"last_notified_at" timestamp with time zone,
	"notify_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" serial PRIMARY KEY NOT NULL,
	"tg_user_id" bigint NOT NULL,
	"name" text,
	"topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"relevant_discussions" integer DEFAULT 0 NOT NULL,
	"last_seen_ts" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tg_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"session_encrypted" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_analyses" ADD CONSTRAINT "ai_analyses_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_analyses" ADD CONSTRAINT "ai_analyses_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_accounts" ADD CONSTRAINT "tg_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_analyses_opp_idx" ON "ai_analyses" USING btree ("opportunity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chats_tg_id_uq" ON "chats" USING btree ("tg_chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conv_chat_kind_root_uq" ON "conversations" USING btree ("chat_id","kind","root_msg_id");--> statement-breakpoint
CREATE INDEX "conv_chat_state_idx" ON "conversations" USING btree ("chat_id","state");--> statement-breakpoint
CREATE INDEX "examples_enabled_idx" ON "examples" USING btree ("enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_opp_kind_uq" ON "feedback" USING btree ("opportunity_id","kind");--> statement-breakpoint
CREATE INDEX "llm_req_created_idx" ON "llm_requests" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_chat_tg_uq" ON "messages" USING btree ("chat_id","tg_msg_id");--> statement-breakpoint
CREATE INDEX "messages_chat_ts_idx" ON "messages" USING btree ("chat_id","ts");--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "notif_opp_idx" ON "notifications" USING btree ("opportunity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "opp_conv_uq" ON "opportunities" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "opp_status_created_idx" ON "opportunities" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "people_tg_user_uq" ON "people" USING btree ("tg_user_id");