// Рендер карточек возможностей и клавиатур.
// Детали — в expandable blockquote (rich text Bot API 7+): свёрнуто, разворачивается тапом.

import { InlineKeyboard } from "grammy";
import type { Opportunity, Chat } from "../db/schema";
import { TYPE_LABELS } from "../pipeline/score";
import { buildMessageLink } from "../tg/deep-link";

export interface CardContext {
  opp: Opportunity;
  chat: Chat | null;
}

/** Экранирование HTML в пользовательских полях (иначе ломает разметку) */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function cardText(ctx: CardContext, detailed = false): string {
  const { opp, chat } = ctx;
  const lines: string[] = [];

  lines.push(`${TYPE_LABELS[opp.type]} · шанс на клиента: ${Math.round(opp.clientProbability)}%`);
  lines.push(`Чат: ${chat?.title ? esc(chat.title) : `#${opp.chatId}`}`);
  lines.push("");
  lines.push(`📌 Суть: ${esc(opp.summary)}`);

  // Детали: видимы всегда, но в свёрнутом режиме — внутри expandable-блока
  const details: string[] = [];
  const points = (opp.talkingPoints ?? []).slice(0, 3);
  if (points.length > 0) {
    details.push(`💡 Тезисы: ${points.map((p) => `• ${esc(p)}`).join(" ")}`);
  }
  if (opp.suggestedMessage) {
    details.push("");
    details.push("💬 Можно написать:");
    details.push(esc(opp.suggestedMessage));
  }
  const avoid = (opp.avoid ?? []).slice(0, 3);
  if (avoid.length > 0) {
    details.push("");
    details.push(`🚫 Не писать: ${avoid.map((a) => esc(a)).join(" · ")}`);
  }

  if (detailed) {
    details.push("");
    details.push(
      `🔍 Оценки: intent ${Math.round(opp.scores.purchaseIntent)}% · engagement ${Math.round(opp.scores.engagementOpportunity)}% · future ${Math.round(opp.scores.futurePotential)}% · urgency ${Math.round(opp.scores.urgency)}% · приоритет ${Math.round(opp.priority)}`,
    );
    if (opp.recommendedAction) {
      details.push("");
      details.push(`🎯 Рекомендация: ${esc(opp.recommendedAction)}`);
    }
    const reasoning = (opp.reasoning ?? []).slice(0, 5);
    if (reasoning.length > 0) {
      details.push("");
      details.push("Почему такие оценки:");
      reasoning.forEach((r, i) => details.push(`${i + 1}. ${esc(r)}`));
    }
    if (opp.stage) details.push(`Этап разговора: ${esc(opp.stage)}`);
  }

  if (details.length > 0) {
    const body = details.join("\n");
    lines.push("");
    lines.push(detailed ? body : `<blockquote expandable>${body}</blockquote>`);
  }

  if (opp.status !== "new" && opp.status !== "viewed") {
    lines.push("");
    lines.push(statusLabel(opp.status));
  }
  return lines.join("\n");
}

export function statusLabel(status: Opportunity["status"]): string {
  switch (status) {
    case "engaged":
      return "✅ Вы ответили";
    case "conversation":
      return "💬 Диалог идёт";
    case "lead":
      return "🤝 Лид";
    case "client":
      return "🎉 Клиент";
    case "deleted":
      return "🗑 Удалена";
    case "closed":
      return "⏹ Закрыта";
    default:
      return "";
  }
}

export function cardKeyboard(ctx: CardContext): InlineKeyboard {
  const kb = new InlineKeyboard();
  const link = buildMessageLink({ username: ctx.chat?.username, tgChatId: ctx.chat?.tgChatId ?? 0 }, ctx.opp.lastMsgId ?? 0);
  if (link) kb.url("🔗 К диалогу", link);
  kb.text("📖 Почему?", `cb:why:${ctx.opp.id}`);
  kb.row();
  kb.text("👍", `cb:like:${ctx.opp.id}`);
  kb.text("👎", `cb:dislike:${ctx.opp.id}`);
  kb.text("🗑", `cb:delete:${ctx.opp.id}`);
  return kb;
}

export function detailedKeyboard(oppId: number): InlineKeyboard {
  return new InlineKeyboard().text("← Назад", `cb:why_back:${oppId}`);
}
