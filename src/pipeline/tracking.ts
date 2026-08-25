// Авто-трекинг ответов: пользователь ответил в мониторящемся чате → статусы engaged/conversation

import { and, eq } from "drizzle-orm";
import { getDb, type Db } from "../db/client";
import { conversations, opportunities } from "../db/schema";
import type { Notifier } from "../notify/notifier";

/**
 * Вызывается для каждого сообщения в треде.
 * outgoing (ответ владельца) → engaged; последующий incoming → conversation.
 */
export async function trackMessage(
  chatDbId: number,
  threadRootMsgId: number,
  isOutgoing: boolean,
  notifier: Notifier | null,
  db: Db = getDb(),
): Promise<void> {
  const conv = (
    await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.chatId, chatDbId), eq(conversations.kind, "thread"), eq(conversations.rootMsgId, threadRootMsgId)))
      .limit(1)
  )[0];
  if (!conv) return;

  const opp = (await db.select().from(opportunities).where(eq(opportunities.conversationId, conv.id)).limit(1))[0];
  if (!opp || opp.status === "deleted" || opp.status === "closed") return;

  if (isOutgoing && (opp.status === "new" || opp.status === "viewed")) {
    await db.update(opportunities).set({ status: "engaged" }).where(eq(opportunities.id, opp.id));
    if (notifier) {
      const updated = { ...opp, status: "engaged" as const };
      await notifier.refreshCardFor(updated);
    }
  } else if (!isOutgoing && opp.status === "engaged") {
    await db.update(opportunities).set({ status: "conversation" }).where(eq(opportunities.id, opp.id));
    if (notifier) {
      const updated = { ...opp, status: "conversation" as const };
      await notifier.refreshCardFor(updated);
    }
  }
}
