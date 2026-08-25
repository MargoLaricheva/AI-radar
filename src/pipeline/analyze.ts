// Оркестратор анализа: builder ready → фильтр → LLM → scoring → opportunity → people

import { and, eq } from "drizzle-orm";
import { getDb, type Db } from "../db/client";
import { conversations, opportunities, people, users } from "../db/schema";
import type { Env } from "../config";
import type pino from "pino";
import { ConversationBuilder, type ReadyThread, type ThreadState } from "./builder";
import { runFilter, buildProfileEmbeddingText, type Anchor } from "./filter";
import { ensureEmbeddings, embedOne, embeddingsFailed } from "./embeddings";
import type { LlmClient } from "../llm/client";
import { buildSystemPrompt, buildUserPrompt, type PersonHistory, type WindowMsg } from "../llm/prompts";
import { applyWeights, basePriority } from "./score";
import { ensureConversation, upsertOpportunity, type OpportunityEvent } from "./opportunity";
import { upsertPeople } from "../people/index";
import type { Opportunity, Profile, Settings, Weights } from "../db/schema";

export interface AnalyzerDeps {
  db?: Db;
  config: Env;
  log: pino.Logger;
  llm: LlmClient;
  getSettings: () => Promise<Settings>;
  getWeights: () => Promise<Weights | undefined>;
  getProfileEmbedding: () => Promise<number[]>;
  getAnchors: () => Promise<Anchor[]>;
  onOpportunity: (ev: OpportunityEvent, opp: Opportunity, thread: ThreadState) => Promise<void>;
}

export interface Analyzer {
  builder: ConversationBuilder;
  dispose: () => void;
}

export function createAnalyzer(deps: AnalyzerDeps): Analyzer {
  const builder = new ConversationBuilder((ready) => void handleReady(deps, ready), {
    segmentGapMin: deps.config.SEGMENT_GAP_MIN,
    quietMin: deps.config.DEBOUNCE_QUIET_MIN,
    maxAgeMin: deps.config.DEBOUNCE_MAX_AGE_MIN,
    threadTtlHours: deps.config.THREAD_TTL_HOURS,
    analysesPerDay: deps.config.THREAD_ANALYSES_PER_DAY,
    cooldownMin: 30,
  });
  return { builder, dispose: () => builder.dispose() };
}

async function handleReady(deps: AnalyzerDeps, ready: ReadyThread): Promise<void> {
  const log = deps.log.child({ thread: ready.thread.id });
  const thread = ready.thread;
  if (thread.chatDbId == null) {
    log.warn("нет chatDbId, анализ пропущен");
    return;
  }

  // 1. Cheap filter (локальные embeddings)
  if (!deps.config.USE_LLM_FILTER && !embeddingsFailed()) {
    const ok = await ensureEmbeddings(log);
    if (ok) {
      const profileEmb = await deps.getProfileEmbedding();
      const anchors = await deps.getAnchors();
      const weights = await deps.getWeights();
      const chatWeight = Math.max(0.05, weights?.chats?.[String(thread.chatDbId)] ?? 1);
      const settings = await deps.getSettings();
      const res = await runFilter({
        thread,
        profileEmbedding: profileEmb,
        chatWeight,
        anchors,
        threshold: deps.config.FILTER_THRESHOLD,
        blacklistedTopics: settings.blacklisted_topics,
      });
      if (!res.pass) {
        log.debug({ score: res.score }, "фильтр не пропустил окно");
        return;
      }
    }
  }

  // 2. Контекст: окно, история участников, профиль, прошлый анализ
  const db = deps.db ?? getDb();
  const window = threadToWindow(thread);

  // 2a. Владелец сам участвует в диалоге (писал или отвечал) —
  // это его собственный разговор, карточку не создаём и LLM не тратим
  const settings = await deps.getSettings();
  if (isOwnerInvolved(window, settings.self_tg_id)) {
    log.info("владелец участвует в диалоге, пропуск");
    return;
  }

  const personHistory = await loadPersonHistory(window, db);
  const profile = await loadProfile(db);
  const previous = await loadPreviousAnalysis(db, thread);

  // 3. LLM
  const call = await deps.llm.analyze(
    buildSystemPrompt(profile),
    buildUserPrompt({ messages: window, profile, personHistory, previousAnalysis: previous }),
  );
  if (!call.result) {
    log.warn({ error: call.error }, "анализ не удался");
    return;
  }
  const result = call.result;

  // 4. NOISE — без возможности
  if (result.type === "NOISE") {
    log.debug({ summary: result.summary }, "NOISE, пропуск");
    return;
  }

  // 5. Scoring + opportunity
  const weights = await deps.getWeights();
  const scored = applyWeights(basePriority(result), result, weights, thread.chatDbId);
  const convRef = await ensureConversation(thread.chatDbId, thread.id, new Date(thread.lastTs), threadMsgCount(thread), db);
  const ev = await upsertOpportunity(convRef, thread.chatDbId, result, scored, db, lastMsgIdOf(thread));
  const opp = await loadOpportunity(db, ev.opportunityId);
  if (!opp) return;

  // 6. People
  await upsertPeople(windowParticipants(window), result.topic, db);

  // 7. Нотификация
  await deps.onOpportunity(ev, opp, thread);
}

