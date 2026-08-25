import { describe, expect, test } from "bun:test";
import { cardText, cardKeyboard, statusLabel, type CardContext } from "../../src/bot/cards";
import type { Opportunity, Chat } from "../../src/db/schema";

function makeOpp(over: Partial<Opportunity> = {}): Opportunity {
  return {
    id: 1,
    conversationId: 1,
    chatId: 1,
    type: "WARM_LEAD",
    signalTrack: "client",
    relatedness: "direct",
    stage: "looking_for_provider",
    topic: "разработка сайта",
    scores: { relevance: 80, purchaseIntent: 70, engagementOpportunity: 60, futurePotential: 50, urgency: 40 },
    clientProbability: 65,
    priority: 72,
    summary: "Ищет подрядчика для нового сайта магазина",
    reasoning: ["прямой запрос"],
    talkingPoints: ["Рассказать о похожем кейсе", "Показать варианты"],
    avoid: ["Не продавать агрессивно"],
    recommendedAction: "Ответить публично",
    suggestedMessage: "Привет! Недавно делал похожий проект…",
    status: "new",
    lastMsgId: 42,
    tgCardMsgId: null,
    lastActivityTs: new Date("2026-08-12T10:00:00Z"),
    lastNotifiedAt: null,
    notifyCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

const chat: Chat = {
  id: 1,
  tgChatId: -1001234567890,
  title: "Предприниматели",
  username: null,
  type: "megagroup",
  participantsCount: null,
  lastActivityAt: null,
  enabled: true,
  priority: 0,
  category: null,
  watchWeight: 1,
  msgCapExceeded: false,
  createdAt: new Date(),
};

function ctx(opp: Opportunity = makeOpp()): CardContext {
  return { opp, chat };
}

describe("cards", () => {
  test("карточка содержит все ключевые блоки", () => {
    const text = cardText(ctx());
    expect(text).toContain("Тёплый лид");
    expect(text).toContain("шанс на клиента: 65%");
    expect(text).toContain("Предприниматели");
    expect(text).toContain("Ищет подрядчика");
    expect(text).toContain("Тезисы");
    expect(text).toContain("Можно написать");
    expect(text).toContain("Привет! Недавно делал похожий проект");
    expect(text).toContain("Не писать");
  });

  test("детальный режим добавляет оценки и reasoning", () => {
    const text = cardText(ctx(), true);
    expect(text).toContain("intent 70%");
    expect(text).toContain("приоритет 72");
    expect(text).toContain("Рекомендация");
    expect(text).toContain("прямой запрос");
    expect(text).toContain("Этап разговора");
  });

  test("статус engaged отображается", () => {
    const text = cardText(ctx(makeOpp({ status: "engaged" })));
    expect(text).toContain("Вы ответили");
  });

  test("клавиатура: ссылка на приватный чат и 4 кнопки", () => {
    const kb = cardKeyboard(ctx());
    const rows = kb.inline_keyboard;
    expect(rows.length).toBe(2);
    const first = rows[0]!;
    expect((first[0] as { url?: string }).url).toBe("https://t.me/c/1234567890/42");
    const second = rows[1]!;
    expect(second.map((b) => (b as { callback_data?: string }).callback_data)).toEqual(["cb:like:1", "cb:dislike:1", "cb:delete:1"]);
  });
  test("статус-метки", () => {
    expect(statusLabel("engaged")).toContain("ответили");
    expect(statusLabel("client")).toContain("Клиент");
    expect(statusLabel("new")).toBe("");
  });
});
