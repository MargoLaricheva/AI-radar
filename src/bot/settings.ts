// /settings: поля настроек, редактирование значений, тихие часы, kill switch

import { Api } from "telegram";
import type { Bot, Context } from "grammy";
import { editOrReply } from "./menu-utils";
import { InlineKeyboard } from "grammy";
import type { SettingsStore } from "../settings";
import { loadSession, setAccountStatus, wipeAccount } from "../tg/session-store";
import type pino from "pino";

export interface SettingsDeps {
  store: SettingsStore;
  log: pino.Logger;
}

export function registerSettings(bot: Bot, deps: SettingsDeps): void {
  bot.command("settings", (ctx) => showSettings(ctx, deps));
  bot.callbackQuery(/^cb:menu:settings$/, (ctx) => showSettings(ctx, deps));
  bot.callbackQuery(/^cb:settings_back$/, (ctx) => showSettings(ctx, deps));
  bot.callbackQuery(/^cb:set_level:(.+)$/, (ctx) => setLevel(ctx, deps));
  bot.callbackQuery(/^cb:set_qh_menu$/, (ctx) => showQuietHoursMenu(ctx, deps));
  bot.callbackQuery(/^cb:set_qh_val:(.+)$/, (ctx) => setQuietHoursValue(ctx, deps));
  bot.callbackQuery(/^cb:set_field:(.+)$/, (ctx) => askFieldValue(ctx, deps));
  bot.callbackQuery(/^cb:set_pause:(1|0)$/, (ctx) => setPause(ctx, deps));
  bot.callbackQuery(/^cb:kill_switch:(\d)$/, (ctx) => killSwitch(ctx, deps));
  bot.on("message:text", (ctx, next) => handleFieldInput(ctx, deps, next));
}

async function owner(ctx: Context, store: SettingsStore): Promise<boolean> {
  const owner = await store.getOwnerId();
  if (ctx.from?.id !== owner) {
    await ctx.reply("⛔ Доступ запрещён");
    return false;
  }
  return true;
}

const LEVELS = ["critical", "important", "opportunities"] as const;
const LEVEL_LABELS: Record<string, string> = {
  critical: "🔴 Critical — только горячие",
  important: "🟠 Important — горячие и тёплые",
  opportunities: "🟢 Opportunities — все полезные",
};

const QH_PRESETS: Record<string, { start: number; end: number; label: string }> = {
  off: { start: 0, end: 0, label: "Выключены" },
  "1380-540": { start: 1380, end: 540, label: "23:00–09:00" },
  "1320-540": { start: 1320, end: 540, label: "22:00–09:00" },
  "1320-480": { start: 1320, end: 480, label: "22:00–08:00" },
};

type EditableField = "digest_time" | "filter_threshold" | "analysis_per_hour" | "thread_analyses_per_day";

const FIELD_LABELS: Record<EditableField, string> = {
  digest_time: "Время дайджеста (HH:MM)",
  filter_threshold: "Порог фильтра (0.00–1.00)",
  analysis_per_hour: "Лимит анализов/час (число)",
  thread_analyses_per_day: "Анализов на разговор/день (число)",
};

const pendingInput = new Map<number, EditableField>();

async function showSettings(ctx: Context, deps: SettingsDeps): Promise<void> {
  if (!(await owner(ctx, deps.store))) return;
  const s = await deps.store.getSettings();
  const qh = s.quiet_hours && (s.quiet_hours.start !== 0 || s.quiet_hours.end !== 0)
    ? `${fmt(s.quiet_hours.start)}–${fmt(s.quiet_hours.end)}`
    : "Выключены";

  const lines = [
    "⚙️ Настройки",
    "",
    `Уровень уведомлений: ${s.notify_level ?? "opportunities"}`,
    `Тихие часы: ${qh}`,
    `Дайджест: ${s.digest_time ?? "09:00"}`,
    `Порог фильтра: ${s.filter_threshold ?? 0.3}`,
    `Анализов/час: ${s.analysis_per_hour ?? 30}`,
    `Анализов/разговор/день: ${s.thread_analyses_per_day ?? 4}`,
    `Пауза уведомлений: ${s.paused ? "⏸ включена" : "нет"}`,
    `Оповещения: ${s.notifications_enabled === false ? "⛔ выключены (карточки в сводке)" : "✅ включены"}`,
  ];

  const kb = new InlineKeyboard();
  for (const l of LEVELS) {
    kb.text(`${LEVEL_LABELS[l]}${s.notify_level === l ? " ✅" : ""}`, `cb:set_level:${l}`).row();
  }
  kb.text(`🌙 Тихие часы: ${qh}`, `cb:set_qh_menu`).row();
  kb.text(`⏰ Дайджест: ${s.digest_time ?? "09:00"}`, `cb:set_field:digest_time`).text(`🎚 Порог: ${s.filter_threshold ?? 0.3}`, `cb:set_field:filter_threshold`).row();
  kb.text(`🔢 Анализов/час: ${s.analysis_per_hour ?? 30}`, `cb:set_field:analysis_per_hour`).text(`🧵 На разговор/день: ${s.thread_analyses_per_day ?? 4}`, `cb:set_field:thread_analyses_per_day`).row();
  kb.text(s.paused ? "▶️ Снять паузу" : "⏸ Пауза уведомлений", `cb:set_pause:${s.paused ? "0" : "1"}`);
  kb.row().text("🗑 Отключить аккаунт", `cb:kill_switch:0`).row();
  kb.text("⬅️ Назад", "cb:menu:main");

  await editOrReply(ctx, lines.join("\n"), { reply_markup: kb });
}

