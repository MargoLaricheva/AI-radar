import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

// Официальные публичные credentials Telegram Desktop (из open-source)
export const API_ID = 2040;
export const API_HASH = "b18441a1ff607e10a989891a5462e627";

export function createTelegramClient(session: string | undefined): TelegramClient {
  return new TelegramClient(new StringSession(session ?? ""), API_ID, API_HASH, {
    connectionRetries: 5,
    deviceModel: "AI Radar",
    appVersion: "0.1.0",
    systemVersion: "Linux",
    langCode: "ru",
  });
}

export function sessionToString(client: TelegramClient): string {
  return client.session.save() as unknown as string;
}
