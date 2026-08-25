ALTER TABLE "chats" ADD COLUMN "participants_count" integer;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "last_activity_at" timestamp with time zone;