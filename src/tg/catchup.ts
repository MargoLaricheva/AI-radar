import { TelegramClient } from "telegram";
import { eq } from "drizzle-orm";
import { getDb, type Db } from "../db/client";
import { chats } from "../db/schema";
import { normalizeMessage } from "../pipeline/normalizer";
import { lastMsgIdForChat } from "../pipeline/store";
import type { MsgQueue } from "../pipeline/queue";
import { callWithFloodGuard, jitter, sleep } from "./flood";
import type { TgMessage } from "./types";
import type pino from "pino";

export interface CatchupOpts {
  queue: MsgQueue;
  log: pino.Logger;
  db?: Db;
  hours?: number;
  pageSize?: number;
  maxPages?: number;
  delayBetweenMs?: number;
}

const PAGE_SIZE = 50;
const MAX_PAGES = 10;

/**
 * Догон пропущенных сообщений после простоя/рестарта.
 * По каждому включённому чату: страницы по PAGE_SIZE (последние первыми),
 * стоп — пустая страница, встреча сохранённого id или выход за окно hours.
 * Между чатами задержка — анти-flood.
 */
export async function runCatchup(client: TelegramClient, opts: CatchupOpts): Promise<number> {
  const db = opts.db ?? getDb();
  const log = opts.log;
  const hours = opts.hours ?? 6;
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const delayBetween = opts.delayBetweenMs ?? 800;

  const enabled = await db.select({ id: chats.id, tgChatId: chats.tgChatId }).from(chats).where(eq(chats.enabled, true));
  if (enabled.length === 0) {
    log.info("catch-up: включённых чатов нет");
    return 0;
  }

  const cutoff = Date.now() - hours * 3600_000;
  let pushed = 0;

  for (const chat of enabled) {
    try {
      await client.getEntity(chat.tgChatId);
    } catch (err) {
      log.warn({ err: String(err), chatId: chat.tgChatId }, "catch-up: сущность чата недоступна, пропуск");
      continue;
    }
    const lastId = await lastMsgIdForChat(chat.id, db);
    // offsetId возвращает сообщения СТАРШЕ id; нам нужны последние — берём страницу последних
    let offsetId = 0;
    let knownSeen = false;

    for (let page = 0; page < maxPages && !knownSeen; page++) {
      let msgs;
      try {
        msgs = await callWithFloodGuard(() =>
          client.getMessages(chat.tgChatId, { limit: pageSize, offsetId, addOffset: 0 }),
        );
      } catch (err) {
        log.warn({ err: String(err), chatId: chat.tgChatId }, "catch-up: ошибка чтения чата, пропуск");
        break;
      }
      if (msgs.length === 0) break;

      for (const m of msgs) {
        const id = typeof m.id === "number" ? m.id : Number(m.id);
        if (lastId != null && id <= lastId) {
          knownSeen = true;
          continue;
        }
        const date = m.date ? new Date(m.date * 1000) : null;
        if (date && date.getTime() < cutoff) {
          knownSeen = true;
          continue;
        }
        if (m.action) continue;
        const norm = normalizeMessage(m.message ?? "");
        if (norm.junk) continue;
        opts.queue.push({
          chatId: chat.tgChatId,
          tgMsgId: id,
          authorId: typeof m.senderId === "number" ? m.senderId : null,
          authorName: null,
          text: norm.text,
          lang: norm.lang,
          ts: date ?? new Date(),
          isOutgoing: m.out === true,
          replyToTgMsgId: typeof m.replyToMsgId === "number" ? m.replyToMsgId : null,
        });
        pushed++;
      }
      if (knownSeen) break;
      offsetId = typeof msgs[msgs.length - 1]!.id === "number" ? msgs[msgs.length - 1]!.id : Number(msgs[msgs.length - 1]!.id);
    }

    await sleep(jitter(delayBetween));
  }

  log.info({ pushed }, "catch-up завершён");
  return pushed;
}
