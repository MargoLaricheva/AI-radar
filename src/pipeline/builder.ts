// Двухуровневая группировка сообщений в разговоры (спека §6.2):
// сегмент — окно по reply-цепочке/времени; тред — долгоживущий разговор.
// Debounce с потолком; дрейф → переанализ с cooldown.

import type { TgMessage } from "../tg/types";

export interface Segment {
  id: number; // = rootMsgId = tgMsgId первого сообщения (глобально уникален в чате, переживает рестарты)
  rootMsgId: number;
  messages: TgMessage[];
  firstTs: number;
  lastTs: number;
}

export interface ThreadState {
  id: number; // = rootMsgId первого сегмента (tgMsgId, а не локальный счётчик)
  chatDbId: number | null;
  segments: Segment[];
  lastTs: number;
  lastAnalyzedAt: number | null;
  analysesToday: number;
  dayKey: string;
}

export interface ReadyThread {
  thread: ThreadState;
  reason: "quiet" | "max_age";
}

export interface BuilderOpts {
  segmentGapMin?: number;
  quietMin?: number;
  maxAgeMin?: number;
  threadTtlHours?: number;
  analysesPerDay?: number;
  cooldownMin?: number;
}

interface ChatState {
  segments: Map<number, Segment>;
  threads: Map<number, ThreadState>;
}

export class ConversationBuilder {
  private chats = new Map<number, ChatState>();
  private chatDbIds = new Map<number, number>();
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private dayKey = todayKey();

  constructor(
    private onReady: (t: ReadyThread) => void,
    private opts: BuilderOpts = {},
  ) {}

  private get gap() {
    return (this.opts.segmentGapMin ?? 45) * 60_000;
  }
  private get quiet() {
    return (this.opts.quietMin ?? 5) * 60_000;
  }
  private get maxAge() {
    return (this.opts.maxAgeMin ?? 20) * 60_000;
  }
  private get ttl() {
    return (this.opts.threadTtlHours ?? 48) * 3600_000;
  }
  private get analysesPerDay() {
    return this.opts.analysesPerDay ?? 4;
  }
  private get cooldown() {
    return (this.opts.cooldownMin ?? 30) * 60_000;
  }

  /** Регистрация соответствия tgChatId → chatDbId (из store) */
  setChatDbId(tgChatId: number, chatDbId: number): void {
    this.chatDbIds.set(tgChatId, chatDbId);
  }

  /** Приём нового сообщения (порядок — по времени); возвращает тред */
  push(msg: TgMessage): ThreadState {
    const now = msg.ts.getTime();
    const state = this.chat(msg.chatId);

    let segment = this.findSegment(state, msg, now);
    if (!segment) {
      // id = tgMsgId первого сообщения: локальный счётчик после рестарта
      // коллизил со старыми conversations (новые витки тихо дополняли
      // вчерашние карточки вместо новых), tgMsgId уникален и стабилен
      segment = { id: msg.tgMsgId, rootMsgId: msg.tgMsgId, messages: [], firstTs: now, lastTs: now };
      state.segments.set(segment.id, segment);
    }
    segment.messages.push(msg);
    segment.lastTs = now;

    let thread = this.findThread(state, msg, segment, now);
    if (!thread) {
      thread = {
        id: segment.id,
        chatDbId: this.chatDbIds.get(msg.chatId) ?? null,
        segments: [],
        lastTs: now,
        lastAnalyzedAt: null,
        analysesToday: 0,
        dayKey: this.dayKey,
      };
      state.threads.set(thread.id, thread);
    }
    if (!thread.segments.includes(segment)) thread.segments.push(segment);
    thread.lastTs = now;

    this.rollDay();
    this.schedule(thread);
    return thread;
  }

  /** Закрытие устаревших тредов (sweep) */
  sweep(now = Date.now()): ThreadState[] {
    const closed: ThreadState[] = [];
    for (const state of this.chats.values()) {
      for (const [id, t] of state.threads) {
        if (now - t.lastTs > this.ttl) {
          state.threads.delete(id);
          closed.push(t);
        }
      }
    }
    return closed;
  }

  /** Разрешён ли переанализ треда (cooldown + суточный лимит) */
  canReanalyze(thread: ThreadState, now = Date.now()): boolean {
    if (thread.analysesToday >= this.analysesPerDay) return false;
    if (thread.lastAnalyzedAt != null && now - thread.lastAnalyzedAt < this.cooldown) return false;
    return true;
  }

  /** Отметить анализ: counted=true тратит суточный лимит, false — только cooldown */
  markAnalyzed(thread: ThreadState, counted = true): void {
    thread.lastAnalyzedAt = Date.now();
    if (counted) thread.analysesToday++;
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // ---------- private ----------

  private chat(chatId: number): ChatState {
    let c = this.chats.get(chatId);
    if (!c) {
      c = { segments: new Map(), threads: new Map() };
      this.chats.set(chatId, c);
    }
    return c;
  }

  private findSegment(state: ChatState, msg: TgMessage, now: number): Segment | null {
    if (msg.replyToTgMsgId != null) {
      for (const s of state.segments.values()) {
        if (s.messages.some((m) => m.tgMsgId === msg.replyToTgMsgId)) return s;
      }
    }
    let best: Segment | null = null;
    let bestGap = Infinity;
    for (const s of state.segments.values()) {
      const gap = now - s.lastTs;
      if (gap <= this.gap && gap < bestGap) {
        best = s;
        bestGap = gap;
      }
    }
    return best;
  }

  private findThread(state: ChatState, msg: TgMessage, segment: Segment, now: number): ThreadState | null {
    for (const t of state.threads.values()) {
      if (t.segments.includes(segment)) return t;
    }
    if (msg.replyToTgMsgId != null) {
      for (const t of state.threads.values()) {
        if (t.segments.some((s) => s.messages.some((m) => m.tgMsgId === msg.replyToTgMsgId))) return t;
      }
    }
    // Без привязки по автору: новый виток (не reply, пауза больше gap) —
    // это новая тема, которая должна дать НОВУЮ карточку, а не тихо
    // дополнять старый тред в течение всего TTL.
    return null;
  }

  private schedule(thread: ThreadState): void {
    const key = thread.id;
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    const now = Date.now();
    const lastSegment = thread.segments[thread.segments.length - 1]!;
    const quietAt = thread.lastTs + this.quiet;
    const maxAgeAt = lastSegment.firstTs + this.maxAge;
    const wait = Math.min(quietAt, maxAgeAt) - now;
    const timer = setTimeout(() => {
      this.timers.delete(key);
      const fireAt = Date.now();
      const reason: ReadyThread["reason"] = fireAt >= maxAgeAt ? "max_age" : "quiet";
      this.onReady({ thread, reason });
    }, Math.max(0, wait));
    this.timers.set(key, timer);
  }

  private rollDay(): void {
    const k = todayKey();
    if (k === this.dayKey) return;
    this.dayKey = k;
    for (const state of this.chats.values()) {
      for (const t of state.threads.values()) {
        if (t.dayKey !== k) {
          t.analysesToday = 0;
          t.dayKey = k;
        }
      }
    }
  }
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}
