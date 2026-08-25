// Расписания: дайджест, retention, sweep builder (setInterval — работает в любом рантайме)

import type pino from "pino";
import type { ConversationBuilder } from "../pipeline/builder";
import type { CommandDeps } from "../bot/commands";
import type { Bot } from "grammy";
import type { TelegramClient } from "telegram";
import type { Env } from "../config";
import { runRetention } from "../retention/cleaner";
import type { MsgQueue } from "../pipeline/queue";

export interface SchedulerDeps {
  bot: Bot;
  cmdDeps: CommandDeps;
  config: Env;
  log: pino.Logger;
  builder: ConversationBuilder;
  tgClient: () => TelegramClient | null;
  queue: MsgQueue;
}

export function startScheduler(deps: SchedulerDeps): () => void {
  const timers: ReturnType<typeof setInterval>[] = [];
  let lastDigestDay = "";
  let retentionDoneToday = false;

  // Проверка раз в 30 секунд: наступил ли час дайджеста / retention
  timers.push(
    setInterval(async () => {
      const now = new Date();
      const hm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const day = now.toISOString().slice(0, 10);
      if (hm === deps.config.DIGEST_TIME && lastDigestDay !== day) {
        lastDigestDay = day;
        try {
          const { sendDigest } = await import("../notify/digest");
          await sendDigest(deps.bot, deps.cmdDeps);
        } catch (err) {
          deps.log.error({ err: String(err) }, "дайджест не удался");
        }
      }
      if (now.getHours() === 4 && now.getMinutes() === 0 && !retentionDoneToday) {
        retentionDoneToday = true;
        try {
          const res = await runRetention({
            messagesDays: deps.config.RETENTION_DAYS,
            closedConvDays: 90,
            deletedOppDays: 90,
            peopleDays: 180,
          });
          deps.log.info(res, "retention выполнен");
        } catch (err) {
          deps.log.error({ err: String(err) }, "retention не удался");
        }
      }
      if (now.getHours() === 4 && now.getMinutes() > 1) retentionDoneToday = false;
    }, 30_000),
  );

  // Sweep builder каждые 15 минут: закрытие тредов по TTL (в памяти и в БД)
  timers.push(
    setInterval(() => {
      void (async () => {
        try {
          const closed = deps.builder.sweep();
          const { and, eq, lt } = await import("drizzle-orm");
          const { getDb } = await import("../db/client");
          const { conversations } = await import("../db/schema");
          const cutoff = new Date(Date.now() - deps.config.THREAD_TTL_HOURS * 3600_000);
          const res = await getDb()
            .update(conversations)
            .set({ state: "closed", closedAt: new Date() })
            .where(and(eq(conversations.state, "open"), lt(conversations.lastTs, cutoff)))
            .returning({ id: conversations.id });
          if (res.length > 0 || closed.length > 0) {
            deps.log.info({ inMemory: closed.length, inDb: res.length }, "sweep закрыл треды");
          }
        } catch (err) {
          deps.log.error({ err: String(err) }, "sweep builder не удался");
        }
      })();
    }, 15 * 60_000),
  );

  // Мини-догон каждые 10 минут: свежие сообщения включённых чатов (страховка от потери events)
  let miniBusy = false;
  timers.push(
    setInterval(() => {
      const client = deps.tgClient();
      if (!client || miniBusy) return; // не наслаиваем, если предыдущий ещё идёт
      miniBusy = true;
      void runMiniCatchup(client, deps)
        .catch((err) => {
          deps.log.error({ err: String(err) }, "mini-catchup не удался");
        })
        .finally(() => {
          miniBusy = false;
        });
    }, 10 * 60_000),
  );

  return () => {
    for (const t of timers) clearInterval(t);
  };
}

async function runMiniCatchup(client: TelegramClient, deps: SchedulerDeps): Promise<void> {
  const { eq } = await import("drizzle-orm");
  const { getDb } = await import("../db/client");
  const { chats } = await import("../db/schema");
  const { callWithFloodGuard, sleep } = await import("../tg/flood");
  const { lastMsgIdForChat } = await import("../pipeline/store");
  const { normalizeMessage } = await import("../pipeline/normalizer");

  const db = getDb();
  const enabled = await db.select({ id: chats.id, tgChatId: chats.tgChatId }).from(chats).where(eq(chats.enabled, true));
  let pushed = 0;
  for (const chat of enabled) {
    try {
      await client.getEntity(chat.tgChatId);
    } catch {
      continue;
    }
    const lastId = await lastMsgIdForChat(chat.id, db);
    let msgs;
    try {
      // offsetId возвращает сообщения СТАРШЕ id; нужны последние — берём без offset и фильтруем
      msgs = await callWithFloodGuard(() => client.getMessages(chat.tgChatId, { limit: 10 }));
    } catch (err) {
      deps.log.warn({ err: String(err).slice(0, 120), chatId: chat.tgChatId }, "mini-catchup: ошибка чтения");
      continue;
    }
    if (msgs.length > 0) {
      const newest = msgs[0]!.date ? new Date(msgs[0]!.date * 1000).toISOString() : "?";
      const oldest = msgs[msgs.length - 1]!.date ? new Date(msgs[msgs.length - 1]!.date * 1000).toISOString() : "?";
      deps.log.info({ chatId: chat.tgChatId, count: msgs.length, newest, oldest }, "mini-catchup: страница получена");
    }
    const cutoff = Date.now() - deps.config.CATCHUP_HOURS * 3600_000;
    for (const m of msgs) {
      const id = typeof m.id === "number" ? m.id : Number(m.id);
      if (lastId != null && id <= lastId) continue;
      const date = m.date ? m.date * 1000 : Date.now();
      if (date < cutoff) continue; // старые сообщения не подтягиваем
      if (m.action) continue;
      const norm = normalizeMessage(m.message ?? "");
      if (norm.junk) continue;
      deps.queue.push({
        chatId: chat.tgChatId,
        tgMsgId: id,
        authorId: typeof m.senderId === "number" ? m.senderId : null,
        authorName: null,
        text: norm.text,
        lang: norm.lang,
        ts: m.date ? new Date(m.date * 1000) : new Date(),
        isOutgoing: m.out === true,
        replyToTgMsgId: typeof m.replyToMsgId === "number" ? m.replyToMsgId : null,
      });
      pushed++;
    }
    await sleep(2500);
  }
  if (pushed > 0) deps.log.info({ pushed }, "mini-catchup: новые сообщения в очереди");
}
