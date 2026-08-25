// Персональное обучение: веса тем/чатов/типов из фидбека 👍/👎

import { and, count, eq } from "drizzle-orm";
import { getDb, type Db } from "../db/client";
import { feedback } from "../db/schema";
import type { SettingsStore } from "../settings";
import { normalizeTopicKey } from "../pipeline/score";

const TOPIC_LIKE = 1.2;
const TOPIC_DISLIKE = 0.8;
const CHAT_LIKE = 1.1;
const TYPE_LIKE = 0.1;
const TOPIC_CAP = 3.0;
const CHAT_CAP = 2.0;
const BLACKLIST_WEIGHT = 0.05;
const DISLIKES_TO_BLACKLIST = 2;

export interface FeedbackService {
  record(kind: "like" | "dislike" | "delete" | "resolved", opportunityId: number, topic: string | null, chatId: number | null): Promise<boolean>;
  topicDislikeCount(topic: string): Promise<number>;
  chatDislikeCount(chatDbId: number): Promise<number>;
}

export function createFeedbackService(store: SettingsStore, db: Db = getDb()): FeedbackService {
  return {
    async record(kind, opportunityId, topic, chatId) {
      const existing = await db
        .select({ id: feedback.id })
        .from(feedback)
        .where(and(eq(feedback.opportunityId, opportunityId), eq(feedback.kind, kind)))
        .limit(1);
      if (existing[0]) return false;
      await db.insert(feedback).values({ opportunityId, kind, topic: topic ?? undefined, chatId: chatId ?? undefined });
      return true;
    },
    async topicDislikeCount(topic) {
      const rows = await db
        .select({ n: count() })
        .from(feedback)
        .where(and(eq(feedback.kind, "dislike"), eq(feedback.topic, topic)));
      return rows[0]?.n ?? 0;
    },
    async chatDislikeCount(chatDbId) {
      const rows = await db
        .select({ n: count() })
        .from(feedback)
        .where(and(eq(feedback.kind, "dislike"), eq(feedback.chatId, chatDbId)));
      return rows[0]?.n ?? 0;
    },
  };
}

export async function applyLike(store: SettingsStore, topic: string | null, chatDbId: number | null, oppType: string): Promise<void> {
  const w = await store.getWeights();
  if (topic) {
    const key = normalizeTopicKey(topic);
    w.topics[key] = Math.min(TOPIC_CAP, (w.topics[key] ?? 1) * TOPIC_LIKE);
  }
  if (chatDbId != null) {
    w.chats[String(chatDbId)] = Math.min(CHAT_CAP, (w.chats[String(chatDbId)] ?? 1) * CHAT_LIKE);
  }
  if (oppType === "HOT_LEAD" || oppType === "WARM_LEAD") {
    w.types[oppType] = Math.min(1.3, (w.types[oppType] ?? 1) + TYPE_LIKE);
  }
  await store.saveWeights(w);
}

export async function applyDislike(store: SettingsStore, fb: FeedbackService, topic: string | null, chatDbId: number | null): Promise<void> {
  const w = await store.getWeights();
  if (topic) {
    const key = normalizeTopicKey(topic);
    const dislikes = await fb.topicDislikeCount(topic);
    if (dislikes >= DISLIKES_TO_BLACKLIST) {
      w.topics[key] = BLACKLIST_WEIGHT;
      const s = await store.getSettings();
      const blacklist = new Set(s.blacklisted_topics ?? []);
      blacklist.add(key);
      await store.updateSettings({ blacklisted_topics: [...blacklist] });
    } else {
      w.topics[key] = Math.max(BLACKLIST_WEIGHT, (w.topics[key] ?? 1) * TOPIC_DISLIKE);
    }
  }
  if (chatDbId != null) {
    w.chats[String(chatDbId)] = Math.max(0.1, (w.chats[String(chatDbId)] ?? 1) * TOPIC_DISLIKE);
  }
  await store.saveWeights(w);
}
