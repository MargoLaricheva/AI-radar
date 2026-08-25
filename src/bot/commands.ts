// Команды бота: /chats /history /card /digest /profile /stats /status /pause /resume

import { and, desc, eq } from "drizzle-orm";
import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { getDb } from "../db/client";
import { chats, opportunities } from "../db/schema";
import type { SettingsStore } from "../settings";
import type pino from "pino";
import { findChatToAdd, loadFilteredChats, scanAllChats, upsertChatInfo } from "../tg/dialogs";
import type { TelegramClient } from "telegram";
import { cardKeyboard, cardText } from "./cards";
import { editOrReply } from "./menu-utils";
import { buildMessageLink } from "../tg/deep-link";
import { sql } from "drizzle-orm";

export interface CommandDeps {
  store: SettingsStore;
  log: pino.Logger;
  tgClient: () => TelegramClient | null;
  db?: ReturnType<typeof getDb>;
}

const PAGE_SIZE = 10;

export function registerCommands(bot: Bot, deps: CommandDeps): void {
  bot.command("start", (ctx) => cmdStart(ctx, deps));
  bot.command("chats", (ctx) => cmdChats(ctx, deps, 0));
  bot.callbackQuery(/^cb:chat_list:(\d+)$/, (ctx) => cmdChats(ctx, deps, Number((ctx.match as RegExpMatchArray)[1])));
  bot.callbackQuery(/^cb:chat_toggle:(-?\d+):(\d+)$/, (ctx) => toggleChat(ctx, deps, Number((ctx.match as RegExpMatchArray)[1]), Number((ctx.match as RegExpMatchArray)[2])));
  bot.callbackQuery(/^cb:unwatch:(\d+)$/, (ctx) => unwatchChat(ctx, deps, Number((ctx.match as RegExpMatchArray)[1])));
  bot.command("history", (ctx) => cmdHistory(ctx, deps, 0));
  bot.callbackQuery(/^cb:hist:(\d+)$/, (ctx) => cmdHistory(ctx, deps, Number((ctx.match as RegExpMatchArray)[1])));
  bot.command("card", (ctx) => cmdCard(ctx, deps));
  bot.command("digest", (ctx) => sendDigestNow(ctx, deps));
  bot.command("profile", (ctx) => cmdProfile(ctx, deps));
  bot.command("stats", (ctx) => cmdStats(ctx, deps));
  bot.command("status", (ctx) => cmdStatus(ctx, deps));
  bot.command("pause", (ctx) => cmdPause(ctx, deps, true));
  bot.command("resume", (ctx) => cmdPause(ctx, deps, false));
  bot.command("help", (ctx) => cmdHelp(ctx, deps));
  bot.callbackQuery(/^cb:menu:main$/, (ctx) => showMainMenu(ctx, deps));
  bot.callbackQuery(/^cb:menu:chats$/, (ctx) => cmdChats(ctx, deps, 0));
  bot.callbackQuery(/^cb:scan_chats$/, (ctx) => scanChats(ctx, deps));
  bot.callbackQuery(/^cb:add_chat$/, (ctx) => startAddChat(ctx, deps));
  bot.callbackQuery(/^cb:add_pick:(\d+)$/, (ctx) => pickChatFromList(ctx, deps));
  bot.on("message:text", (ctx, next) => handleAddChatText(ctx, deps, next));
  bot.callbackQuery(/^cb:menu:history$/, (ctx) => cmdHistory(ctx, deps, 0));
  bot.callbackQuery(/^cb:menu:profile$/, (ctx) => cmdProfile(ctx, deps));
  bot.callbackQuery(/^cb:menu:profile_edit$/, async (ctx) => {
    if (!(await requireOwner(ctx, deps))) return;
    const { registerProfileEdit } = await import("./profile");
    await ctx.reply("Для редактирования используйте: /profile_edit");
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery(/^cb:menu:stats$/, (ctx) => cmdStats(ctx, deps));
  bot.callbackQuery(/^cb:toggle_notify$/, (ctx) => toggleNotifications(ctx, deps));
  bot.callbackQuery(/^cb:menu:teach$/, async (ctx) => {
    if (!(await requireOwner(ctx, deps))) return;
    await ctx.reply("Для обучения системе отправьте: /teach — и пришлите пример текста или перешлите сообщение");
    await ctx.answerCallbackQuery();
  });
  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message?.text?.trim().toLowerCase();
    if (text !== "меню" && text !== "menu" && text !== "главное меню") return next();
    if (!(await requireOwner(ctx, deps))) return;
    await showMainMenu(ctx, deps);
  });
  bot.callbackQuery(/^cb:open_hist:(\d+)$/, async (ctx) => {
    if (!(await requireOwner(ctx, deps))) return;
    const db = deps.db ?? getDb();
    const id = Number((ctx.match as RegExpMatchArray)[1]);
    const opp = (await db.select().from(opportunities).where(eq(opportunities.id, id)).limit(1))[0];
    if (!opp) { await ctx.answerCallbackQuery("Не найдена"); return; }
    const chat = (await db.select().from(chats).where(eq(chats.id, opp.chatId)).limit(1))[0] ?? null;
    try {
      await ctx.editMessageText(cardText({ opp, chat }), { reply_markup: cardKeyboard({ opp, chat }), parse_mode: "HTML" });
    } catch {
      // сообщение уже такое или удалено — молча пропускаем
    }
    await ctx.answerCallbackQuery();
  });
}

