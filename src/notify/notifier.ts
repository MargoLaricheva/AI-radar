// Notification Engine: отправка карточек, тихие часы, edit in-place, повторный пуш

import { and, eq, isNull, ne } from "drizzle-orm";
import type { Bot } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { getDb } from "../db/client";
import { chats, opportunities } from "../db/schema";
import type { Env } from "../config";
import type pino from "pino";
import type { SettingsStore } from "../settings";
import type { OpportunityEvent } from "../pipeline/opportunity";
import { markCardSent } from "../pipeline/opportunity";
import { passesLevel } from "../pipeline/score";
import { cardKeyboard, cardText } from "../bot/cards";
import type { Opportunity } from "../db/schema";
import type { ThreadState } from "../pipeline/builder";

export interface NotifierDeps {
  bot: Bot;
  store: SettingsStore;
  config: Env;
  log: pino.Logger;
}

export function createNotifier(deps: NotifierDeps) {
  const db = getDb();

  async function ownerId(): Promise<number | null> {
    return deps.store.getOwnerId();
  }

  function inQuietHours(now = new Date()): Promise<boolean> {
    return (async () => {
      const qh = await deps.store.quietHours(deps.config);
      if (!qh) return false;
      const minutes = now.getHours() * 60 + now.getMinutes();
      if (qh.start < qh.end) return minutes >= qh.start && minutes < qh.end;
      return minutes >= qh.start || minutes < qh.end; // через полночь
    })();
  }

  async function loadChat(chatDbId: number) {
    return (await db.select().from(chats).where(eq(chats.id, chatDbId)).limit(1))[0] ?? null;
  }

  async function getOpp(id: number): Promise<Opportunity | null> {
    return (await db.select().from(opportunities).where(eq(opportunities.id, id)).limit(1))[0] ?? null;
  }

  const STALE_MS = 24 * 3600_000; // разговор старше суток — карточку не шлём

  /** Решение и отправка/редактирование карточки */
  async function handleOpportunity(ev: OpportunityEvent, opp: Opportunity, _thread: ThreadState): Promise<void> {
    const owner = await ownerId();
    if (owner == null) return;
    if (Date.now() - opp.lastActivityTs.getTime() > STALE_MS) return; // разговор устарел
    const settings = await deps.store.getSettings();
    const paused = settings.paused === true || settings.notifications_enabled === false;

    const pass = passesLevel(opp.type, opp.priority, settings.notify_level ?? deps.config.NOTIFY_LEVEL);
    const chat = await loadChat(opp.chatId);

    if (ev.isNew) {
      if (!pass || paused) return;
      if (await inQuietHours()) return;
      const msg = await deps.bot.api.sendMessage(owner, cardText({ opp, chat }), {
        reply_markup: cardKeyboard({ opp, chat }),
        parse_mode: "HTML",
      });
      await markCardSent(opp.id, msg.message_id);
      deps.log.info({ oppId: opp.id, priority: opp.priority }, "карточка отправлена");
      return;
    }

    // Существующая карточка: дополняем её на месте тихим edit'ом, пуш не шлём.
    // Если пользователь удалил карточку (🗑) — она больше не обновляется.
    if (opp.status === "deleted") return;
    if (opp.tgCardMsgId != null) {
      await editCard(owner, opp, chat);
      return;
    }
    // Карточку ещё не отправляли (не проходила порог ранее) — отправляем, если пора
    if (pass && !paused && !(await inQuietHours())) {
      const msg = await deps.bot.api.sendMessage(owner, cardText({ opp, chat }), {
        reply_markup: cardKeyboard({ opp, chat }),
        parse_mode: "HTML",
      });
      await markCardSent(opp.id, msg.message_id);
    }
  }

  async function editCard(owner: number, opp: Opportunity, chat: Awaited<ReturnType<typeof loadChat>>): Promise<void> {
    if (opp.tgCardMsgId == null) return;
    try {
      await deps.bot.api.editMessageText(owner, opp.tgCardMsgId, cardText({ opp, chat }), {
        reply_markup: cardKeyboard({ opp, chat }),
        parse_mode: "HTML",
      });
    } catch (err) {
      deps.log.warn({ err: String(err), oppId: opp.id }, "не удалось отредактировать карточку");
    }
  }

  /** Тихий edit карточки по объекту (например, после смены статуса трекингом) */
  async function refreshCardFor(opp: Opportunity): Promise<void> {
    const owner = await ownerId();
    if (owner == null || opp.tgCardMsgId == null) return;
    const chat = await loadChat(opp.chatId);
    await editCard(owner, opp, chat);
  }

  async function sendDirect(chatId: number, text: string, reply_markup?: InlineKeyboardMarkup): Promise<void> {
    await deps.bot.api.sendMessage(chatId, text, { reply_markup, parse_mode: "HTML" });
  }

  /** Досылка карточек, которые не были отправлены (например, из-за тихих часов) */
  async function resendPending(): Promise<number> {
    const owner = await ownerId();
    if (owner == null) return 0;
    const settings = await deps.store.getSettings();
    const level = settings.notify_level ?? deps.config.NOTIFY_LEVEL;
    if (settings.paused === true || settings.notifications_enabled === false) return 0;
    const rows = await db
      .select()
      .from(opportunities)
      .where(and(isNull(opportunities.tgCardMsgId), ne(opportunities.status, "deleted"), ne(opportunities.status, "closed")));
    let sent = 0;
    for (const opp of rows) {
      if (Date.now() - opp.lastActivityTs.getTime() > STALE_MS) continue; // устаревшие не досылаем
      if (!passesLevel(opp.type, opp.priority, level)) continue;
      const chat = await loadChat(opp.chatId);
      try {
        const msg = await deps.bot.api.sendMessage(owner, cardText({ opp, chat }), {
          reply_markup: cardKeyboard({ opp, chat }),
          parse_mode: "HTML",
        });
        await markCardSent(opp.id, msg.message_id);
        sent++;
      } catch (err) {
        deps.log.warn({ err: String(err), oppId: opp.id }, "досылка карточки не удалась");
      }
    }
    if (sent > 0) deps.log.info({ sent }, "досланы пропущенные карточки");
    return sent;
  }

  return { handleOpportunity, sendDirect, getOpp, refreshCardFor, resendPending };
}

export type Notifier = ReturnType<typeof createNotifier>;
