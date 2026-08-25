// Примеры-якоря (/teach): сохранение и использование в фильтре

import { eq, and } from "drizzle-orm";
import { getDb, type Db } from "../db/client";
import { examples } from "../db/schema";
import type { Anchor } from "../pipeline/filter";
import { ensureEmbeddings, embedOne, embeddingsFailed } from "../pipeline/embeddings";

export interface ExampleRecord {
  id: number;
  userText: string;
  topic: string;
  note: string | null;
}

export async function addExample(
  record: { userText: string; source?: string; topic: string; note?: string },
  db: Db = getDb(),
): Promise<number> {
  let embedding: number[] | undefined;
  if (!embeddingsFailed()) {
    const ok = await ensureEmbeddings();
    if (ok) embedding = await embedOne(record.userText);
  }
  const rows = await db
    .insert(examples)
    .values({
      userText: record.userText,
      source: record.source ?? null,
      topic: record.topic,
      note: record.note ?? null,
      embedding: embedding ? Array.from(embedding) : null,
      enabled: true,
    })
    .returning({ id: examples.id });
  return rows[0]!.id;
}

export async function listExamples(enabledOnly = true, db: Db = getDb()): Promise<ExampleRecord[]> {
  const rows = await db
    .select({ id: examples.id, userText: examples.userText, topic: examples.topic, note: examples.note })
    .from(examples)
    .where(enabledOnly ? eq(examples.enabled, true) : undefined)
    .orderBy(examples.createdAt);
  return rows;
}

export async function getAnchors(db: Db = getDb()): Promise<Anchor[]> {
  const rows = await db
    .select({ id: examples.id, userText: examples.userText, embedding: examples.embedding, enabled: examples.enabled })
    .from(examples)
    .where(eq(examples.enabled, true));
  return rows
    .filter((r) => r.embedding && r.embedding.length > 0)
    .map((r) => ({ id: r.id, text: r.userText, embedding: r.embedding ?? undefined, enabled: r.enabled }));
}

export async function toggleExample(id: number, enabled: boolean, db: Db = getDb()): Promise<void> {
  await db.update(examples).set({ enabled }).where(eq(examples.id, id));
}
