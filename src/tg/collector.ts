import { TelegramClient } from "telegram";
import { NewMessage } from "telegram/events/index.js";
import { eq } from "drizzle-orm";
import { getDb, type Db } from "../db/client";
import { chats } from "../db/schema";
import { normalizeMessage } from "../pipeline/normalizer";
import type { MsgQueue } from "../pipeline/queue";
import { RateCounter } from "./flood";
import type { TgMessage } from "./types";
import type pino from "pino";

export interface CollectorOpts {
  queue: MsgQueue;
  log: pino.Logger;
  db?: Db;
  capPerMin?: number;
  refreshMs?: number;
}

/**
 * Подписка на новые сообщения по включённым чатам.
 * Обработчик: O(1) — нормализация + очередь. Без I/O.
 */
export function startCollector(client: TelegramClient, opts: CollectorOpts): () => void {
  const db = opts.db ?? getDb();
  const cap = new RateCounter(opts.capPerMin ?? 60);
  const log = opts.log;

  // tgChatId -> dbChatId (enabled)
  let watched = new Map<number, number>();

  async function refreshWatched(): Promise<void> {
    const rows = await db.select({ id: chats.id, tgChatId: chats.tgChatId }).from(chats).where(eq(chats.enabled, true));
    watched = new Map(rows.map((r) => [r.tgChatId, r.id]));
  }

  void refreshWatched();
  const refreshTimer = setInterval(() => void refreshWatched(), opts.refreshMs ?? 30_000);

  function toTgMessage(u: Parameters<Parameters<TelegramClient["addEventHandler"]>[0]>[0]): TgMessage | null {
    const msg = u.message as {
      id: number;
      chatId?: number;
      senderId?: unknown;
      out?: boolean;
      date?: number;
      message?: string;
      replyToMsgId?: number;
      className?: string;
      peerId?: unknown;
    } | undefined;
    if (!msg || msg.className === "MessageService") return null;
    const chatId = msg.chatId;
    if (typeof chatId !== "number" || !watched.has(chatId)) return null;

    const norm = normalizeMessage(msg.message ?? "");
    if (norm.junk) return null;

    const senderId = msg.senderId;
    return {
      chatId,
      tgMsgId: msg.id,
      authorId: typeof senderId === "number" ? senderId : typeof senderId === "bigint" ? Number(senderId) : null,
      authorName: null,
      text: norm.text,
      lang: norm.lang,
      ts: new Date((msg.date ?? Math.floor(Date.now() / 1000)) * 1000),
      isOutgoing: msg.out === true,
      replyToTgMsgId: typeof msg.replyToMsgId === "number" ? msg.replyToMsgId : null,
    };
  }

  async function handler(event: { message: unknown }): Promise<void> {
    const msg = toTgMessage(event);
    if (!msg) return;
    if (cap.check(msg.chatId)) {
      await db
        .update(chats)
        .set({ msgCapExceeded: true })
        .where(eq(chats.id, watched.get(msg.chatId)!));
      log.warn({ chatId: msg.chatId }, "чат превысил лимит потока, помечен как флуд");
      return;
    }
    opts.queue.push(msg);
  }

  const eventBuilder = new NewMessage({});
  client.addEventHandler(handler, eventBuilder);

  return () => {
    clearInterval(refreshTimer);
    client.removeEventHandler(handler, eventBuilder);
  };
}
