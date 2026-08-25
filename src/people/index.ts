// People Intelligence: агрегат участников из анализируемых окон (для дайджеста)

import { eq, gte, sql } from "drizzle-orm";
import { getDb, type Db } from "../db/client";
import { people } from "../db/schema";

const MAX_TOPICS = 20;

export async function upsertPeople(
  participants: { tgUserId: number; name: string | null }[],
  topic: string,
  db: Db = getDb(),
): Promise<void> {
  for (const p of participants) {
    const existing = await db
      .select({ id: people.id, name: people.name, topics: people.topics })
      .from(people)
      .where(eq(people.tgUserId, p.tgUserId))
      .limit(1);
    if (existing[0]) {
      const topics = existing[0].topics ?? [];
      if (!topics.includes(topic)) topics.push(topic);
      await db
        .update(people)
        .set({
          name: p.name ?? existing[0].name,
          topics: topics.slice(-MAX_TOPICS),
          relevantDiscussions: sql`${people.relevantDiscussions} + 1`,
          lastSeenTs: new Date(),
        })
        .where(eq(people.id, existing[0].id));
    } else {
      await db.insert(people).values({
        tgUserId: p.tgUserId,
        name: p.name,
        topics: [topic],
        relevantDiscussions: 1,
        lastSeenTs: new Date(),
      });
    }
  }
}

/** Топ участников по числу релевантных обсуждений за период */
export async function topPeople(limit: number, days: number, db: Db = getDb()): Promise<{ name: string; topics: string[]; count: number }[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db
    .select({ name: people.name, topics: people.topics, count: people.relevantDiscussions })
    .from(people)
    .where(gte(people.lastSeenTs, since))
    .orderBy(sql`${people.relevantDiscussions} desc`)
    .limit(limit);
  return rows.map((r) => ({ name: r.name ?? "участник", topics: r.topics ?? [], count: r.count }));
}
