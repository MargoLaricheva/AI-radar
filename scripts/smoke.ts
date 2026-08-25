// Smoke-проверка: healthz + счётчики БД + токен бота
import { sql } from "drizzle-orm";

const base = process.env.BASE_URL ?? "http://localhost:3000";

const health = await fetch(`${base}/healthz`).then((r) => r.json());
console.log("healthz:", JSON.stringify(health));

const db = (await import("../src/db/client")).getDb();
const counters = await db.execute(sql`
  select
    (select count(*) from users) as users,
    (select count(*) from chats) as chats,
    (select count(*) from messages) as messages,
    (select count(*) from opportunities) as opportunities
`);
console.log("counters:", JSON.stringify(counters[0] ?? {}));
process.exit(0);
