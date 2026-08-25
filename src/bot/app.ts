// grammY бот: регистрация команд, кнопок, настроек, анкеты профиля, /teach

import { Bot } from "grammy";
import type pino from "pino";
import type { SettingsStore } from "../settings";
import type { LlmClient } from "../llm/client";
import type { FeedbackService } from "../learn/weights";
import type { CommandDeps } from "./commands";
import { registerButtons } from "./buttons";
import { registerCommands } from "./commands";
import { registerSettings } from "./settings";
import { registerProfileEdit, registerProfileDone } from "./profile";
import { registerTeach } from "./teach";
import { registerSummary } from "./summary";

export interface BotDeps {
  token: string;
  log: pino.Logger;
  store: SettingsStore;
  llm: LlmClient;
  feedback: FeedbackService;
  cmdDeps: CommandDeps;
}

export function createBotApp(deps: BotDeps): Bot {
  const bot = new Bot(deps.token);

  bot.catch((err) => {
    deps.log.error({ err: String(err.error), ctx: err.ctx?.update?.message?.text ?? "" }, "ошибка бота");
  });

  registerCommands(bot, deps.cmdDeps);
  registerButtons(bot, { store: deps.store, feedback: deps.feedback });
  registerSettings(bot, { store: deps.store, log: deps.log });
  registerProfileEdit(bot, { store: deps.store });
  registerProfileDone(bot);
  registerTeach(bot, { store: deps.store, llm: deps.llm, log: deps.log });
  registerSummary(bot, { store: deps.store });

  return bot;
}
