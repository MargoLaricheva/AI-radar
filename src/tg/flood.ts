// Flood-защита MTProto: экспоненциальный бэкофф + jitter, degraded-чаты

const MAX_WAIT_MS = 300_000; // 5 минут
const MAX_RETRIES = 3;

export class FloodWaitError extends Error {
  readonly errorCode = 420;
  constructor(
    public seconds: number,
    message?: string,
  ) {
    super(message ?? `FLOOD_WAIT_${seconds}`);
  }
}

export function parseFloodWait(err: unknown): FloodWaitError | null {
  const e = err as { errorCode?: number; message?: string } | undefined;
  if (!e) return null;
  if (e.errorCode === 420 || (e.message && e.message.startsWith("FLOOD_WAIT_"))) {
    const secs = Number(e.message?.split("FLOOD_WAIT_")[1]);
    return new FloodWaitError(Number.isFinite(secs) ? secs : 30);
  }
  return null;
}

export function jitter(ms: number): number {
  return Math.round(ms * (0.9 + Math.random() * 0.2));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Выполняет fn с защитой от flood: при FloodWaitError ждёт
 * указанное время с jitter; при повторах — экспоненциальный рост (×2, кап 300с).
 * После MAX_RETRIES подряд — бросает FloodWaitError.
 */
export async function callWithFloodGuard<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; onRetry?: (waitMs: number, attempt: number) => void } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  let delay = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const fw = parseFloodWait(err);
      if (!fw) throw err;
      delay = attempt === 0 ? fw.seconds * 1000 : Math.min(delay * 2, MAX_WAIT_MS);
      delay = Math.max(delay, fw.seconds * 1000);
      opts.onRetry?.(delay, attempt + 1);
      if (attempt + 1 >= maxRetries) throw fw;
      await sleep(jitter(delay));
    }
  }
}

// Потоковый лимит на чат (msg/мин) для отсева флуд-чатов
export class RateCounter {
  private counts = new Map<number, { count: number; windowStart: number }>();

  constructor(private perMin: number) {}

  /** true — лимит превышен */
  check(chatId: number, now = Date.now()): boolean {
    const w = Math.floor(now / 60_000);
    const cur = this.counts.get(chatId);
    if (!cur || cur.windowStart !== w) {
      this.counts.set(chatId, { count: 1, windowStart: w });
      return false;
    }
    cur.count++;
    if (cur.count > this.perMin) {
      this.counts.delete(chatId);
      return true;
    }
    return false;
  }
}
