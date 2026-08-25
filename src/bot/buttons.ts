// Callback-обработчики кнопок карточки: 👍 👎 🗑 📖

import { eq } from "drizzle-orm";
import type { Bot, CallbackQueryContext, Context } from "grammy";
import { getDb } from "../db/client";
import { chats, opportunities } from "../db/schema";
import type { SettingsStore } from "../settings";
import type { FeedbackService } from "../learn/weights";
import { applyDislike, applyLike } from "../learn/weights";
import { cardKeyboard, cardText, detailedKeyboard } from "./cards";

export interface ButtonDeps {
  store: SettingsStore;
  feedback: FeedbackService;
  db?: ReturnType<typeof getDb>;
}

export function registerButtons(bot: Bot, deps: ButtonDeps): void {
  bot.callbackQuery(/^cb:like:(\d+)$/, (ctx) => handleLike(ctx, deps));
  bot.callbackQuery(/^cb:dislike:(\d+)$/, (ctx) => handleDislike(ctx, deps));
  bot.callbackQuery(/^cb:delete:(\d+)$/, (ctx) => handleDelete(ctx, deps));
  bot.callbackQuery(/^cb:why:(\d+)$/, (ctx) => handleWhy(ctx, deps));
  bot.callbackQuery(/^cb:why_back:(\d+)$/, (ctx) => handleWhyBack(ctx, deps));
}

async function loadCard(deps: ButtonDeps, oppId: number) {
  const db = deps.db ?? getDb();
  const opp = (await db.select().from(opportunities).where(eq(opportunities.id, oppId)).limit(1))[0];
  if (!opp) return null;
  const chat = (await db.select().from(chats).where(eq(chats.id, opp.chatId)).limit(1))[0] ?? null;
  return { opp, chat };
}

async function handleLike(ctx: CallbackQueryContext<Context>, deps: ButtonDeps): Promise<void> {
  const oppId = Number(ctx.match[1]);
  const card = await loadCard(deps, oppId);
  if (!card) { await ctx.answerCallbackQuery("Карточка не найдена"); return; }
  const recorded = await deps.feedback.record("like", oppId, card.opp.topic, card.opp.chatId);
  if (!recorded) { await ctx.answerCallbackQuery("Уже учтено"); return; }
  await applyLike(deps.store, card.opp.topic, card.opp.chatId, card.opp.type);
  await ctx.answerCallbackQuery("👍 Приоритет темы повышен");
  await refreshCard(ctx, card.opp.id, deps);
}

async function handleDislike(ctx: CallbackQueryContext<Context>, deps: ButtonDeps): Promise<void> {
  const oppId = Number(ctx.match[1]);
  const card = await loadCard(deps, oppId);
  if (!card) { await ctx.answerCallbackQuery("Карточка не найдена"); return; }
  const recorded = await deps.feedback.record("dislike", oppId, card.opp.topic, card.opp.chatId);
  if (!recorded) { await ctx.answerCallbackQuery("Уже учтено"); return; }
  await applyDislike(deps.store, deps.feedback, card.opp.topic, card.opp.chatId);
  await ctx.answerCallbackQuery("👎 Учтено, тема понижена");

  const dislikes = await deps.feedback.chatDislikeCount(card.opp.chatId);
  if (dislikes >= 3) {
    await ctx.reply(
      `Чат «${card.chat?.title ?? ""}» получает много дизлайков. Убрать его из мониторинга?`,
      { reply_markup: { inline_keyboard: [[{ text: "✅ Убрать чат", callback_data: `cb:unwatch:${card.opp.chatId}` }]] } },
    );
  }
  await refreshCard(ctx, card.opp.id, deps);
}

async function handleDelete(ctx: CallbackQueryContext<Context>, deps: ButtonDeps): Promise<void> {
  const oppId = Number(ctx.match[1]);
  const db = deps.db ?? getDb();
  const card = await loadCard(deps, oppId);
  if (!card) { await ctx.answerCallbackQuery("Карточка не найдена"); return; }
  await deps.feedback.record("delete", oppId, card.opp.topic, card.opp.chatId);
  await db.update(opportunities).set({ status: "deleted" }).where(eq(opportunities.id, oppId));
  try {
    await ctx.deleteMessage();
  } catch {
    // сообщение уже удалено
  }
  await ctx.answerCallbackQuery("Карточка удалена");
}

async function handleWhy(ctx: CallbackQueryContext<Context>, deps: ButtonDeps): Promise<void> {
  const oppId = Number(ctx.match[1]);
  const card = await loadCard(deps, oppId);
  if (!card) { await ctx.answerCallbackQuery("Карточка не найдена"); return; }
  if (card.opp.status === "new") {
    await (deps.db ?? getDb()).update(opportunities).set({ status: "viewed" }).where(eq(opportunities.id, oppId));
  }
  try {
    await ctx.editMessageText(cardText(card, true), {
      reply_markup: detailedKeyboard(oppId),
      parse_mode: "HTML",
    });
  } catch {
    // сообщение удалено/не изменилось — не ошибка
  }
  await ctx.answerCallbackQuery();
}

async function handleWhyBack(ctx: CallbackQueryContext<Context>, deps: ButtonDeps): Promise<void> {
  const oppId = Number(ctx.match[1]);
  const card = await loadCard(deps, oppId);
  if (!card) { await ctx.answerCallbackQuery("Карточка не найдена"); return; }
  try {
    await ctx.editMessageText(cardText(card, false), {
      reply_markup: cardKeyboard(card),
      parse_mode: "HTML",
    });
  } catch {
    // сообщение удалено/не изменилось — не ошибка
  }
  await ctx.answerCallbackQuery();
}

async function refreshCard(ctx: CallbackQueryContext<Context>, oppId: number, deps: ButtonDeps): Promise<void> {
  const card = await loadCard(deps, oppId);
  if (!card) return;
  await ctx.editMessageText(cardText(card, false), {
    reply_markup: cardKeyboard(card),
    parse_mode: "HTML",
  });
}