async function requireOwner(ctx: Context, deps: CommandDeps): Promise<boolean> {
  const owner = await deps.store.getOwnerId();
  const from = ctx.from?.id;
  if (owner == null || from == null) return false;
  if (from !== owner) {
    await ctx.reply("⛔ Доступ запрещён");
    return false;
  }
  return true;
}

async function cmdStart(ctx: Context, deps: CommandDeps): Promise<void> {
  const owner = await deps.store.getOwnerId();
  const from = ctx.from?.id;
  if (owner == null && from != null) {
    await deps.store.setOwnerId(from);
    await showMainMenu(ctx, deps, "👋 Добро пожаловать в AI Radar!\n\nВы назначены владельцем. Выберите действие:");
    return;
  }
  if (owner != null && from === owner) {
    await showMainMenu(ctx, deps, "AI Radar работает. Выберите действие:");
    return;
  }
  await ctx.reply("⛔ Доступ запрещён");
}

/** Главное меню с актуальным состоянием оповещений */
async function showMainMenu(ctx: Context, deps: CommandDeps, text = "AI Radar. Выберите действие:"): Promise<void> {
  if (!(await requireOwner(ctx, deps))) return;
  const s = await deps.store.getSettings();
  await editOrReply(ctx, text, { reply_markup: mainMenuKeyboard(s.notifications_enabled !== false) });
}

async function toggleNotifications(ctx: Context, deps: CommandDeps): Promise<void> {
  if (!(await requireOwner(ctx, deps))) return;
  const s = await deps.store.getSettings();
  const wasOn = s.notifications_enabled !== false;
  await deps.store.updateSettings({ notifications_enabled: !wasOn });
  await ctx.answerCallbackQuery(
    wasOn
      ? "⛔ Оповещения выключены: карточки копятся в сводке, пуши не приходят"
      : "🔔 Оповещения включены",
  );
  await showMainMenu(ctx, deps);
}

export interface ChatListRender {
  text: string;
  keyboard: InlineKeyboard;
}

