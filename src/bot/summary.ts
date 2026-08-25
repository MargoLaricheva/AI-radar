// Сводка за день: список возможностей (по 5 на страницу), пагинация кнопками-цифрами,
// тап по пункту → сообщение заменяется на полный текст карточки.

import { ne, sql } from "drizzle-orm";
import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { getDb } from "../db/client";
import { chats, opportunities } from "../db/schema";
import type { SettingsStore } from "../settings";
import { cardKeyboard, cardText } from "./cards";
import { editOrReply } from "./menu-utils";
import { TYPE_LABELS } from "../pipeline/score";

export interface SummaryDeps {
  store: SettingsStore;
}

const PAGE_SIZE = 5;
const MSK_OFFSET = 3 * 3600_000; // день считается по Москве (UTC+3)

export function registerSummary(bot: Bot, deps: SummaryDeps): void {
  bot.callbackQuery(/^cb:summary$/, (ctx) => showSummary(ctx, deps, 0));
  bot.callbackQuery(/^cb:summary:(\d+)$/, (ctx) => showSummary(ctx, deps, Number((ctx.match as RegExpMatchArray)[1])));
  bot.callbackQuery(/^cb:summary_open:(\d+):(\d+)$/, (ctx) =>
    showSummaryCard(ctx, deps, Number((ctx.match as RegExpMatchArray)[1]), Number((ctx.match as RegExpMatchArray)[2])),
  );
}

async function requireOwner(ctx: Context, store: SettingsStore): Promise<boolean> {
  const owner = await store.getOwnerId();
  if (ctx.from?.id !== owner) {
    await ctx.answerCallbackQuery("⛔ Доступ запрещён").catch(() => {});
    return false;
  }
  return true;
}

/** Начало «сегодня» по МСК в UTC-времени */
function todayStartUtc(): Date {
  const msk = new Date(Date.now() + MSK_OFFSET);
  const startMsk = new Date(Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate()));
  return new Date(startMsk.getTime() - MSK_OFFSET);
}

async function loadDayOpps(db: ReturnType<typeof getDb>, page: number) {
  // дату передаём строкой ISO: сырой Date в sql-шаблоне падает в postgres.js
  // (Buffer.from(Date) → TypeError), операторы gte/eq конвертируют сами
  const dayStart = todayStartUtc().toISOString();
  const total = (
    await db
      .select({ n: sql<number>`count(*)` })
      .from(opportunities)
      .where(sql`${opportunities.createdAt} >= ${dayStart} AND ${opportunities.status} <> 'deleted'`)
  )[0]?.n ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageSafe = Math.min(page, pages - 1);
  const rows = await db
    .select()
    .from(opportunities)
    .where(sql`${opportunities.createdAt} >= ${dayStart} AND ${opportunities.status} <> 'deleted'`)
    .orderBy(sql`${opportunities.priority} DESC NULLS LAST`)
    .offset(pageSafe * PAGE_SIZE)
    .limit(PAGE_SIZE);
  return { rows, pages, pageSafe, total };
}

async function showSummary(ctx: Context, deps: SummaryDeps, page: number): Promise<void> {
  if (!(await requireOwner(ctx, deps.store))) return;
  const db = getDb();
  let rows: Awaited<ReturnType<typeof loadDayOpps>>["rows"];
  let pages = 1;
  let pageSafe = 0;
  let total = 0;
  try {
    const res = await loadDayOpps(db, page);
    rows = res.rows;
    pages = res.pages;
    pageSafe = res.pageSafe;
    total = res.total;
  } catch (err) {
    const e = err as { message?: string; code?: string; detail?: string; query?: string };
    console.error("СВОДКА ОШИБКА:", JSON.stringify({ message: e.message, code: e.code, detail: e.detail, query: e.query }));
    await ctx.answerCallbackQuery("⚠️ Ошибка загрузки сводки").catch(() => {});
    return;
  }

  if (total === 0) {
    await editOrReply(ctx, "📋 За сегодня возможностей пока нет.", {
      reply_markup: new InlineKeyboard().text("⬅️ Назад", "cb:menu:main"),
    });
    await ctx.answerCallbackQuery();
    return;
  }

  const chatIds = [...new Set(rows.map((r) => r.chatId))];
  const chatRows = chatIds.length ? await db.select().from(chats).where(sql`${chats.id} IN (${sql.join(chatIds, sql`, `)})`) : [];
  const chatMap = new Map(chatRows.map((c) => [c.id, c]));

  const lines = [`📋 Сводка за день · страница ${pageSafe + 1}/${pages}\n`];
  rows.forEach((r, i) => {
    const chat = chatMap.get(r.chatId);
    const where = chat?.title ? ` (${chat.title})` : "";
    const label = TYPE_LABELS[r.type] ?? r.type;
    lines.push(`${pageSafe * PAGE_SIZE + i + 1}. ${label} · ${Math.round(r.priority ?? 0)}% — ${(r.summary ?? "").slice(0, 80)}${where}`);
  });
  if (rows.length < PAGE_SIZE && total > PAGE_SIZE) {
    lines.push(`…и ещё ${total - pageSafe * PAGE_SIZE - rows.length}`);
  }
  lines.push("");
  lines.push("Номер пункта — открыть карточку");

  const kb = new InlineKeyboard();
  // пункты страницы — кнопками-цифрами
  rows.forEach((r, i) => kb.text(String(pageSafe * PAGE_SIZE + i + 1), `cb:summary_open:${r.id}:${pageSafe}`));
  kb.row();
  // страницы — стрелками
  if (pages > 1) {
    kb.text("⬅️", `cb:summary:${Math.max(0, pageSafe - 1)}`).text("➡️", `cb:summary:${Math.min(pages - 1, pageSafe + 1)}`);
  }
  kb.text("⬅️ Назад", "cb:menu:main");

  await editOrReply(ctx, lines.join("\n"), { reply_markup: kb });
  await ctx.answerCallbackQuery();
}

async function showSummaryCard(ctx: Context, deps: SummaryDeps, oppId: number, page: number): Promise<void> {
  if (!(await requireOwner(ctx, deps.store))) return;
  const db = getDb();
  const opp = (await db.select().from(opportunities).where(sql`${opportunities.id} = ${oppId}`).limit(1))[0];
  if (!opp) {
    await ctx.answerCallbackQuery("Карточка не найдена");
    return;
  }
  const chat = (await db.select().from(chats).where(sql`${chats.id} = ${opp.chatId}`).limit(1))[0] ?? null;

  const kb = cardKeyboard({ opp, chat });
  kb.row().text("📋 К списку", `cb:summary:${page}`);

  await editOrReply(ctx, cardText({ opp, chat }), { reply_markup: kb });
  await ctx.answerCallbackQuery();
}
