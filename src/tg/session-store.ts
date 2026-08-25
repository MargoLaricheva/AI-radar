import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { tgAccounts, users } from "../db/schema";
import { decryptSession, encryptSession, getKey } from "../security/session-crypto";
import { loadConfig } from "../config";

const config = loadConfig();
const key = getKey(config.SESSION_KEY);

/** Сохранение session-строки (зашифрованной) для единственного пользователя */
export async function saveSession(session: string): Promise<void> {
  const db = getDb();
  const encrypted = encryptSession(session, key);
  const user = await db.select({ id: users.id }).from(users).limit(1);
  const userId = user[0]?.id ?? (await db.insert(users).values({}).returning({ id: users.id }))[0]!.id;
  const existing = await db.select({ id: tgAccounts.id }).from(tgAccounts).limit(1);
  if (existing[0]) {
    await db
      .update(tgAccounts)
      .set({ sessionEncrypted: encrypted, status: "active", lastSyncAt: new Date() })
      .where(eq(tgAccounts.id, existing[0].id));
  } else {
    await db.insert(tgAccounts).values({ userId, sessionEncrypted: encrypted, status: "active" });
  }
}

export async function loadSession(): Promise<string | null> {
  const db = getDb();
  const row = await db.select({ enc: tgAccounts.sessionEncrypted }).from(tgAccounts).limit(1);
  if (!row[0]) return null;
  try {
    return decryptSession(row[0].enc, key);
  } catch {
    return null;
  }
}

export async function setAccountStatus(status: "active" | "needs_auth" | "disabled"): Promise<void> {
  const db = getDb();
  await db.update(tgAccounts).set({ status }).where(eq(tgAccounts.id, db.select({ id: tgAccounts.id }).from(tgAccounts).limit(1)));
}

export async function wipeAccount(): Promise<void> {
  const db = getDb();
  await db.execute(`truncate table tg_accounts, messages, conversations, opportunities, ai_analyses, feedback, notifications, people, examples cascade`);
}