export async function renderChatsList(db: ReturnType<typeof getDb>, page: number): Promise<ChatListRender> {
  const stored = await loadFilteredChats(db);
  const total = stored.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageSafe = Math.min(page, pages - 1);
  const slice = stored.slice(pageSafe * PAGE_SIZE, (pageSafe + 1) * PAGE_SIZE);

  const lines: string[] = [];
  if (total === 0) {
    lines.push("📋 В списке пока нет чатов.");
    lines.push("");
    lines.push("Нажмите «🔍 Просканировать чаты», чтобы найти все чаты, или «➕ Добавить чат» — по id/@username/названию.");
  } else {
    lines.push(`📋 Чаты (${total}): страница ${pageSafe + 1}/${pages}\n`);
    slice.forEach((c, i) => {
      const num = pageSafe * PAGE_SIZE + i + 1;
      const on = c.enabled ? "✅" : "⭕";
      const flood = c.msgCapExceeded ? " [флуд]" : "";
      const meta: string[] = [];
      if (c.participantsCount != null) meta.push(`${c.participantsCount} чел`);
      if (c.lastActivityAt != null) {
        const days = Math.floor((Date.now() - c.lastActivityAt.getTime()) / 86_400_000);
        meta.push(days <= 0 ? "активен сегодня" : days === 1 ? "активен вчера" : `${days} дн назад`);
      }
      const metaStr = meta.length ? ` · ${meta.join(" · ")}` : "";
      lines.push(`${num}. ${on} ${c.title}${metaStr}${flood}`);
    });
  }

  const kb = new InlineKeyboard();
  if (total > 0) {
    // кнопки 5 в ряд: галочка + номер
    const row: ReturnType<InlineKeyboard["text"]>[] = [];
    slice.forEach((c, i) => {
      const num = pageSafe * PAGE_SIZE + i + 1;
      const label = c.enabled ? `✅${num}` : `⭕${num}`;
      const btn = kb.text(label, `cb:chat_toggle:${c.tgChatId}:${pageSafe}`);
      row.push(btn);
      if (row.length === 5) {
        kb.row();
        row.length = 0;
      }
    });
    if (row.length > 0) kb.row();
    if (pages > 1) {
      kb.text("⬅️", `cb:chat_list:${Math.max(0, pageSafe - 1)}`).text("➡️", `cb:chat_list:${Math.min(pages - 1, pageSafe + 1)}`);
    }
  }
  kb.row();
  kb.text("🔍 Просканировать чаты", "cb:scan_chats");
  kb.text("➕ Добавить чат", "cb:add_chat");
  kb.text("⬅️ Назад", "cb:menu:main");
  return { text: lines.join("\n"), keyboard: kb };
}

async function cmdChats(ctx: Context, deps: CommandDeps, page: number): Promise<void> {
  if (!(await requireOwner(ctx, deps))) return;
  if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
  const db = deps.db ?? getDb();
  const { text, keyboard } = await renderChatsList(db, page);
  await editOrReply(ctx, text, { reply_markup: keyboard });
}

async function toggleChat(ctx: Context, deps: CommandDeps, tgChatId: number, page: number): Promise<void> {
  if (!(await requireOwner(ctx, deps))) return;
  const db = deps.db ?? getDb();
  const row = (await db.select().from(chats).where(eq(chats.tgChatId, tgChatId)).limit(1))[0];
  if (!row) {
    await ctx.answerCallbackQuery("Чат не в списке — сначала добавьте");
    return;
  }
  await db.update(chats).set({ enabled: !row.enabled, msgCapExceeded: false }).where(eq(chats.id, row.id));
  await ctx.answerCallbackQuery("Готово");
  await cmdChats(ctx, deps, page);
}

async function unwatchChat(ctx: Context, deps: CommandDeps, chatDbId: number): Promise<void> {
  if (!(await requireOwner(ctx, deps))) return;
  const db = deps.db ?? getDb();
  await db.update(chats).set({ enabled: false }).where(eq(chats.id, chatDbId));
  await ctx.answerCallbackQuery("Чат убран из мониторинга");
}

const pendingAddChat = new Set<number>();

