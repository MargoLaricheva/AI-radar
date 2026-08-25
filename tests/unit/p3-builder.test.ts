import { describe, expect, test } from "bun:test";
import { ConversationBuilder, type ThreadState } from "../../src/pipeline/builder";
import type { TgMessage } from "../../src/tg/types";

const CHAT = 1001;

function msg(tgMsgId: number, text: string, opts: Partial<{ author: number; replyTo: number; minutesAfter: number }> = {}): TgMessage {
  const base = new Date("2026-08-12T10:00:00Z");
  const ts = new Date(base.getTime() + (opts.minutesAfter ?? 0) * 60_000);
  return {
    chatId: CHAT,
    tgMsgId,
    authorId: opts.author ?? 1,
    authorName: "A",
    text,
    lang: "ru",
    ts,
    isOutgoing: false,
    replyToTgMsgId: opts.replyTo ?? null,
  };
}

async function flush(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("builder", () => {
  test("близкие по времени сообщения — один сегмент и тред", async () => {
    const ready: ThreadState[] = [];
    const b = new ConversationBuilder((r) => ready.push(r.thread), { quietMin: 1, maxAgeMin: 20, segmentGapMin: 45 });
    b.push(msg(1, "Кто может сделать сайт для магазина?", { author: 1 }));
    b.push(msg(2, "Я могу, есть кейсы", { author: 2, minutesAfter: 3 }));
    await flush(1500);
    expect(ready.length).toBe(1);
    const t = ready[0]!;
    expect(t.segments.length).toBe(1);
    expect(t.segments[0]!.messages.length).toBe(2);
    expect(t.lastTs).toBe(t.segments[0]!.messages[1]!.ts.getTime());
    b.dispose();
  });

  test("reply через 3 часа — тот же тред (растянутый диалог)", async () => {
    const ready: ThreadState[] = [];
    const b = new ConversationBuilder((r) => ready.push(r.thread), { quietMin: 1, maxAgeMin: 20, segmentGapMin: 45 });
    b.push(msg(10, "Думаю открыть кофейню, сколько стоит сайт?", { author: 1 }));
    b.push(msg(11, "Зависит от задач", { author: 2, minutesAfter: 180, replyTo: 10 }));
    await flush(1500);
    expect(ready.length).toBe(1);
    const t = ready[0]!;
    // reply-цепочка объединяет в один тред
    expect(t.segments[0]!.messages.length).toBe(2);
    b.dispose();
  });

  test("разные темы с паузой — разные треды", async () => {
    const ready: ThreadState[] = [];
    const b = new ConversationBuilder((r) => ready.push(r.thread), { quietMin: 1, maxAgeMin: 20, segmentGapMin: 45 });
    b.push(msg(20, "Обсуждаем погоду в городе сегодня", { author: 1 }));
    b.push(msg(21, "Да, солнечно", { author: 2, minutesAfter: 60 }));
    await flush(1500);
    expect(ready.length).toBe(2);
    b.dispose();
  });

  test("новый виток того же автора после паузы — новый тред (новая карточка)", async () => {
    const ready: ThreadState[] = [];
    const b = new ConversationBuilder((r) => ready.push(r.thread), { quietMin: 1, maxAgeMin: 20, segmentGapMin: 45, threadTtlHours: 48 });
    b.push(msg(30, "Ищу разработчика для бота", { author: 5 }));
    b.push(msg(31, "А какую платформу выберете?", { author: 7, minutesAfter: 30 }));
    b.push(msg(32, "Ещё думаю", { author: 5, minutesAfter: 90 }));
    await flush(1500);
    // 30+31 — один тред; 32 (пауза 90м, без reply) — новый тред
    expect(ready.length).toBe(2);
    const first = ready[0]!.segments.reduce((a, s) => a + s.messages.length, 0);
    expect(first).toBe(2);
    b.dispose();
  });

  test("id треда стабилен между рестартами (rootMsgId = tgMsgId)", async () => {
    // Регрессия: локальный счётчик после рестарта коллизил со старыми
    // conversations — новые витки тихо дополняли вчерашние карточки
    const make = () => {
      const ready: ThreadState[] = [];
      const b = new ConversationBuilder((r) => ready.push(r.thread), { quietMin: 1, maxAgeMin: 20, segmentGapMin: 45 });
      b.push(msg(5001, "Нужен бот для записи клиентов", { author: 1 }));
      b.push(msg(5002, "Сделаем, напишите в личку", { author: 2, minutesAfter: 2 }));
      return { b, ready };
    };
    const first = make();
    await flush(1500);
    const firstId = first.ready[0]!.id;
    expect(firstId).toBe(5001);
    first.b.dispose();
    // «рестарт»: новый builder с теми же сообщениями даёт тот же id
    const second = make();
    await flush(1500);
    expect(second.ready[0]!.id).toBe(firstId);
    second.b.dispose();
  });

  test("sweep закрывает треды по TTL", async () => {
    const b = new ConversationBuilder(() => {}, { threadTtlHours: 1 });
    b.push(msg(40, "Тестовое сообщение с достаточной длиной текста", { author: 1 }));
    const closed = b.sweep(Date.now() + 2 * 3600_000);
    expect(closed.length).toBe(1);
    b.dispose();
  });

  test("canReanalyze: cooldown и суточный лимит", async () => {
    const b = new ConversationBuilder(() => {}, { cooldownMin: 30, analysesPerDay: 2 });
    b.push(msg(50, "Первое сообщение для теста коолдауна", { author: 1 }));
    b.markAnalyzed(b["chats"].get(CHAT)!.threads.values().next().value as ThreadState);
    const t = b["chats"].get(CHAT)!.threads.values().next().value as ThreadState;
    expect(b.canReanalyze(t, Date.now() + 1000)).toBe(false);
    expect(b.canReanalyze(t, Date.now() + 31 * 60_000)).toBe(true);
    b.markAnalyzed(t);
    b.markAnalyzed(t);
    expect(b.canReanalyze(t, Date.now() + 31 * 60_000)).toBe(false);
    b.dispose();
  });
});
