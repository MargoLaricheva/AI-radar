// Retention: удаление старых сообщений и архивов по TTL

import { and, eq, isNull, lt, or } from "drizzle-orm";
import { getDb, type Db } from "../db/client";
import { conversations, messages, opportunities, people } from "../db/schema";

export interface RetentionOpts {
  messagesDays: number;
  closedConvDays: number;
  deletedOppDays: number;
  peopleDays: number;
}

export async function runRetention(opts: RetentionOpts, db: Db = getDb()): Promise<{ messages: number; convs: number; opps: number; people: number }> {
  const cutoffMessages = new Date(Date.now() - opts.messagesDays * 86_400_000);
  const cutoffConv = new Date(Date.now() - opts.closedConvDays * 86_400_000);
  const cutoffOpp = new Date(Date.now() - opts.deletedOppDays * 86_400_000);
  const cutoffPeople = new Date(Date.now() - opts.peopleDays * 86_400_000);

  const delMessages = await db.delete(messages).where(lt(messages.ts, cutoffMessages)).returning({ id: messages.id });
  const delConvs = await db
    .delete(conversations)
    .where(and(eq(conversations.state, "closed"), lt(conversations.lastTs, cutoffConv)))
    .returning({ id: conversations.id });
  const delOpps = await db
    .delete(opportunities)
    .where(and(eq(opportunities.status, "deleted"), lt(opportunities.createdAt, cutoffOpp)))
    .returning({ id: opportunities.id });
  const delPeople = await db
    .delete(people)
    .where(or(lt(people.lastSeenTs, cutoffPeople), and(isNull(people.lastSeenTs), lt(people.createdAt, cutoffPeople))))
    .returning({ id: people.id });

  return {
    messages: delMessages.length,
    convs: delConvs.length,
    opps: delOpps.length,
    people: delPeople.length,
  };
}
