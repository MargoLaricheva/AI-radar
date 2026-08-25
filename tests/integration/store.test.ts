import { beforeAll, describe, expect, test } from "bun:test";
import { createDb } from "../../src/db/client";
import { ensureChat, insertMessages, lastMsgIdForChat } from "../../src/pipeline/store";
import type { TgChatInfo, TgMessage } from "../../src/tg/types";

const url = process.env.DATABASE_URL_TEST ?? "postgres://radar@localhost:5432/radar";
const db = createDb(url);

const chat: TgChatInfo = { tgChatId: -100123456789, title: "Тест-чат", username: null, type: "megagroup" };

function msg(tgMsgId: number, text: string, ts = new Date("2026-08-12T10:00:00Z")): TgMessage {
  return {
    chatId: chat.tgChatId,
    tgMsgId,
    authorId: 111,
    authorName: "Иван",
    text,
    lang: "ru",
    ts,
    isOutgoing: false,
    replyToTgMsgId: null,
  };
}

beforeAll(async () => {
  await db.execute("truncate table messages, chats cascade");
});

describe("store", () => {
  test("ensureChat создаёт и обновляет чат", async () => {
    const id1 = await ensureChat(chat, db);
    const id2 = await ensureChat({ ...chat, title: "Новое имя" }, db);
    expect(id1).toBe(id2);
  });

  test("insertMessages сохраняет и дедуплицирует", async () => {
    const map = new Map<number, number>([[chat.tgChatId, await ensureChat(chat, db)]]);
    const r1 = await insertMessages([msg(1, "Первое сообщение в чате для теста"), msg(2, "Второе сообщение для теста")], map, db);
    expect(r1.length).toBe(2);
    const r2 = await insertMessages([msg(1, "дубликат"), msg(3, "Третье сообщение для теста")], map, db);
    expect(r2.length).toBe(1);
    expect(r2[0]!.dbId).not.toBe(r1[0]!.dbId);
  });

  test("lastMsgIdForChat возвращает максимум", async () => {
    const map = new Map<number, number>([[chat.tgChatId, await ensureChat(chat, db)]]);
    await insertMessages([msg(10, "Десятое сообщение для теста"), msg(11, "Одиннадцатое сообщение")], map, db);
    const last = await lastMsgIdForChat(map.get(chat.tgChatId)!, db);
    expect(last).toBe(11);
  });
});
