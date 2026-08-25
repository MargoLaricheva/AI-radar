// /profile_edit: анкета профиля по полям

import type { Bot, Context, CallbackQueryContext } from "grammy";
import { InlineKeyboard } from "grammy";
import type { SettingsStore } from "../settings";
import type { Profile } from "../db/schema";

export interface ProfileDeps {
  store: SettingsStore;
}

const FIELDS: { key: keyof Profile; label: string; array: boolean }[] = [
  { key: "what_i_do", label: "Чем занимаетесь", array: false },
  { key: "services", label: "Услуги (через запятую)", array: true },
  { key: "products", label: "Продукты (через запятую)", array: true },
  { key: "niches", label: "Ниши (через запятую)", array: true },
  { key: "audience", label: "Целевая аудитория", array: false },
  { key: "geography", label: "География", array: false },
  { key: "topics", label: "Интересующие темы (через запятую)", array: true },
  { key: "style", label: "Стиль общения", array: false },
];

const pending = new Map<number, { field: keyof Profile; array: boolean }>();

export function registerProfileEdit(bot: Bot, deps: ProfileDeps): void {
  bot.command("profile_edit", (ctx) => showFields(ctx, deps));
  bot.callbackQuery(/^cb:prof_field:(.+)$/, (ctx) => askValue(ctx, deps));
  bot.on("message:text", async (ctx) => {
    const from = ctx.from?.id;
    if (from == null) return;
    const p = pending.get(from);
    if (!p) return;
    const text = ctx.message.text.trim();
    if (text === "/cancel") {
      pending.delete(from);
      await ctx.reply("Отменено");
      return;
    }
    const patch: Partial<Profile> = {};
    const value: string | string[] = p.array ? text.split(",").map((x) => x.trim()).filter(Boolean) : text;
    (patch as Record<string, unknown>)[p.field] = value;
    await deps.store.updateProfile(patch);
    pending.delete(from);
    await ctx.reply(`✅ Поле «${FIELDS.find((f) => f.key === p.field)?.label}» обновлено. /profile — посмотреть`);
  });
}

async function owner(ctx: Context, store: SettingsStore): Promise<boolean> {
  const o = await store.getOwnerId();
  if (ctx.from?.id !== o) {
    await ctx.reply("⛔ Доступ запрещён");
    return false;
  }
  return true;
}

async function showFields(ctx: Context, deps: ProfileDeps): Promise<void> {
  if (!(await owner(ctx, deps.store))) return;
  const profile = await deps.store.getProfile();
  const kb = new InlineKeyboard();
  for (const f of FIELDS) {
    const current = profile[f.key];
    const val = Array.isArray(current) ? current.join(", ") : (current ?? "");
    kb.text(`${f.label}: ${val ? val.slice(0, 20) : "—"}`, `cb:prof_field:${f.key}`).row();
  }
  kb.text("Готово", `cb:prof_done`);
  await ctx.reply("Выберите поле для редактирования (текущее значение в скобках):", { reply_markup: kb });
}

async function askValue(ctx: Context, deps: ProfileDeps): Promise<void> {
  if (!(await owner(ctx, deps.store))) return;
  const key = (ctx.match as RegExpMatchArray)[1] as keyof Profile;
  const f = FIELDS.find((x) => x.key === key);
  if (!f) return;
  pending.set(ctx.from!.id, { field: key, array: f.array });
  await ctx.reply(`Введите значение для «${f.label}»:${f.array ? "\n(через запятую)" : ""}\n/teach_cancel — отмена`);
  await ctx.answerCallbackQuery();
}

export function registerProfileDone(bot: Bot): void {
  bot.callbackQuery(/^cb:prof_done$/, async (ctx) => {
    pending.delete(ctx.from?.id ?? 0);
    await ctx.answerCallbackQuery("Готово");
    await ctx.deleteMessage().catch(() => {});
  });
}
