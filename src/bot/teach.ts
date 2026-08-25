// /teach: пользователь присылает пример (текст/пересылку), система сохраняет якорь

import type { Bot, Context, CallbackQueryContext } from "grammy";
import { InlineKeyboard } from "grammy";
import type { SettingsStore } from "../settings";
import type { LlmClient } from "../llm/client";
import type pino from "pino";
import { addExample } from "../learn/anchors";
import { z } from "zod";

export interface TeachDeps {
  store: SettingsStore;
  llm: LlmClient;
  log: pino.Logger;
}

const teachSchema = z.object({
  topic: z.string(),
  should_track: z.boolean(),
  relevance_explanation: z.string(),
});

export function registerTeach(bot: Bot, deps: TeachDeps): void {
  bot.command("teach", (ctx) => teachStart(ctx, deps));
  bot.command("teach_done", (ctx) => teachDone(ctx, deps));
  bot.on("message", (ctx, next) => teachCollect(ctx, deps, next));
  bot.callbackQuery(/^cb:teach_save:(\d+):(\d)$/, async (ctx) => {
    const from = Number(ctx.match[1]);
    const confirm = Number(ctx.match[2]);
    if (ctx.from?.id !== from) { await ctx.answerCallbackQuery("Доступ запрещён"); return; }
    if (confirm === 1) {
      teachState.delete(from);
      await ctx.answerCallbackQuery("Отменено");
      await ctx.deleteMessage().catch(() => {});
      return;
    }
    const texts = teachState.get(from);
    if (!texts || texts.length === 0) { await ctx.answerCallbackQuery("Нет собранных примеров"); return; }
    const call = await deps.llm.teach(
      "Определи тему текста. Ответь строгим JSON: {\"topic\":\"короткая тема\"}",
      `Текст: ${texts.join("\n---\n").slice(0, 3000)}`,
    );
    const topic = call.result?.topic ?? "пример";
    await saveExample(ctx, deps, texts, topic);
    await ctx.deleteMessage().catch(() => {});
  });
}

async function teachDone(ctx: Context, deps: TeachDeps): Promise<void> {
  const from = ctx.from?.id;
  if (from == null) return;
  const collected = teachState.get(from);
  if (!collected || collected.length === 0) {
    await ctx.reply("Нет собранных примеров. Начните с /teach");
    return;
  }
  await finishTeach(ctx, deps, from, collected);
}

const teachState = new Map<number, string[]>(); // fromId -> собранные тексты

async function owner(ctx: Context, store: SettingsStore): Promise<boolean> {
  const o = await store.getOwnerId();
  if (ctx.from?.id !== o) {
    await ctx.reply("⛔ Доступ запрещён");
    return false;
  }
  return true;
}

async function teachStart(ctx: Context, deps: TeachDeps): Promise<void> {
  if (!(await owner(ctx, deps.store))) return;
  teachState.set(ctx.from!.id, []);
  await ctx.reply(
    "📚 Пришлите текст обсуждения или перешлите сообщения (до 10).\n" +
      "Это будет пример «вот такое нужно находить». Можно добавить комментарий — отправьте следующим сообщением.\n\n" +
      "Чтобы отменить: /cancel",
  );
}

async function teachCollect(ctx: Context, deps: TeachDeps, next: () => Promise<unknown>): Promise<void> {
  const from = ctx.from?.id;
  if (from == null || !teachState.has(from)) {
    await next();
    return;
  }
  if (ctx.message?.text === "/cancel") {
    teachState.delete(from);
    await ctx.reply("Отменено");
    return;
  }

  const collected = teachState.get(from)!;
  const text = ctx.message?.text?.trim();
  const fwd = ctx.message?.forward_origin ? collectForwardText(ctx.message) : null;
  const piece = (text ?? fwd ?? "").trim();
  if (!piece) return;

  collected.push(piece);
  if (collected.length >= 10) {
    await finishTeach(ctx, deps, from, collected);
    return;
  }
  await ctx.reply(`Принято (${collected.length}/10). Пришлите ещё или отправьте /teach_done`);
}

function collectForwardText(msg: { forward_origin?: unknown; text?: string }): string | null {
  return msg.text?.trim() || null;
}

async function finishTeach(ctx: Context, deps: TeachDeps, from: number, texts: string[]): Promise<void> {
  teachState.delete(from);
  const joined = texts.join("\n---\n");

  const call = await deps.llm.teach(
    "Ты классификатор примеров для системы мониторинга чатов. Определи тему текста и нужно ли системе учитывать подобное (если текст — про услуги/разработку/ИИ/автоматизацию для бизнеса — should_track=true). Ответь строгим JSON: {\"topic\":\"короткая тема\",\"should_track\":true,\"relevance_explanation\":\"почему\"}",
    `Текст: ${joined.slice(0, 3000)}`,
  );
  if (!call.result) {
    await ctx.reply("Не удалось разобрать пример. Попробуйте ещё раз: /teach");
    return;
  }
  const parsed = teachSchema.safeParse(call.result);
  if (!parsed.success || !parsed.data.should_track) {
    const kb = new InlineKeyboard()
      .text("Да, сохранить", `cb:teach_save:${from}:0`)
      .text("Нет", `cb:teach_save:${from}:1`);
    await ctx.reply(
      `Похоже, это не тематика мониторинга (${parsed.success ? parsed.data.relevance_explanation : "не удалось разобрать"}). Сохранить всё равно?`,
      { reply_markup: kb },
    );
    return;
  }
  await saveExample(ctx, deps, texts, parsed.data.topic);
}

export async function saveExample(ctx: Context, deps: TeachDeps, texts: string[], topic: string): Promise<void> {
  const id = await addExample({ userText: texts.join("\n---\n"), topic, source: "teach" });
  deps.log.info({ exampleId: id, topic }, "сохранён пример-якорь");
  await ctx.reply(`✅ Понял, сохранил: тема — «${topic}». Буду учитывать похожее.`);
}
