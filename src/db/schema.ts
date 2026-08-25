import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ---------- Типы профиля и настроек ----------

export const opportunityTypes = [
  "HOT_LEAD",
  "WARM_LEAD",
  "DISCUSSION",
  "EXPERTISE",
  "NETWORKING",
  "FUTURE",
  "INFORMATION",
  "NOISE",
] as const;
export type OpportunityType = (typeof opportunityTypes)[number];

export type Profile = {
  what_i_do?: string;
  services?: string[];
  products?: string[];
  niches?: string[];
  audience?: string;
  geography?: string;
  min_check?: string;
  preferred_check?: string;
  topics?: string[];
  disliked_topics?: string[];
  competitors?: string[];
  expertise?: string[];
  opportunity_types?: string[];
  style?: string;
};

export type Weights = {
  topics: Record<string, number>;
  chats: Record<string, number>;
  types: Record<string, number>;
};

export type Settings = {
  owner_id?: string;
  notify_level?: "critical" | "important" | "opportunities";
  quiet_hours?: { start: number; end: number };
  digest_time?: string;
  retention_days?: number;
  analysis_per_hour?: number;
  thread_analyses_per_day?: number;
  filter_threshold?: number;
  paused?: boolean;
  /** Оповещения в бота: false — карточки копятся в базе, но не пушатся */
  notifications_enabled?: boolean;
  /** TG id аккаунта-юзербота: если владелец сам участвует в диалоге — карточку не шлём */
  self_tg_id?: number;
  weights?: Weights;
  blacklisted_topics?: string[];
};

