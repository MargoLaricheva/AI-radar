import { beforeAll, describe, expect, test } from "bun:test";
import { createDb } from "../../src/db/client";
import { chats, conversations, opportunities } from "../../src/db/schema";
import { trackMessage } from "../../src/pipeline/tracking";
import { ensureConversation, upsertOpportunity } from "../../src/pipeline/opportunity";
import { applyWeights, basePriority } from "../../src/pipeline/score";
import type { AnalysisResult } from "../../src/llm/schema";
import { eq } from "drizzle-orm";

const url = process.env.DATABASE_URL_TEST ?? "postgres://radar@localhost:5432/radar";
const db = createDb(url);
const chatDbId = 9002;
const ROOT = 770001;

function result(): AnalysisResult {
  return {
    relevance: 80,
    purchase_intent: 70,
    engagement_opportunity: 60,
    future_potential: 50,
    urgency: 40,
    client_probability: 65,
    type: "WARM_LEAD",
    signal_track: "client",
    relatedness: "direct",
    stage: "looking_for_provider",
    trajectory: null,
    topic: "тест-разработка",
    summary: "Ищет подрядчика",
    reasoning: ["прямой запрос"],
    talking_points: ["кейс"],
    avoid: ["не продавать"],
    recommended_action: "ответить",
    suggested_message: "Привет",
  };
}

async function oppStatus(): Promise<string | null> {
  const rows = await db.select({ status: opportunities.status }).from(opportunities);
  return rows[0]?.status ?? null;
}

beforeAll(async () => {
  await db.execute("truncate table opportunities, conversations, feedback cascade");
  await db.insert(chats).values({ id: chatDbId, tgChatId: 999002, title: "Трек-чат", type: "megagroup" }).onConflictDoNothing();
  const conv = await ensureConversation(chatDbId, ROOT, new Date(), 3, db);
  const r = result();
  await upsertOpportunity(conv, chatDbId, r, applyWeights(basePriority(r), r, undefined, chatDbId), db);
});

describe("tracking", () => {
  test("ответ владельца → engaged, ответ собеседника → conversation", async () => {
    await trackMessage(chatDbId, ROOT, true, null, db);
    expect(await oppStatus()).toBe("engaged");
    await trackMessage(chatDbId, ROOT, false, null, db);
    expect(await oppStatus()).toBe("conversation");
  });

  test("удалённая карточка не перетрекивается", async () => {
    await db.update(opportunities).set({ status: "deleted" });
    await trackMessage(chatDbId, ROOT, true, null, db);
    expect(await oppStatus()).toBe("deleted");
  });

  test("нет разговора в БД — тихий пропуск", async () => {
    await db.update(opportunities).set({ status: "new" });
    await expect(trackMessage(chatDbId, 999999, true, null, db)).resolves.toBeUndefined();
  });
});
