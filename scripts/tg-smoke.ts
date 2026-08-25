// Smoke MTProto: подключение по существующей string session (блокер-гейт P1)
// Использование: TG_SESSION_FILE=<путь> bun scripts/tg-smoke.ts
import { readFileSync } from "node:fs";
import { createTelegramClient } from "../src/tg/client";
import { listChats } from "../src/tg/dialogs";

const file = process.env.TG_SESSION_FILE ?? "data/tg-session.txt";
const session = readFileSync(file, "utf-8").trim();
if (!session) {
  console.error("Сессия не найдена:", file);
  process.exit(1);
}

const client = createTelegramClient(session);
await client.connect();

if (!(await client.isUserAuthorized())) {
  console.error("❌ Сессия не авторизована (требуется повторный вход)");
  process.exit(1);
}

const me = await client.getMe();
console.log("✅ Авторизован:", me.firstName, "@" + me.username, "id:", me.id);

const dialogs = await listChats(client);
console.log("Диалогов (группы/каналы):", dialogs.length);
for (const d of dialogs.slice(0, 10)) {
  console.log("  -", d.tgChatId, "|", d.type, "|", d.title, "| @" + (d.username ?? "-"));
}

await client.disconnect();
console.log("OK: сессия жива, grammJS работает");
process.exit(0);
