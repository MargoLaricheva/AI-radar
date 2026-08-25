import { beforeAll, describe, expect, test } from "bun:test";
import { createDb } from "../../src/db/client";
import { addExample, getAnchors, listExamples, toggleExample } from "../../src/learn/anchors";

const url = process.env.DATABASE_URL_TEST ?? "postgres://radar@localhost:5432/radar";
const db = createDb(url);

beforeAll(async () => {
  await db.execute("truncate table examples cascade");
});

describe("anchors", () => {
  test(
    "добавление и получение примеров",
    async () => {
    const id = await addExample({ userText: "Ищу разработчика бота для телеграма", topic: "боты", source: "teach" }, db);
    expect(id).toBeGreaterThan(0);
    const list = await listExamples(true, db);
    expect(list.length).toBe(1);
    expect(list[0]!.topic).toBe("боты");
    const anchors = await getAnchors(db);
    expect(anchors.length).toBe(1);
    },
    30000, // первый вызов грузит embeddings-модель
  );

  test("отключение примера убирает его из якорей", async () => {
    const id = await addExample({ userText: "Нужен сайт для кофейни с доставкой", topic: "сайты" }, db);
    await toggleExample(id, false, db);
    const anchors = await getAnchors(db);
    expect(anchors.some((a) => a.id === id)).toBe(false);
    await toggleExample(id, true, db);
  });
});
