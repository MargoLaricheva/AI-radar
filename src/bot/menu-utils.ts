// Утилита: в callback-контексте редактируем сообщение, в команде — отвечаем новым

import type { Context } from "grammy";
import type { InlineKeyboard } from "grammy";

export interface MenuOpts {
  reply_markup?: InlineKeyboard;
}

/** Edit существующего сообщения (если пришло из callback), иначе reply */
export async function editOrReply(ctx: Context, text: string, opts: MenuOpts = {}): Promise<void> {
  const sendOpts = { reply_markup: opts.reply_markup, parse_mode: "HTML" as const };
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, sendOpts);
      return;
    } catch {
      // сообщение не редактируемо (удалено/старое) — отвечаем новым
    }
  }
  await ctx.reply(text, sendOpts);
}
