import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client";

const url = process.env.DATABASE_URL ?? "postgres://radar:radar@localhost:5432/radar";
const db = createDb(url);

try {
  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  console.log("Миграции применены");
} finally {
  await db.$client.end();
}
