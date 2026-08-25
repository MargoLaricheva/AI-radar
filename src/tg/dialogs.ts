import { TelegramClient } from "telegram";
import { and, desc, eq, gte, gt, ilike, or } from "drizzle-orm";
import { callWithFloodGuard, sleep } from "./flood";
import { Api } from "telegram";
import { getDb, type Db } from "../db/client";
import { chats } from "../db/schema";
import type { TgChatInfo } from "./types";
import type pino from "pino";

const CHAT_TYPES = new Map<string, TgChatInfo["type"]>([
  ["chat", "group"],
  ["megagroup", "megagroup"],
  ["supergroup", "supergroup"],
  ["channel", "channel"],
]);

export function dialogToChatInfo(entity: unknown, lastActivityAt?: Date): TgChatInfo | null {
  if (typeof entity !== "object" || entity === null) return null;
  const e = entity as { className?: string };
  if (e.className === "Channel") {
    const ch = entity as Api.Channel;
    // каналы — однонаправленная лента, диалогов нет: не мониторим
    if (!ch.megagroup) return null;
    return {
      tgChatId: Number(ch.id),
      title: ch.title ?? "",
      username: ch.username ?? null,
      type: "megagroup",
      participantsCount: ch.participantsCount,
      lastActivityAt,
    };
  }
  if (e.className === "Chat") {
    const g = entity as Api.Chat;
    return {
      tgChatId: Number(g.id),
      title: g.title ?? "",
      username: null,
      type: "group",
      participantsCount: g.participantsCount,
      lastActivityAt,
    };
  }
  return null;
}

export interface ChatFilters {
  /** чаты строго больше N участников (неизвестное число — исключаем) */
  minParticipants?: number;
  /** активность не старше N дней */
  maxInactiveDays?: number;
}

export const DEFAULT_CHAT_FILTERS: Required<ChatFilters> = { minParticipants: 50, maxInactiveDays: 14 };

async function collectAllDialogs(
  client: TelegramClient,
  archived: boolean,
  collect: (entity: unknown, lastDate?: number) => void,
): Promise<void> {
  let offsetDate = 0;
  for (let page = 0; page < 60; page++) {
    const dialogs = await callWithFloodGuard(() =>
      client.getDialogs({ limit: 100, offsetDate: offsetDate || undefined, archived }),
    );
    if (dialogs.length === 0) break;
    for (const d of dialogs) collect(d.entity, d.date);
    // пагинация по дате последнего сообщения (id у части диалогов вне int32)
    offsetDate = dialogs[dialogs.length - 1]!.date ?? 0;
    await sleep(2000);
  }
}

/** Полное сканирование диалогов: обход (основные + архивные) и сохранение ВСЕХ чатов в БД */
export async function scanAllChats(client: TelegramClient, db: Db = getDb(), log?: pino.Logger): Promise<TgChatInfo[]> {
  const out: TgChatInfo[] = [];
  const seen = new Set<number>();
  const collect = (entity: unknown, lastDate?: number): void => {
    const info = dialogToChatInfo(entity, lastDate ? new Date(lastDate * 1000) : undefined);
    if (!info || seen.has(info.tgChatId)) return;
    seen.add(info.tgChatId);
    out.push(info);
  };

  await collectAllDialogs(client, false, collect);
  await collectAllDialogs(client, true, collect);

  for (const info of out) {
    await db
      .insert(chats)
      .values({
        tgChatId: info.tgChatId,
        title: info.title,
        username: info.username,
        type: info.type,
        participantsCount: info.participantsCount ?? null,
        lastActivityAt: info.lastActivityAt ?? null,
      })
      .onConflictDoUpdate({
        target: chats.tgChatId,
        set: {
          title: info.title,
          username: info.username,
          type: info.type,
          participantsCount: info.participantsCount ?? null,
          lastActivityAt: info.lastActivityAt ?? null,
        },
      });
  }
  log?.info({ saved: out.length }, "сканирование чатов завершено");
  return out;
}