async function setLevel(ctx: Context, deps: SettingsDeps): Promise<void> {
  if (!(await owner(ctx, deps.store))) return;
  const level = (ctx.match as RegExpMatchArray)[1] as (typeof LEVELS)[number];
  if (!LEVELS.includes(level)) return;
  await deps.store.updateSettings({ notify_level: level });
  await ctx.answerCallbackQuery("Уровень сохранён");
  await showSettings(ctx, deps);
}

async function showQuietHoursMenu(ctx: Context, deps: SettingsDeps): Promise<void> {
  if (!(await owner(ctx, deps.store))) return;
  const kb = new InlineKeyboard();
  for (const [key, preset] of Object.entries(QH_PRESETS)) {
    kb.text(preset.label, `cb:set_qh_val:${key}`).row();
  }
  kb.text("⬅️ Назад", "cb:settings_back");
  await editOrReply(ctx, "🌙 Тихие часы (в это время карточки не приходят):", { reply_markup: kb });
  await ctx.answerCallbackQuery();
}

async function setQuietHoursValue(ctx: Context, deps: SettingsDeps): Promise<void> {
  if (!(await owner(ctx, deps.store))) return;
  const key = (ctx.match as RegExpMatchArray)[1] as string;
  const preset = QH_PRESETS[key];
  if (!preset) return;
  if (key === "off") {
    await deps.store.updateSettings({ quiet_hours: { start: 0, end: 0 } });
  } else {
    await deps.store.updateSettings({ quiet_hours: { start: preset.start, end: preset.end } });
  }
  await ctx.answerCallbackQuery("Сохранено");
  await showSettings(ctx, deps);
}

async function askFieldValue(ctx: Context, deps: SettingsDeps): Promise<void> {
  if (!(await owner(ctx, deps.store))) return;
  const field = (ctx.match as RegExpMatchArray)[1] as EditableField;
  const label = FIELD_LABELS[field];
  if (!label) return;
  pendingInput.set(ctx.from!.id, field);
  await editOrReply(ctx, `✏️ Введите значение: ${label}\nОтмена: /cancel_set`);
  await ctx.answerCallbackQuery();
}

async function handleFieldInput(ctx: Context, deps: SettingsDeps, next: () => Promise<unknown>): Promise<void> {
  const from = ctx.from?.id;
  if (from == null) {
    await next();
    return;
  }
  const field = pendingInput.get(from);
  if (!field) {
    await next();
    return;
  }
  const text = ctx.message?.text?.trim() ?? "";
  if (!text) return;
  if (text === "/cancel_set") {
    pendingInput.delete(from);
    await ctx.reply("Отменено");
    return;
  }
  let patch: Parameters<SettingsStore["updateSettings"]>[0];
  switch (field) {
    case "digest_time": {
      if (!/^\d{2}:\d{2}$/.test(text)) {
        await ctx.reply("❌ Формат HH:MM, например 09:00");
        return;
      }
      patch = { digest_time: text };
      break;
    }
    case "filter_threshold": {
      const v = Number(text.replace(",", "."));
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        await ctx.reply("❌ Число от 0 до 1, например 0.3");
        return;
      }
      patch = { filter_threshold: v };
      break;
    }
    case "analysis_per_hour": {
      const v = Number(text);
      if (!Number.isInteger(v) || v < 1 || v > 500) {
        await ctx.reply("❌ Целое число от 1 до 500");
        return;
      }
      patch = { analysis_per_hour: v };
      break;
    }
    case "thread_analyses_per_day": {
      const v = Number(text);
      if (!Number.isInteger(v) || v < 1 || v > 50) {
        await ctx.reply("❌ Целое число от 1 до 50");
        return;
      }
      patch = { thread_analyses_per_day: v };
      break;
    }
    default:
      return;
  }
  pendingInput.delete(from);
  await deps.store.updateSettings(patch);
  await ctx.reply("✅ Сохранено");
  await showSettings(ctx, deps);
}

async function setPause(ctx: Context, deps: SettingsDeps): Promise<void> {
  if (!(await owner(ctx, deps.store))) return;
  const paused = (ctx.match as RegExpMatchArray)[1] === "1";
  await deps.store.updateSettings({ paused });
  await ctx.answerCallbackQuery(paused ? "Пауза включена" : "Пауза снята");
  await showSettings(ctx, deps);
}

async function killSwitch(ctx: Context, deps: SettingsDeps): Promise<void> {
  if (!(await owner(ctx, deps.store))) return;
  const step = Number((ctx.match as RegExpMatchArray)[1]);
  if (step === 0) {
    const kb = new InlineKeyboard()
      .text("Да, отключить и стереть ВСЕ данные", `cb:kill_switch:1`)
      .text("Отмена", `cb:kill_switch:2`);
    await editOrReply(ctx, "⚠️ Это удалит: сессию Telegram, все сообщения, возможности, историю. Продолжить?", { reply_markup: kb });
    await ctx.answerCallbackQuery();
    return;
  }
  if (step === 2) {
    await ctx.answerCallbackQuery("Отменено");
    await showSettings(ctx, deps);
    return;
  }
  try {
    const session = await loadSession();
    const { createTelegramClient } = await import("../tg/client");
    if (session) {
      const client = createTelegramClient(session);
      try {
        await client.connect();
        await client.invoke(new Api.auth.LogOut()).catch(() => {});
        await client.disconnect();
      } catch {
        // сессия уже невалидна
      }
    }
  } catch (err) {
    deps.log.warn({ err: String(err) }, "kill switch: ошибка logout");
  }
  await wipeAccount();
  await setAccountStatus("disabled");
  await editOrReply(ctx, "🗑 Аккаунт отключён, все данные удалены.");
  await ctx.answerCallbackQuery();
}

function fmt(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}