async function scanChats(ctx: Context, deps: CommandDeps): Promise<void> {
  if (!(await requireOwner(ctx, deps))) return;
  await ctx.answerCallbackQuery("Сканирование запущено");
  const db = deps.db ?? getDb();
  const client = deps.tgClient();
  if (!client) { await ctx.reply("Telegram-аккаунт не подключён"); return; }
  // единое сообщение: индикатор → по завершении редактируется в итог и список
  const sent = await ctx.reply("🔍 Сканирую чаты… Это займёт 1–2 минуты.");
  try {
    const all = await scanAllChats(client, db, deps.log);
    const { text, keyboard } = await renderChatsList(db, 0);
    const { loadFilteredChats } = await import("../tg/dialogs");
    const filteredCount = (await loadFilteredChats(db)).length;
    const header = `✅ Сканирование завершено: найдено ${all.length} чатов, подходят по фильтру — ${filteredCount}.\n\n`;
    await ctx.api.editMessageText(ctx.chat!.id, sent.message_id, header + text, {
      reply_markup: keyboard,
    });
  } catch (err) {
    deps.log.error({ err: String(err) }, "сканирование чатов не удалось");
    await ctx.api
      .editMessageText(ctx.chat!.id, sent.message_id, "❌ Сканирование не удалось. Попробуйте позже.")
      .catch(() => {});
  }
}

async function startAddChat(ctx: Context, deps: CommandDeps): Promise<void> {
  if (!(await requireOwner(ctx, deps))) return;
  pendingAddChat.add(ctx.from!.id);
  await ctx.reply("➕ Отправьте id, @username или название чата. Проверю, что вы в нём состоите.\nОтмена: /cancel_add");
  await ctx.answerCallbackQuery();
}

async function handleAddChatText(ctx: Context, deps: CommandDeps, next: () => Promise<unknown>): Promise<void> {
  const from = ctx.from?.id;
  if (from == null || !pendingAddChat.has(from)) {
    await next();
    return;
  }
  const text = ctx.message?.text?.trim() ?? "";
  if (!text) return;
  if (text === "/cancel_add") {
    pendingAddChat.delete(from);
    await ctx.reply("Отменено");
    return;
  }
  pendingAddChat.delete(from);
  const client = deps.tgClient();
  if (!client) { await ctx.reply("Telegram-аккаунт не подключён"); return; }
  await ctx.reply("🔎 Ищу чат…");
  try {
    const res = await findChatToAdd(client, text);
    switch (res.kind) {
      case "resolved": {
        const info = res.chat!;
        const id = await upsertChatInfo(info);
        deps.log.info({ chatId: id, title: info.title }, "чат добавлен вручную");
        await ctx.reply(
          `✅ Добавлен: ${info.title}${info.participantsCount != null ? ` (${info.participantsCount} чел)` : ""}.\nВключите его в /chats.`,
        );
        return;
      }
      case "list": {
        const kb = new InlineKeyboard();
        for (const c of res.candidates!) {
          kb.text(`${c.title.slice(0, 35)}`, `cb:add_pick:${c.dbId}`).row();
        }
        await ctx.reply("Нашёл похожие — выберите нужный:", { reply_markup: kb });
        return;
      }
      case "not_member":
        await ctx.reply("⛔ Вы не состоите в этом чате");
        return;
      case "channel":
        await ctx.reply("📢 Это канал — мониторим только чаты (группы)");
        return;
      default:
        await ctx.reply(`❌ ${res.reason ?? "Чат не найден"}`);
    }
  } catch (err) {
    deps.log.error({ err: String(err), query: text }, "добавление чата не удалось");
    await ctx.reply("❌ Не удалось добавить чат. Попробуйте ещё раз.");
  }
}

async function pickChatFromList(ctx: Context, deps: CommandDeps): Promise<void> {
  if (!(await requireOwner(ctx, deps))) return;
  const db = deps.db ?? getDb();
  const dbId = Number((ctx.match as RegExpMatchArray)[1]);
  const row = (await db.select().from(chats).where(eq(chats.id, dbId)).limit(1))[0];
  if (!row) { await ctx.answerCallbackQuery("Чат не найден"); return; }
  await ctx.answerCallbackQuery();
  await ctx.reply(`✅ «${row.title}» уже в списке. Включите его в /chats.`);
}

