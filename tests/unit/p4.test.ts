import { describe, expect, test } from "bun:test";
import { applyWeights, basePriority, normalizeTopicKey, passesLevel } from "../../src/pipeline/score";
import { buildWindow, buildUserPrompt } from "../../src/llm/prompts";
import type { AnalysisResult } from "../../src/llm/schema";
import { analysisSchema } from "../../src/llm/schema";

function base(): AnalysisResult {
  return {
    relevance: 80,
    purchase_intent: 60,
    engagement_opportunity: 70,
    future_potential: 50,
    urgency: 40,
    client_probability: 55,
    type: "WARM_LEAD",
    signal_track: "client",
    relatedness: "direct",
    stage: "looking_for_provider",
    trajectory: null,
    topic: "разработка сайта",
    summary: "Ищет разработчика",
    reasoning: ["прямой запрос"],
    talking_points: ["кейс"],
    avoid: ["не продавать"],
    recommended_action: "ответить",
    suggested_message: "Привет! Могу помочь",
  };
}

describe("score", () => {
  test("client-трек: intent весит больше", () => {
    const a = base();
    const b = base();
    a.purchase_intent = 90;
    b.purchase_intent = 30;
    expect(basePriority(a)).toBeGreaterThan(basePriority(b));
  });

  test("expertise-трек: engagement весит больше", () => {
    const a = base();
    a.signal_track = "expertise";
    a.engagement_opportunity = 95;
    a.purchase_intent = 10;
    expect(basePriority(a)).toBeCloseTo(0.4 * 95 + 0.3 * 50 + 0.2 * 80 + 0.1 * 10, 5);
  });

  test("NOISE → 0", () => {
    const a = base();
    a.type = "NOISE";
    expect(basePriority(a)).toBe(0);
  });

  test("веса чата/темы/типа применяются", () => {
    const a = base();
    const b = basePriority(a);
    const w = { topics: { [normalizeTopicKey(a.topic)]: 2 }, chats: { "7": 1.5 }, types: { WARM_LEAD: 1 } };
    const s = applyWeights(b, a, w, 7);
    expect(s.priority).toBeCloseTo(Math.min(100, b * 2 * 1.5), 5);
    expect(s.weightsApplied.chat).toBe(1.5);
  });

  test("нормализация ключа темы", () => {
    expect(normalizeTopicKey("  Разработка   Сайта ")).toBe("разработка сайта");
  });

  test("уровни уведомлений", () => {
    expect(passesLevel("HOT_LEAD", 85, "critical")).toBe(true);
    expect(passesLevel("HOT_LEAD", 70, "critical")).toBe(false);
    expect(passesLevel("WARM_LEAD", 70, "important")).toBe(true);
    expect(passesLevel("WARM_LEAD", 50, "important")).toBe(false);
    expect(passesLevel("DISCUSSION", 60, "opportunities")).toBe(true);
    expect(passesLevel("EXPERTISE", 52, "opportunities")).toBe(true);
    expect(passesLevel("EXPERTISE", 49, "opportunities")).toBe(false);
    expect(passesLevel("INFORMATION", 90, "opportunities")).toBe(false);
    expect(passesLevel("NOISE", 90, "opportunities")).toBe(false);
  });
});

describe("prompts", () => {
  test("buildWindow ограничивает по количеству и символам", () => {
    const msgs = Array.from({ length: 30 }, (_, i) => ({
      text: `сообщение номер ${i} для проверки окна`,
      author: "A",
      ts: new Date(),
      isOutgoing: false,
      tgMsgId: i + 1,
      replyTo: null,
    }));
    const win = buildWindow(msgs);
    expect(win.length).toBeLessThanOrEqual(15);
    expect(win[win.length - 1]!.tgMsgId).toBe(30); // последние сохраняются
  });

  test("buildUserPrompt содержит сообщения и профиль-историю", () => {
    const p = buildUserPrompt({
      messages: [
        { text: "Кто делает сайты?", author: "Иван", ts: new Date(), isOutgoing: false, tgMsgId: 1, replyTo: null },
      ],
      profile: { what_i_do: "веб-разработка" },
      personHistory: [{ name: "Иван", topics: ["ecommerce"] }],
    });
    expect(p).toContain("Кто делает сайты?");
    expect(p).toContain("Иван");
    expect(p).toContain("ecommerce");
  });
});

describe("schema", () => {
  test("валидный JSON проходит", () => {
    const r = analysisSchema.safeParse(base());
    expect(r.success).toBe(true);
  });

  test("невалидный JSON отклоняется", () => {
    const r = analysisSchema.safeParse({ ...base(), purchase_intent: 150 });
    expect(r.success).toBe(false);
    const r2 = analysisSchema.safeParse({ ...base(), type: "LEAD" });
    expect(r2.success).toBe(false);
  });
});

describe("isOwnerInvolved", () => {
  const { isOwnerInvolved } = require("../../src/pipeline/analyze");

  test("владелец в окне (своё сообщение) — true", () => {
    expect(isOwnerInvolved([
      { text: "Кто делает ботов?", author: "123", ts: new Date(), isOutgoing: false, tgMsgId: 1, replyTo: null },
      { text: "Я могу помочь", author: "999", ts: new Date(), isOutgoing: false, tgMsgId: 2, replyTo: null },
    ], 999)).toBe(true);
  });

  test("владелец ответил (isOutgoing) — true", () => {
    expect(isOwnerInvolved([
      { text: "Напишите в личку", author: "123", ts: new Date(), isOutgoing: true, tgMsgId: 1, replyTo: null },
    ], 999)).toBe(true);
  });

  test("владельца нет — false", () => {
    expect(isOwnerInvolved([
      { text: "Кто делает ботов?", author: "123", ts: new Date(), isOutgoing: false, tgMsgId: 1, replyTo: null },
      { text: "Я", author: "456", ts: new Date(), isOutgoing: false, tgMsgId: 2, replyTo: null },
    ], 999)).toBe(false);
  });

  test("self id неизвестен — false (не блокируем)", () => {
    expect(isOwnerInvolved([
      { text: "Хелп", author: "123", ts: new Date(), isOutgoing: false, tgMsgId: 1, replyTo: null },
    ], undefined)).toBe(false);
  });
});
