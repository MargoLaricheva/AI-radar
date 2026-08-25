import { z } from "zod";

const quietHours = z
  .string()
  .regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, "формат HH:MM-HH:MM")
  .default("23:00-09:00");

export const envSchema = z.object({
  BOT_TOKEN: z.string().min(1),
  OWNER_ID: z.string().regex(/^\d*$/, "число или пусто").default(""),
  DATABASE_URL: z.string().min(1),
  LLM_API_KEY: z.string().default(""),
  LLM_MODEL: z.string().default("deepseek-v4-flash"),
  LLM_BASE_URL: z.string().url().default("https://opencode.ai/zen/go/v1"),
  LLM_COST_IN: z.coerce.number().nonnegative().default(0.2),
  LLM_COST_OUT: z.coerce.number().nonnegative().default(0.6),
  SESSION_KEY: z.string().default(""),
  TG_2FA_PASSWORD: z.string().default(""),
  MONITOR_CHAT_LIMIT: z.coerce.number().int().positive().default(100),
  CHAT_MSG_PER_MIN_CAP: z.coerce.number().int().positive().default(60),
  CATCHUP_HOURS: z.coerce.number().positive().default(6),
  ANALYSIS_PER_HOUR: z.coerce.number().int().positive().default(30),
  THREAD_ANALYSES_PER_DAY: z.coerce.number().int().positive().default(4),
  SEGMENT_GAP_MIN: z.coerce.number().int().positive().default(45),
  DEBOUNCE_QUIET_MIN: z.coerce.number().int().positive().default(5),
  DEBOUNCE_MAX_AGE_MIN: z.coerce.number().int().positive().default(20),
  THREAD_TTL_HOURS: z.coerce.number().positive().default(12),
  FILTER_THRESHOLD: z.coerce.number().min(0).max(1).default(0.3),
  USE_LLM_FILTER: z.enum(["true", "false"]).default("false"),
  NOTIFY_LEVEL: z.enum(["critical", "important", "opportunities"]).default("opportunities"),
  QUIET_HOURS: quietHours,
  DIGEST_TIME: z.string().regex(/^\d{2}:\d{2}$/, "формат HH:MM").default("09:00"),
  RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  PORT: z.coerce.number().int().positive().default(3000),
});

export type Env = z.infer<typeof envSchema>;

export interface QuietHours {
  start: number; // минуты от полуночи
  end: number;
}

export function parseQuietHours(raw: string): QuietHours {
  const [s, e] = raw.split("-");
  const [sh, sm] = s!.split(":").map(Number);
  const [eh, em] = e!.split(":").map(Number);
  return { start: sh! * 60 + sm!, end: eh! * 60 + em! };
}

export function parseEnv(raw: Record<string, string | undefined> = Bun.env): Env {
  return envSchema.parse(raw);
}

export function loadConfig(): Env {
  const env = parseEnv();
  const loggerLevel = env.LOG_LEVEL;
  return { ...env, LOG_LEVEL: loggerLevel };
}
