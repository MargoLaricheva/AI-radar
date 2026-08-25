import { beforeAll, describe, expect, test } from "bun:test";
import { applyLike, applyDislike, createFeedbackService, type FeedbackService } from "../../src/learn/weights";
import { ensureConversation, upsertOpportunity } from "../../src/pipeline/opportunity";
import { applyWeights, basePriority } from "../../src/pipeline/score";
import type { AnalysisResult } from "../../src/llm/schema";

function feedbackResult(): AnalysisResult {
  return {
    relevance: 70, purchase_intent: 60, engagement_opportunity: 50, future_potential: 40, urgency: 30,
    client_probability: 55, type: "WARM_LEAD", signal_track: "client", relatedness: "direct",
    stage: "looking_for_provider", trajectory: null, topic: "тема", summary: "сводка", reasoning: ["r"],
    talking_points: ["t"], avoid: ["a"], recommended_action: "ra", suggested_message: "sm",
  };
}
import { createSettingsStore, type SettingsStore } from "../../src/settings";
import { createDb } from "../../src/db/client";

const url = process.env.DATABASE_URL_TEST ?? "postgres://radar@localhost:5432/radar";
const db = createDb(url);

beforeAll(async () => {
  await db.execute("truncate table users cascade");
});

async function makeStore(): Promise<SettingsStore> {
  return createSettingsStore(db);
}

function fakeFeedback(dislikeCounts: Map<string, number>): FeedbackService {
  return {
    async record() {
      return true;
    },
    async topicDislikeCount(topic) {
      return dislikeCounts.get(topic) ?? 0;
    },
    async chatDislikeCount() {
      return 0;
    },
  };
}

describe("weights", () => {
  test("лайк повышает тему, чат и тип", async () => {
    const store = await makeStore();
    await applyLike(store, "разработка сайтов", 7, "WARM_LEAD");
    const w = await store.getWeights();
    expect(w.topics["разработка сайтов"]).toBeCloseTo(1.2, 5);
    expect(w.chats["7"]).toBeCloseTo(1.1, 5);
    expect(w.types["WARM_LEAD"]).toBeCloseTo(1.1, 5);
  });

  test("лайки капаются на 3.0", async () => {
    const store = await makeStore();
    for (let i = 0; i < 10; i++) await applyLike(store, "тема кап", null, "DISCUSSION");
    const w = await store.getWeights();
    expect(w.topics["тема кап"]).toBeLessThanOrEqual(3.0);
  });

  test("дизлайк понижает тему", async () => {
    const store = await makeStore();
    const fb = fakeFeedback(new Map([["реклама", 0]]));
    await applyLike(store, "реклама", null, "DISCUSSION");
    await applyDislike(store, fb, "реклама", null);
    const w = await store.getWeights();
    expect(w.topics["реклама"]).toBeCloseTo(1.2 * 0.8, 5);
  });

  test("2 дизлайка → blacklist (вес 0.05) и тема в чёрном списке", async () => {
    const store = await makeStore();
    const fb = fakeFeedback(new Map([["диваны", 2]]));
    await applyDislike(store, fb, "диваны", null);
    const w = await store.getWeights();
    expect(w.topics["диваны"]).toBe(0.05);
    const s = await store.getSettings();
    expect(s.blacklisted_topics).toContain("диваны");
  });

  test("фидбек записывается один раз на opportunity", async () => {
    const fb = createFeedbackService(await makeStore(), db);
    await db.execute("truncate table feedback, opportunities, conversations cascade");
    const conv = await ensureConversation(9002, 660001, new Date(), 2, db);
    const r = feedbackResult();
    const ev = await upsertOpportunity(conv, 9002, r, applyWeights(basePriority(r), r, undefined, 9002), db);
    const first = await fb.record("like", ev.opportunityId, "тема", 9002);
    const second = await fb.record("like", ev.opportunityId, "тема", 9002);
    expect(first).toBe(true);
    expect(second).toBe(false);
    const dis = await fb.record("dislike", ev.opportunityId, "тема", 9002);
    expect(dis).toBe(true); // другой kind — допустимо
  });
});