// ---------- helpers ----------

/** Участвует ли сам владелец (аккаунт-юзербот) в диалоге окна */
export function isOwnerInvolved(window: WindowMsg[], selfTgId: number | null | undefined): boolean {
  if (selfTgId == null) return false;
  return window.some(
    (m) => m.isOutgoing === true || (m.author != null && Number(m.author) === selfTgId),
  );
}

export function threadToWindow(thread: ThreadState): WindowMsg[] {
  const out: WindowMsg[] = [];
  for (const s of thread.segments) {
    for (const m of s.messages) {
      out.push({
        text: m.text,
        author: m.authorName ?? (m.authorId != null ? String(m.authorId) : null),
        ts: m.ts,
        isOutgoing: m.isOutgoing,
        tgMsgId: m.tgMsgId,
        replyTo: m.replyToTgMsgId,
      });
    }
  }
  return out;
}

function windowParticipants(window: WindowMsg[]): { tgUserId: number; name: string | null }[] {
  const seen = new Map<number, { tgUserId: number; name: string | null }>();
  for (const m of window) {
    const id = numericAuthor(m);
    if (id == null || seen.has(id)) continue;
    seen.set(id, { tgUserId: id, name: m.author ?? null });
  }
  return [...seen.values()];
}

function numericAuthor(m: WindowMsg): number | null {
  const raw = m.author;
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function loadPersonHistory(window: WindowMsg[], db: Db): Promise<PersonHistory[]> {
  const ids = windowParticipants(window)
    .map((p) => p.tgUserId)
    .slice(0, 2);
  if (ids.length === 0) return [];
  const rows = await db
    .select({ name: people.name, topics: people.topics, tgUserId: people.tgUserId })
    .from(people)
    .where(and(...ids.map((id) => eq(people.tgUserId, id))));
  return rows.map((r) => ({ name: r.name ?? String(r.tgUserId), topics: r.topics ?? [] }));
}

async function loadProfile(db: Db): Promise<Profile> {
  const row = await db.select({ profile: users.profile }).from(users).limit(1);
  return row[0]?.profile ?? {};
}

async function loadPreviousAnalysis(db: Db, thread: ThreadState): Promise<string | undefined> {
  if (thread.chatDbId == null) return undefined;
  const conv = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.chatId, thread.chatDbId), eq(conversations.kind, "thread"), eq(conversations.rootMsgId, thread.id)))
    .limit(1);
  if (!conv[0]) return undefined;
  const opp = await db
    .select({ type: opportunities.type, priority: opportunities.priority, summary: opportunities.summary })
    .from(opportunities)
    .where(eq(opportunities.conversationId, conv[0].id))
    .limit(1);
  if (!opp[0]) return undefined;
  return `${opp[0].type} (приоритет ${Math.round(opp[0].priority ?? 0)}): ${opp[0].summary}`;
}

async function loadOpportunity(db: Db, id: number): Promise<Opportunity | null> {
  const rows = await db.select().from(opportunities).where(eq(opportunities.id, id)).limit(1);
  return rows[0] ?? null;
}

function threadMsgCount(thread: ThreadState): number {
  return thread.segments.reduce((a, s) => a + s.messages.length, 0);
}

function lastMsgIdOf(thread: ThreadState): number | null {
  for (let i = thread.segments.length - 1; i >= 0; i--) {
    const seg = thread.segments[i]!;
    const last = seg.messages[seg.messages.length - 1];
    if (last) return last.tgMsgId;
  }
  return null;
}

export { buildProfileEmbeddingText, embedOne };
