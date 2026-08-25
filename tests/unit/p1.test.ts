import { describe, expect, test } from "bun:test";
import { decryptSession, encryptSession, getKey } from "../../src/security/session-crypto";
import { callWithFloodGuard, FloodWaitError, parseFloodWait, jitter, RateCounter } from "../../src/tg/flood";
import { buildMessageLink } from "../../src/tg/deep-link";

describe("session-crypto", () => {
  test("round-trip: encrypt → decrypt возвращает исходную строку", () => {
    const key = getKey("a".repeat(64));
    const plain = "1AgAOMTQ5LjE1NC4xNjcuNTEBtest-session-string";
    const enc = encryptSession(plain, key);
    expect(enc).not.toContain(plain);
    expect(decryptSession(enc, key)).toBe(plain);
  });

  test("каждое шифрование даёт разный шифротекст (random IV)", () => {
    const key = getKey("b".repeat(64));
    const a = encryptSession("same", key);
    const b = encryptSession("same", key);
    expect(a).not.toBe(b);
  });

  test("неверный ключ → ошибка", () => {
    const enc = encryptSession("secret", getKey("c".repeat(64)));
    expect(() => decryptSession(enc, getKey("d".repeat(64)))).toThrow();
  });

  test("битый шифротекст → ошибка", () => {
    expect(() => decryptSession("AA==", getKey("e".repeat(64)))).toThrow();
  });
});

describe("flood", () => {
  test("parseFloodWait распознаёт FLOOD_WAIT_N", () => {
    expect(parseFloodWait({ errorCode: 420, message: "FLOOD_WAIT_47" })?.seconds).toBe(47);
    expect(parseFloodWait({ errorCode: 420, message: "FLOOD_WAIT_" })).not.toBeNull();
    expect(parseFloodWait({ errorCode: 400, message: "BANNED" })).toBeNull();
  });

  test("callWithFloodGuard ретраит после flood и возвращает результат", async () => {
    let calls = 0;
    const res = await callWithFloodGuard(async () => {
      calls++;
      if (calls === 1) throw new FloodWaitError(1);
      return "ok";
    });
    expect(res).toBe("ok");
    expect(calls).toBe(2);
  });

  test("callWithFloodGuard бросает после исчерпания ретраев", async () => {
    let calls = 0;
    await expect(
      callWithFloodGuard(
        async () => {
          calls++;
          throw new FloodWaitError(1);
        },
        { maxRetries: 2 },
      ),
    ).rejects.toBeInstanceOf(FloodWaitError);
    expect(calls).toBe(2);
  });

  test("не-flood ошибки пробрасываются сразу", async () => {
    await expect(
      callWithFloodGuard(async () => {
        throw new Error("AUTH_KEY_UNREGISTERED");
      }),
    ).rejects.toThrow("AUTH_KEY_UNREGISTERED");
  });

  test("jitter в пределах 90–110%", () => {
    for (let i = 0; i < 100; i++) {
      const j = jitter(1000);
      expect(j).toBeGreaterThanOrEqual(900);
      expect(j).toBeLessThanOrEqual(1100);
    }
  });

  test("RateCounter режет флудный чат", () => {
    const rc = new RateCounter(3);
    expect(rc.check(1)).toBe(false);
    expect(rc.check(1)).toBe(false);
    expect(rc.check(1)).toBe(false);
    expect(rc.check(1)).toBe(true); // превышен
    expect(rc.check(2)).toBe(false); // другой чат не затронут
    // новый период окна
    expect(rc.check(1, Date.now() + 60_001)).toBe(false);
  });
});

describe("deep-link", () => {
  test("публичный чат → t.me/username/msgId", () => {
    expect(buildMessageLink({ username: "example", tgChatId: -100123 }, 42)).toBe(
      "https://t.me/example/42",
    );
  });

  test("приватная супергруппа → t.me/c/<id>/<msgId>", () => {
    expect(buildMessageLink({ username: null, tgChatId: -1001234567890 }, 7)).toBe(
      "https://t.me/c/1234567890/7",
    );
  });

  test("basic group → null", () => {
    expect(buildMessageLink({ username: null, tgChatId: -12345 }, 1)).toBeNull();
  });

  test("личные чаты не хранятся; положительный id трактуем как супергруппу", () => {
    expect(buildMessageLink({ username: null, tgChatId: 12345 }, 1)).toBe("https://t.me/c/12345/1");
  });

  test("положительный Channel.id (супергруппа из entity) → t.me/c/<id>/<msg>", () => {
    expect(buildMessageLink({ username: null, tgChatId: 2621128331 }, 7925)).toBe(
      "https://t.me/c/2621128331/7925",
    );
  });
});
