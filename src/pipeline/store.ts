import { sql } from "drizzle-orm";
import { getDb, type Db } from "../db/client";
import { chats, messages } from "../db/schema";
import type { TgChatInfo, TgMessage } from "../tg/types";

// Batch-запись сообщений в БД с dedup (ON CONFLICT DO NOTHING)

export interface StoredMessage {
  dbId: number;
  chatDbId: number;
  threadId: number | null;
}

/** Upsert чата по tgChatId, возвращает внутренний id */
export async function ensureChat(chat: TgChatInfo, db: Db = getDb()): Promise<number> {
  const rows = await db
    .insert(chats)
    .values({
      tgChatId: chat.tgChatId,
      title: chat.title,
      username: chat.username,
      type: chat.type,
    })
    .onConflictDoUpdate({
      target: chats.tgChatId,
      set: {
        title: chat.title,
        username: chat.username,
        type: chat.type,
      },
    })
    .returning({ id: chats.id });
  return rows[0]!.id;
}

export async function ensureChatsBulk(chatList: TgChatInfo[], db: Db = getDb()): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  const existing = await db.select({ id: chats.id, tgChatId: chats.tgChatId }).from(chats);
  for (const c of existing) map.set(c.tgChatId, c.id);
  const missing = chatList.filter((c) => !map.has(c.tgChatId));
  for (const c of missing) {
    const id = await ensureChat(c, db);
    map.set(c.tgChatId, id);
  }
  return map;
}

/**
 * Вставка пачки сообщений. Возвращает сохранённые (не-дубликаты) с dbId и chatDbId.
 * Дубликаты (chat_id, tg_msg_id) молча пропускаются.
 */
export async function insertMessages(
  msgs: TgMessage[],
  chatMap: Map<number, number>,
  db: Db = getDb(),
): Promise<StoredMessage[]> {
  if (msgs.length === 0) return [];
  const rows = msgs
    .filter((m) => chatMap.has(m.chatId))
    .map((m) => ({
      chatId: chatMap.get(m.chatId)!,
      tgMsgId: m.tgMsgId,
      authorId: m.authorId,
      authorName: m.authorName,
      text: m.text,
      lang: m.lang,
      ts: m.ts,
      isOutgoing: m.isOutgoing,
      replyToTgMsgId: m.replyToTgMsgId,
    }));
  if (rows.length === 0) return [];

  const inserted = await db
    .insert(messages)
    .values(rows)
    .onConflictDoNothing({ target: [messages.chatId, messages.tgMsgId] })
    .returning({ id: messages.id, chatId: messages.chatId, tgMsgId: messages.tgMsgId });

  const byKey = new Map(rows.map((r) => [`${r.chatId}:${r.tgMsgId}`, r]));
  return inserted.map((r) => {
    const orig = byKey.get(`${r.chatId}:${r.tgMsgId}`)!;
    return { dbId: r.id, chatDbId: r.chatId, threadId: null };
  });
}

/** Последний сохранённый tg_msg_id по чату (для catch-up) */
export async function lastMsgIdForChat(chatDbId: number, db: Db = getDb()): Promise<number | null> {
  const rows = await db
    .select({ id: messages.tgMsgId })
    .from(messages)
    .where(sql`${messages.chatId} = ${chatDbId}`)
    .orderBy(sql`${messages.tgMsgId} desc`)
    .limit(1);
  return rows[0]?.id ?? null;
}