async function cmdHistory(ctx: Context, deps: CommandDeps, page: number): Promise<void> {
  if (!(await requireOwner(ctx, deps))) return;
  const db = deps.db ?? getDb();
  const total = (await db.select({ n: sql<number>`count(*)` }).from(opportunities).where(ne(opportunities.status, "deleted")))[0]?.n ?? 0;
  const pages = Math.max(1, Math.ceil(total / 10));
  const pageSafe = Math.min(page, pages - 1);
  const rows = await db
    .select()
    .from(opportunities)
    .where(ne(opportunities.status, "deleted"))
    .orderBy(desc(opportunities.createdAt))
    .offset(pageSafe * 10)
    .limit(10);

  if (rows.length === 0) {
    await ctx.reply("Пока нет возможностей. Как только система найдёт первую — пришлю карточку.");
    return;
  }
  const chatIds = [...new Set(rows.map((r) => r.chatId))];
  const chatRows = chatIds.length ? await db.select().from(chats).where(inArray(chats.id, chatIds)) : [];
  const chatMap = new Map(chatRows.map((c) => [c.id, c]));

  const lines = [`📚 История: страница ${pageSafe + 1}/${pages}\n`];
  rows.forEach((r, i) => {
    const title = chatMap.get(r.chatId)?.title ?? "#" + r.chatId;
    lines.push(`${pageSafe * 10 + i + 1}. [${r.id}] ${r.type} · ${Math.round(r.priority)}% — ${r.summary.slice(0, 60)} (${title})`);
  });

  const kb = new InlineKeyboard();
  if (pages > 1) {
    kb.text("⬅️", `cb:hist:${Math.max(0, pageSafe - 1)}`).text("➡️", `cb:hist:${Math.min(pages - 1, pageSafe + 1)}`);
  }
  for (const r of rows.slice(0, 4)) {
    kb.row().text(`#${r.id}`, `cb:open_hist:${r.id}`);
  }
  kb.text("⬅️ Назад", "cb:menu:main");
  await editOrReply(ctx, lines.join("\n"), { reply_markup: kb });
}

async function cmdCard(ctx: Context & { match?: string }, deps: CommandDeps): Promise<void> {
  if (!(await requireOwner(ctx, deps))) return;
  const db = deps.db ?? getDb();
  const id = Number((ctx.match ?? "").trim());
  if (!id) {
    await ctx.reply("Формат: /card 123");
    return;
  }
  const opp = (await db.select().from(opportunities).where(eq(opportunities.id, id)).limit(1))[0];
  if (!opp) { await ctx.reply("Возможность не найдена"); return; }
  const chat = (await db.select().from(chats).where(eq(chats.id, opp.chatId)).limit(1))[0] ?? null;
  await ctx.reply(cardText({ opp, chat }), { reply_markup: cardKeyboard({ opp, chat }), parse_mode: "HTML" });
}

async function sendDigestNow(ctx: Context, deps: CommandDeps): Promise<void> {
  if (!(await requireOwner(ctx, deps))) return;
  const { buildDigest } = await import("../notify/digest");
  await ctx.reply(await buildDigest(deps));
}

async function cmdProfile(ctx: Context, deps: CommandDeps): Promise<void> {
  if (!(await requireOwner(ctx, deps))) return;
  const profile = await deps.store.getProfile();
  const lines = [
    "🧑‍💻 AI-профиль:",
    `Чем занимаетесь: ${profile.what_i_do ?? "—"}`,
    `Услуги: ${profile.services?.join(", ") ?? "—"}`,
    `Продукты: ${profile.products?.join(", ") ?? "—"}`,
    `Ниши: ${profile.niches?.join(", ") ?? "—"}`,
    `Аудитория: ${profile.audience ?? "—"}`,
    `География: ${profile.geography ?? "—"}`,
    `Темы: ${profile.topics?.join(", ") ?? "—"}`,
    `Стиль: ${profile.style ?? "—"}`,
    "",
    "Редактирование: /profile_edit",
  ];
  await ctx.reply(lines.join("\n"));
}

