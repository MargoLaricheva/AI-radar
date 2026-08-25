import { describe, expect, test, mock } from "bun:test";
import type { ThreadState } from "../../src/pipeline/builder";
import { buildProfileEmbeddingText, runFilter, weightsToChatWeight } from "../../src/pipeline/filter";

// Мок embeddings: схожесть считаем по переданным векторам (профиль vs окно)
const calls: { texts: string[] }[] = [];
mock.module("../../src/pipeline/embeddings", () => ({
  cosine: (a: number[], b: number[]) => {
    if (!a.length || !b.length) return 0;
    return a[0] === b[0] ? 1 : 0.2;
  },
  embedTexts: async (texts: string[]) => {
    calls.push({ texts });
    return [0.5];
  },
}));

function makeThread(messages: { text: string; author?: number; minutes?: number }[]): ThreadState {
  const base = new Date("2026-08-12T10:00:00Z");
  return {
    id: 1,
    chatDbId: 1,
    segments: [
      {
        id: 1,
        rootMsgId: 1,
        messages: messages.map((m, i) => ({
          chatId: 1,
          tgMsgId: i + 1,
          authorId: m.author ?? 1,
          authorName: "A",
          text: m.text,
          lang: "ru",
          ts: new Date(base.getTime() + (m.minutes ?? 0) * 60_000),
          isOutgoing: false,
          replyToTgMsgId: null,
        })),
        firstTs: base.getTime(),
        lastTs: base.getTime(),
      },
    ],
    lastTs: base.getTime(),
    lastAnalyzedAt: null,
    analysesToday: 0,
    dayKey: "2026-08-12",
  };
}

describe("filter", () => {
  test("проход при высокой схожести", async () => {
    const r = await runFilter({
      thread: makeThread([{ text: "Кто может сделать сайт для магазина?" }]),
      profileEmbedding: [0.5],
      chatWeight: 1,
      anchors: [],
      threshold: 0.45,
    });
    expect(r.pass).toBe(true);
    expect(r.score).toBeGreaterThan(0.45);
  });

  test("отсев при низкой схожести", async () => {
    const r = await runFilter({
      thread: makeThread([{ text: "Случайный текст" }]),
      profileEmbedding: [0.9],
      chatWeight: 1,
      anchors: [],
      threshold: 0.7,
    });
    expect(r.pass).toBe(false);
  });

  test("одиночное сообщение требует больший порог", async () => {
    const r = await runFilter({
      thread: makeThread([{ text: "Одинокое сообщение" }]),
      profileEmbedding: [0.9], // cos(0.9, 0.5) = 0.2 в моке
      chatWeight: 1,
      anchors: [],
      threshold: 0.45,
    });
    expect(r.pass).toBe(false); // 0.2*1 < 0.45*1.25
  });

  test("чат-вес усиливает", async () => {
    const r = await runFilter({
      thread: makeThread([{ text: "Текст из любимого чата", author: 1 }, { text: "Продолжение разговора", author: 2, minutes: 2 }]),
      profileEmbedding: [0.5],
      chatWeight: 2,
      anchors: [],
      threshold: 0.45,
    });
    expect(r.pass).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(0.4);
  });

  test("blacklist-темы понижают", async () => {
    const r = await runFilter({
      thread: makeThread([{ text: "Продаю диваны оптом недорого", author: 1 }, { text: "Диваны в наличии", author: 2, minutes: 2 }]),
      profileEmbedding: [0.5],
      chatWeight: 1,
      anchors: [],
      threshold: 0.35,
      blacklistedTopics: ["диван"],
    });
    expect(r.pass).toBe(false); // 1.0 × 0.3 < 0.35
  });

  test("якорь-пример усиливает", async () => {
    const r = await runFilter({
      thread: makeThread([{ text: "Что-то про другое", author: 1 }, { text: "Ещё текст", author: 2, minutes: 2 }]),
      profileEmbedding: [0.9],
      chatWeight: 1,
      anchors: [{ id: 1, text: "пример", embedding: [0.5], enabled: true }],
      threshold: 0.7,
    });
    expect(r.pass).toBe(true);
  });

  test("профиль-текст собирается из полей", () => {
    const t = buildProfileEmbeddingText({
      what_i_do: "делаю сайты",
      services: ["лендинги"],
      niches: ["малый бизнес"],
      topics: ["веб-разработка"],
    });
    expect(t).toContain("делаю сайты");
    expect(t).toContain("веб-разработка");
  });

  test("weightsToChatWeight", () => {
    expect(weightsToChatWeight(undefined, 5)).toBe(1);
    expect(weightsToChatWeight({ topics: {}, chats: { "5": 2.5 }, types: {} }, 5)).toBe(2.5);
  });
});
