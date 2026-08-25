// Opportunity Engine: upsert карточки возможности, статусы, re-notify-политика

import { and, eq, sql } from "drizzle-orm";
import { getDb, type Db } from "../db/client";
import { conversations, opportunities } from "../db/schema";
import type { AnalysisResult } from "../llm/schema";
import type { Scored } from "./score";

export interface OpportunityEvent {
  opportunityId: number;
  isNew: boolean;
  shouldNotify: boolean;
  delta: number;
  previousType: string | null;
}

export interface ConversationRef {
  id: number;
  rootMsgId: number;
  lastTs: Date;
}

/** Получить/создать тред-разговор в БД (для привязки opportunity) */
export async function ensureConversation(
  chatDbId: number,
  rootMsgId: number,
  lastTs: Date,
  msgCount: number,
  db: Db = getDb(),
): Promise<ConversationRef> {
  const existing = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.chatId, chatDbId), eq(conversations.kind, "thread"), eq(conversations.rootMsgId, rootMsgId)))
    .limit(1);
  if (existing[0]) {
    await db
      .update(conversations)
      .set({ lastTs, msgCount, state: "open" })
      .where(eq(conversations.id, existing[0].id));
    return { id: existing[0].id, rootMsgId, lastTs };
  }
  const rows = await db
    .insert(conversations)
    .values({ chatId: chatDbId, kind: "thread", rootMsgId, firstTs: lastTs, lastTs, msgCount, state: "open" })
    .onConflictDoNothing({ target: [conversations.chatId, conversations.kind, conversations.rootMsgId] })
    .returning({ id: conversations.id });
  if (rows[0]) return { id: rows[0].id, rootMsgId, lastTs };
  const again = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.chatId, chatDbId), eq(conversations.kind, "thread"), eq(conversations.rootMsgId, rootMsgId)))
    .limit(1);
  return { id: again[0]!.id, rootMsgId, lastTs };
}

export async function upsertOpportunity(
  conversationRef: ConversationRef,
  chatDbId: number,
  analysis: AnalysisResult,
  scored: Scored,
  db: Db = getDb(),
  lastMsgId?: number | null,
): Promise<OpportunityEvent> {
  const existing = await db
    .select()
    .from(opportunities)
    .where(eq(opportunities.conversationId, conversationRef.id))
    .limit(1);

  const values = {
    conversationId: conversationRef.id,
    chatId: chatDbId,
    type: analysis.type,
    signalTrack: analysis.signal_track ?? "expertise",
    relatedness: analysis.relatedness ?? "contextual",
    stage: analysis.stage,
    topic: analysis.topic,
    scores: {
      relevance: analysis.relevance,
      purchaseIntent: analysis.purchase_intent,
      engagementOpportunity: analysis.engagement_opportunity,
      futurePotential: analysis.future_potential,
      urgency: analysis.urgency,
    },
    clientProbability: analysis.client_probability,
    priority: scored.priority,
    summary: analysis.summary,
    reasoning: analysis.reasoning,
    talkingPoints: analysis.talking_points,
    avoid: analysis.avoid,
    recommendedAction: analysis.recommended_action,
    suggestedMessage: analysis.suggested_message ?? "",
    lastActivityTs: conversationRef.lastTs,
    lastMsgId: lastMsgId ?? undefined,
    updatedAt: new Date(),
  };

  if (!existing[0]) {
    const rows = await db.insert(opportunities).values(values).returning({ id: opportunities.id });
    return { opportunityId: rows[0]!.id, isNew: true, shouldNotify: true, delta: 0, previousType: null };
  }

  const prev = existing[0];
  const delta = scored.priority - (prev.priority ?? 0);
  const typeChanged = prev.type !== analysis.type;
  const shouldNotify = typeChanged || delta >= 10;

  await db.update(opportunities).set(values).where(eq(opportunities.id, prev.id));
  return { opportunityId: prev.id, isNew: false, shouldNotify, delta, previousType: prev.type };
}

/** Отметить карточку отправленной в боте */
export async function markCardSent(
  opportunityId: number,
  tgCardMsgId: number,
  db: Db = getDb(),
): Promise<void> {
  await db
    .update(opportunities)
    .set({ tgCardMsgId, lastNotifiedAt: new Date(), notifyCount: sql`${opportunities.notifyCount} + 1` })
    .where(eq(opportunities.id, opportunityId));
}

/** Обновить карточку без повторного пуша (тихий edit) */
export async function getOpportunity(
  opportunityId: number,
  db: Db = getDb(),
): Promise<typeof opportunities.$inferSelect | null> {
  const rows = await db.select().from(opportunities).where(eq(opportunities.id, opportunityId)).limit(1);
  return rows[0] ?? null;
}