// ---------- Таблицы ----------

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  profile: jsonb("profile").$type<Profile>().notNull().default({}),
  settings: jsonb("settings").$type<Settings>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tgAccounts = pgTable("tg_accounts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  sessionEncrypted: text("session_encrypted").notNull(),
  status: text("status", { enum: ["active", "needs_auth", "disabled"] }).notNull().default("active"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chats = pgTable(
  "chats",
  {
    id: serial("id").primaryKey(),
    tgChatId: bigint("tg_chat_id", { mode: "number" }).notNull(),
    title: text("title").notNull(),
    username: text("username"),
    type: text("type", { enum: ["group", "supergroup", "channel", "megagroup"] }).notNull(),
    participantsCount: integer("participants_count"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    enabled: boolean("enabled").notNull().default(false),
    priority: integer("priority").notNull().default(0),
    category: text("category"),
    watchWeight: real("watch_weight").notNull().default(1.0),
    msgCapExceeded: boolean("msg_cap_exceeded").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("chats_tg_id_uq").on(t.tgChatId)],
);

export const messages = pgTable(
  "messages",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    tgMsgId: bigint("tg_msg_id", { mode: "number" }).notNull(),
    authorId: bigint("author_id", { mode: "number" }),
    authorName: text("author_name"),
    text: text("text").notNull(),
    lang: text("lang"),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    isOutgoing: boolean("is_outgoing").notNull().default(false),
    replyToTgMsgId: bigint("reply_to_tg_msg_id", { mode: "number" }),
    threadId: integer("thread_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("messages_chat_tg_uq").on(t.chatId, t.tgMsgId),
    index("messages_chat_ts_idx").on(t.chatId, t.ts),
    index("messages_thread_idx").on(t.threadId),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: serial("id").primaryKey(),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["segment", "thread"] }).notNull(),
    rootMsgId: bigint("root_msg_id", { mode: "number" }).notNull(),
    state: text("state", { enum: ["open", "closed"] }).notNull().default("open"),
    firstTs: timestamp("first_ts", { withTimezone: true }).notNull(),
    lastTs: timestamp("last_ts", { withTimezone: true }).notNull(),
    msgCount: integer("msg_count").notNull().default(0),
    topic: text("topic"),
    lastAnalyzedAt: timestamp("last_analyzed_at", { withTimezone: true }),
    analysesToday: integer("analyses_today").notNull().default(0),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("conv_chat_kind_root_uq").on(t.chatId, t.kind, t.rootMsgId),
    index("conv_chat_state_idx").on(t.chatId, t.state),
  ],
);

export const opportunities = pgTable(
  "opportunities",
  {
    id: serial("id").primaryKey(),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    type: text("type", { enum: opportunityTypes }).notNull(),
    signalTrack: text("signal_track", { enum: ["client", "expertise"] }).notNull(),
    relatedness: text("relatedness", { enum: ["direct", "adjacent", "contextual"] }).notNull(),
    stage: text("stage"),
    topic: text("topic"),
    scores: jsonb("scores")
      .$type<{
        relevance: number;
        purchaseIntent: number;
        engagementOpportunity: number;
        futurePotential: number;
        urgency: number;
      }>()
      .notNull(),
    clientProbability: real("client_probability").notNull(),
    priority: real("priority").notNull(),
    summary: text("summary").notNull(),
    reasoning: jsonb("reasoning").$type<string[]>().notNull().default([]),
    talkingPoints: jsonb("talking_points").$type<string[]>().notNull().default([]),
    avoid: jsonb("avoid").$type<string[]>().notNull().default([]),
    recommendedAction: text("recommended_action").notNull(),
    suggestedMessage: text("suggested_message").notNull(),
    status: text("status", {
      enum: ["new", "viewed", "engaged", "conversation", "lead", "client", "deleted", "closed"],
    })
      .notNull()
      .default("new"),
    lastMsgId: bigint("last_msg_id", { mode: "number" }),
    tgCardMsgId: bigint("tg_card_msg_id", { mode: "number" }),
    lastActivityTs: timestamp("last_activity_ts", { withTimezone: true }).notNull(),
    lastNotifiedAt: timestamp("last_notified_at", { withTimezone: true }),
    notifyCount: integer("notify_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("opp_conv_uq").on(t.conversationId),
    index("opp_status_created_idx").on(t.status, t.createdAt),
  ],
);

export const aiAnalyses = pgTable(
  "ai_analyses",
  {
    id: serial("id").primaryKey(),
    opportunityId: integer("opportunity_id").references(() => opportunities.id, {
      onDelete: "set null",
    }),
    conversationId: integer("conversation_id").references(() => conversations.id, {
      onDelete: "cascade",
    }),
    model: text("model").notNull(),
    tokensIn: integer("tokens_in").notNull(),
    tokensOut: integer("tokens_out").notNull(),
    costUsd: real("cost_usd").notNull().default(0),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_analyses_opp_idx").on(t.opportunityId)],
);

export const llmRequests = pgTable(
  "llm_requests",
  {
    id: serial("id").primaryKey(),
    stage: text("stage", { enum: ["analyze", "filter", "teach", "digest"] }).notNull(),
    model: text("model").notNull(),
    tokensIn: integer("tokens_in").notNull(),
    tokensOut: integer("tokens_out").notNull(),
    costUsd: real("cost_usd").notNull().default(0),
    ms: integer("ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("llm_req_created_idx").on(t.createdAt)],
);

export const feedback = pgTable(
  "feedback",
  {
    id: serial("id").primaryKey(),
    opportunityId: integer("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    chatId: integer("chat_id"),
    kind: text("kind", { enum: ["like", "dislike", "delete", "resolved"] }).notNull(),
    topic: text("topic"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("feedback_opp_kind_uq").on(t.opportunityId, t.kind)],
);

export const examples = pgTable(
  "examples",
  {
    id: serial("id").primaryKey(),
    userText: text("user_text").notNull(),
    source: text("source"),
    topic: text("topic").notNull(),
    note: text("note"),
    embedding: real("embedding").array(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("examples_enabled_idx").on(t.enabled)],
);

export const people = pgTable(
  "people",
  {
    id: serial("id").primaryKey(),
    tgUserId: bigint("tg_user_id", { mode: "number" }).notNull(),
    name: text("name"),
    topics: jsonb("topics").$type<string[]>().notNull().default([]),
    relevantDiscussions: integer("relevant_discussions").notNull().default(0),
    lastSeenTs: timestamp("last_seen_ts", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("people_tg_user_uq").on(t.tgUserId)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: serial("id").primaryKey(),
    opportunityId: integer("opportunity_id").references(() => opportunities.id, {
      onDelete: "cascade",
    }),
    tgCardMsgId: bigint("tg_card_msg_id", { mode: "number" }),
    kind: text("kind", { enum: ["card", "update", "digest"] }).notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("notif_opp_idx").on(t.opportunityId)],
);

export type User = typeof users.$inferSelect;
export type Chat = typeof chats.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Opportunity = typeof opportunities.$inferSelect;
export type Example = typeof examples.$inferSelect;