async function cmdStats(ctx: Context, deps: CommandDeps): Promise<void> {
  if (!(await requireOwner(ctx, deps))) return;
  const db = deps.db ?? getDb();
  const since = new Date(Date.now() - 86_400_000);
  const [opps, analyses, cost, chatsCount] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(opportunities).where(gte(opportunities.createdAt, since)),
    db.select({ n: sql<number>`count(*)` }).from(llmRequests).where(gte(llmRequests.createdAt, since)),
    db.select({ s: sql<number>`coalesce(sum(cost_usd),0)` }).from(llmRequests).where(gte(llmRequests.createdAt, since)),
    db.select({ n: sql<number>`count(*)` }).from(chats).where(eq(chats.enabled, true)),
  ]);
  await ctx.reply(
    `📊 Статистика за сутки:\nВозможностей: ${opps[0]?.n ?? 0}\nАнализов LLM: ${analyses[0]?.n ?? 0}\nРасход LLM: $${(cost[0]?.s ?? 0).toFixed(4)}\nЧатов в мониторинге: ${chatsCount[0]?.n ?? 0}`,
  );
}

async function cmdStatus(ctx: Context, deps: CommandDeps): Promise<void> {
  if (!(await requireOwner(ctx, deps))) return;
  const client = deps.tgClient();
  const auth = client ? await client.isUserAuthorized().catch(() => false) : false;
  const paused = await deps.store.isPaused();
  const settings = await deps.store.getSettings();
  await ctx.reply(
    `🛰 Состояние:\nTelegram-аккаунт: ${auth ? "✅ подключён" : "❌ не подключён"}\nУведомления: ${paused ? "⏸ на паузе" : "✅ активны"}\nУровень: ${settings.notify_level ?? "opportunities"}\nМодель LLM: ${process.env.LLM_MODEL ?? "deepseek-v4-flash"}`,
  );
}

async function cmdPause(ctx: Context, deps: CommandDeps, paused: boolean): Promise<void> {
  if (!(await requireOwner(ctx, deps))) return;
  await deps.store.updateSettings({ paused });
  await ctx.reply(paused ? "⏸ Уведомления на паузе (/resume — возобновить)" : "✅ Уведомления возобновлены");
}

function cmdHelp(ctx: Context, deps: CommandDeps): Promise<void> {
  return showMainMenu(
    ctx,
    deps,
    "🤖 AI Radar — команды:\n" +
      "/chats — выбор чатов\n/history — прошлые заявки\n/card <id> — открыть карточку\n/digest — дайджест сейчас\n" +
      "/profile — просмотр профиля\n/profile_edit — редактирование\n/settings — настройки\n/teach — научить системе\n" +
      "/pause /resume — пауза уведомлений\n/stats — расходы и счётчики\n/status — состояние",
  );
}

export function mainMenuKeyboard(notificationsOn?: boolean | null) {
  const kb = new InlineKeyboard();
  kb.text("📋 Чаты", "cb:menu:chats").text("📚 История", "cb:menu:history").row();
  kb.text("🧑\u200d💻 Профиль", "cb:menu:profile").text("⚙️ Настройки", "cb:menu:settings").row();
  kb.text("📊 Статистика", "cb:menu:stats").text("💡 Научить", "cb:menu:teach").row();
  kb.text(
    notificationsOn == null ? "🔔 Оповещения" : notificationsOn ? "🔔 Оповещения: ✅" : "🔔 Оповещения: ⛔",
    "cb:toggle_notify",
  )
    .text("📋 Сводка за день", "cb:summary").row();
  return kb;
}

import { gte, inArray, ne } from "drizzle-orm";
import { llmRequests } from "../db/schema";
