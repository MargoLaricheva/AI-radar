import { describe, expect, test } from "bun:test";
import { normalizeMessage, detectLang } from "../../src/pipeline/normalizer";
import { MsgQueue } from "../../src/pipeline/queue";

describe("normalizer", () => {
  test("пустое сообщение → junk empty", () => {
    expect(normalizeMessage("   ").junk).toBe("empty");
  });

  test("короткое → junk too_short", () => {
    expect(normalizeMessage("привет").junk).toBe("too_short");
  });

  test("нормальное сообщение → не junk", () => {
    const r = normalizeMessage("Кто может сделать сайт для магазина? Подскажите контакты");
    expect(r.junk).toBeNull();
    expect(r.lang).toBe("ru");
  });

  test("длинное → обрезается и junk too_long", () => {
    const r = normalizeMessage("а".repeat(2500));
    expect(r.junk).toBe("too_long");
    expect(r.text.length).toBe(2000);
  });

  test("спам ссылками → junk link_spam", () => {
    const r = normalizeMessage("купите https://a.ru https://b.ru https://c.ru https://d.ru товар");
    expect(r.junk).toBe("link_spam");
  });

  test("спам упоминаниями → junk mention_spam", () => {
    const r = normalizeMessage("подпишитесь @one @two @three @four на канал");
    expect(r.junk).toBe("mention_spam");
  });

  test("детект языка", () => {
    expect(detectLang("Hello world this is English")).toBe("en");
    expect(detectLang("Привет как дела друзья")).toBe("ru");
    expect(detectLang("1234567890")).toBe("und");
  });
});

describe("queue", () => {
  test("push/drain по пачкам", () => {
    const q = new MsgQueue();
    expect(q.length).toBe(0);
    const m = {
      chatId: 1,
      tgMsgId: 2,
      authorId: 3,
      authorName: "A",
      text: "x".repeat(20),
      lang: "ru",
      ts: new Date(),
      isOutgoing: false,
      replyToTgMsgId: null,
    };
    q.push(m);
    q.push({ ...m, tgMsgId: 3 });
    expect(q.length).toBe(2);
    expect(q.drain().length).toBe(2);
    expect(q.length).toBe(0);
    expect(q.drain().length).toBe(0);
  });
});