/** Список чатов из БД: подходящие под фильтр + включённые в мониторинг (всегда видны) */
export async function loadFilteredChats(
  db: Db = getDb(),
  filters: ChatFilters = DEFAULT_CHAT_FILTERS,
): Promise<(typeof chats.$inferSelect)[]> {
  const min = filters.minParticipants ?? DEFAULT_CHAT_FILTERS.minParticipants;
  const days = filters.maxInactiveDays ?? DEFAULT_CHAT_FILTERS.maxInactiveDays;
  const cutoff = new Date(Date.now() - days * 86_400_000);
  return db
    .select()
    .from(chats)
    .where(
      or(
        eq(chats.enabled, true),
        and(gt(chats.participantsCount, min), gte(chats.lastActivityAt, cutoff)),
      ),
    )
    .orderBy(chats.title);
}

export interface AddChatResult {
  kind: "resolved" | "list" | "not_found" | "not_member" | "channel";
  chat?: TgChatInfo;
  candidates?: { dbId: number; tgChatId: number; title: string; username: string | null }[];
  reason?: string;
}

/** Поиск чата для добавления: название/@username/id. Проверяет членство и что это группа. */
export async function findChatToAdd(client: TelegramClient, query: string, db: Db = getDb()): Promise<AddChatResult> {
  const q = query.trim();
  if (!q) return { kind: "not_found", reason: "пустой запрос" };

  // 1) поиск по названию/юзернейму среди уже сохранённых чатов
  const byName = await db
    .select({ dbId: chats.id, tgChatId: chats.tgChatId, title: chats.title, username: chats.username })
    .from(chats)
    .where(or(ilike(chats.title, `%${q}%`), ilike(chats.username, `%${q.replace(/^@/, "")}%`)))
    .limit(15);
  if (byName.length > 0) {
    return { kind: "list", candidates: byName };
  }

  // 2) резолв по username или числовому id
  let entity: unknown;
  try {
    if (/^-?\d+$/.test(q)) {
      entity = await client.getEntity(Number(q));
    } else {
      entity = await client.getEntity(q.replace(/^@/, ""));
    }
  } catch {
    return { kind: "not_found", reason: "чат не найден (проверьте название/@username/id)" };
  }
  if (typeof entity !== "object" || entity === null) return { kind: "not_found" };
  const e = entity as { className?: string };
  if (e.className === "User") return { kind: "not_found", reason: "это пользователь, а не чат" };
  if (e.className === "Channel" && !(entity as { megagroup?: boolean }).megagroup) {
    return { kind: "channel", reason: "это канал, мониторим только чаты" };
  }

  if (e.className === "Channel") {
    const member = await client
      .invoke(new Api.channels.GetParticipant({ channel: entity as never, participant: "me" }))
      .then(() => true)
      .catch(() => false);
    if (!member) return { kind: "not_member", reason: "вы не состоите в этом чате" };
  }

  const info = dialogToChatInfo(entity);
  if (!info) return { kind: "not_found", reason: "не удалось определить чат" };
  return { kind: "resolved", chat: info };
}

/** Сохранение чата в БД (upsert) — точечное добавление */
export async function upsertChatInfo(info: TgChatInfo, db: Db = getDb()): Promise<number> {
  const rows = await db
    .insert(chats)
    .values({
      tgChatId: info.tgChatId,
      title: info.title,
      username: info.username,
      type: info.type,
      participantsCount: info.participantsCount ?? null,
      lastActivityAt: info.lastActivityAt ?? null,
    })
    .onConflictDoUpdate({
      target: chats.tgChatId,
      set: {
        title: info.title,
        username: info.username,
        type: info.type,
        participantsCount: info.participantsCount ?? null,
        lastActivityAt: info.lastActivityAt ?? null,
      },
    })
    .returning({ id: chats.id });
  return rows[0]!.id;
}

/** Быстрый срез диалогов (для кэша сущностей при старте) */
export async function listChats(client: TelegramClient, limit = 500): Promise<TgChatInfo[]> {
  const dialogs = await callWithFloodGuard(() => client.getDialogs({ limit }));
  const out: TgChatInfo[] = [];
  const seen = new Set<number>();
  for (const d of dialogs) {
    const info = dialogToChatInfo(d.entity, d.date ? new Date(d.date * 1000) : undefined);
    if (!info || seen.has(info.tgChatId)) continue;
    seen.add(info.tgChatId);
    out.push(info);
  }
  return out.sort((a, b) => a.title.localeCompare(b.title, "ru"));
}

/** Разрешение id диалога в число для запросов истории */
export function toInputPeer(client: TelegramClient, chatId: number): Api.TypeInputPeer {
  return client.getInputEntity(chatId) as unknown as Api.TypeInputPeer;
}
