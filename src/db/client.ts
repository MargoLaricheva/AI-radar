import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>;

export function createDb(url: string) {
  const client = postgres(url, { max: 10, idle_timeout: 20 });
  return drizzle(client, { schema });
}

let _db: Db | undefined;

export function getDb(url?: string): Db {
  if (!_db) _db = createDb(url ?? Bun.env.DATABASE_URL!);
  return _db;
}

export async function checkDb(db: Db): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}
