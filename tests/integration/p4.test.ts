import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDb } from "../../src/db/client";
import { chats, opportunities } from "../../src/db/schema";
import { ensureConversation, upsertOpportunity, markCardSent } from "../../src/pipeline/opportunity";
import type { AnalysisResult } from "../../src/llm/schema";
import { applyWeights, basePriority } from "../../src/pipeline/score";
import { upsertPeople, topPeople } from "../../src/people/index";

const url = process.env.DATABASE_URL_TEST ?? "postgres://radar@localhost:5432/radar";
const db = createDb(url);

const chatDbId = 9001;

function result(over: Partial<AnalysisResult> = {}): AnalysisResult {
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
    ...over,
  };
}

beforeAll(async () => {
  await db.execute("truncate table opportunities, conversations, people, feedback, notifications cascade");
  await db.insert(chats).values({ id: chatDbId, tgChatId: 999001, title: "Тест-чат", type: "megagroup" }).onConflictDoNothing();
});

describe("opportunity engine", () => {
  test("upsert создаёт новую и переиспользует существующую", async () => {
    const conv = await ensureConversation(chatDbId, 555001, new Date(), 3, db);
    const r1 = result();
    const ev1 = await upsertOpportunity(conv, chatDbId, r1, applyWeights(basePriority(r1), r1, undefined, chatDbId), db);
    expect(ev1.isNew).toBe(true);
    expect(ev1.shouldNotify).toBe(true);

    const ev2 = await upsertOpportunity(conv, chatDbId, r1, applyWeights(basePriority(r1), r1, undefined, chatDbId), db);
    expect(ev2.isNew).toBe(false);
    expect(ev2.shouldNotify).toBe(false);
    expect(ev2.opportunityId).toBe(ev1.opportunityId);
  });

  test("смена типа → shouldNotify=true", async () => {
    const conv = await ensureConversation(chatDbId, 555002, new Date(), 3, db);
    const r1 = result();
    await upsertOpportunity(conv, chatDbId, r1, applyWeights(basePriority(r1), r1, undefined, chatDbId), db);
    const hot = result({ type: "HOT_LEAD", purchase_intent: 95 });
    const ev = await upsertOpportunity(conv, chatDbId, hot, applyWeights(basePriority(hot), hot, undefined, chatDbId), db);
    expect(ev.shouldNotify).toBe(true);
    expect(ev.previousType).toBe("WARM_LEAD");
  });

  test("дельта ≥ 10 → shouldNotify=true", async () => {
    const conv = await ensureConversation(chatDbId, 555003, new Date(), 3, db);
    const r1 = result({ purchase_intent: 40 });
    await upsertOpportunity(conv, chatDbId, r1, applyWeights(basePriority(r1), r1, undefined, chatDbId), db);
    const r2 = result({ purchase_intent: 95 });
    const ev = await upsertOpportunity(conv, chatDbId, r2, applyWeights(basePriority(r2), r2, undefined, chatDbId), db);
    expect(ev.delta).toBeGreaterThanOrEqual(10);
    expect(ev.shouldNotify).toBe(true);
  });

  test("markCardSent увеличивает счётчик", async () => {
    const conv = await ensureConversation(chatDbId, 555004, new Date(), 3, db);
    const r = result();
    const ev = await upsertOpportunity(conv, chatDbId, r, applyWeights(basePriority(r), r, undefined, chatDbId), db);
    await markCardSent(ev.opportunityId, 12345, db);
    const rows = await db.select().from(opportunities).where(eq(opportunities.id, ev.opportunityId));
    expect(rows[0]!.tgCardMsgId).toBe(12345);
    expect(rows[0]!.notifyCount).toBe(1);
  });
});

describe("people", () => {
  test("upsertPeople накапливает обсуждения и темы", async () => {
    await upsertPeople([{ tgUserId: 777, name: "Пётр" }], "ecommerce", db);
    await upsertPeople([{ tgUserId: 777, name: "Пётр" }], "автоматизация", db);
    const top = await topPeople(5, 30, db);
    const p = top.find((x) => x.name === "Пётр");
    expect(p?.count).toBe(2);
    expect(p?.topics).toContain("ecommerce");
    expect(p?.topics).toContain("автоматизация");
  });
});
