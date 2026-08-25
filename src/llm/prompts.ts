import type { Profile } from "../db/schema";

const MAX_WINDOW_MSGS = 15;
const MAX_WINDOW_CHARS = 4000;

export interface WindowMsg {
  text: string;
  author: string | null;
  ts: Date;
  isOutgoing: boolean;
  tgMsgId: number;
  replyTo: number | null;
}

export interface PersonHistory {
  name: string;
  topics: string[];
}

export interface PromptInput {
  messages: WindowMsg[];
  profile: Profile;
  personHistory: PersonHistory[];
  previousAnalysis?: string; // краткая сводка прошлого анализа при переанализе
}

/** Окно: последние N сообщений треда, ≤ MAX_WINDOW_CHARS символов */
export function buildWindow(messages: WindowMsg[]): WindowMsg[] {
  let out: WindowMsg[] = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const len = m.text.length + 20;
    if (out.length >= MAX_WINDOW_MSGS || chars + len > MAX_WINDOW_CHARS) break;
    out.unshift(m);
    chars += len;
  }
  return out;
}

function fmtTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function buildSystemPrompt(profile: Profile): string {
  const lines = [
    "Ты — эксперт-аналитик Telegram-чатов. Твоя задача — анализировать ДИАЛОГ целиком (не отдельное сообщение) и находить возможности для участия владельца системы.",
    "",
    "Профиль владельца (для оценки релевантности):",
    `Чем занимается: ${profile.what_i_do ?? "не указано"}`,
    `Услуги: ${profile.services?.join(", ") ?? "—"}`,
    `Продукты: ${profile.products?.join(", ") ?? "—"}`,
    `Ниши: ${profile.niches?.join(", ") ?? "—"}`,
    `Аудитория: ${profile.audience ?? "—"}`,
    `География: ${profile.geography ?? "—"}`,
    `Интересующие темы: ${profile.topics?.join(", ") ?? "—"}`,
    `Стиль общения: ${profile.style ?? "естественный, без агрессии"}`,
    "",
    "Правила анализа:",
    "1. Оценивай траекторию разговора: куда он движется (проблема → обсуждение → поиск решения → поиск специалиста → цена → выбор).",
    "2. signal_track: client — если это потенциальный клиент (запуск, хостинг, разработка, поиск подрядчика); expertise — если это обсуждение коллег, где ценность в участии и демонстрации экспертизы.",
    "3. relatedness: direct — тема прямо про услуги владельца; adjacent — смежная (хостинг, деплой, платформы, оплата API, инструменты); contextual — косвенная.",
    "4. type: HOT_LEAD — почти готов покупать; WARM_LEAD — есть потребность; DISCUSSION — интересная тема без покупки; EXPERTISE — возможность показать экспертизу; NETWORKING — полезный контакт; FUTURE — потенциально полезный человек; INFORMATION — интересная информация; NOISE — ценности нет.",
    "5. suggested_message — готовый текст для вставки в диалог: на языке диалога, 2–4 предложения, естественный тон, учитывай динамику разговора (кто кого поддерживает, с чем можно согласиться), НЕ продавай, НЕ предлагай услуги напрямую, НЕ будь агрессивен.",
    "6. Оценки 0–100. client_probability — сквозной шанс получить клиента из этого разговора (для expertise-треков обычно низкий).",
    "7. Если разговор начался не по теме, но пришёл к профильной — отметь это в trajectory.",
    "8. Для NOISE: type=NOISE, summary коротко почему, остальные поля — минимальные значения/null.",
    "",
    "Ответь ТОЛЬКО валидным JSON без markdown-обёртки, по схеме:",
    '{"relevance":0,"purchase_intent":0,"engagement_opportunity":0,"future_potential":0,"urgency":0,"client_probability":0,"type":"DISCUSSION","signal_track":"expertise","relatedness":"adjacent","stage":"discussing_solutions","trajectory":"...","topic":"короткая тема","summary":"суть разговора 1-2 предложения","reasoning":["почему такие оценки"],"talking_points":["тезис 1","тезис 2","тезис 3"],"avoid":["чего не делать"],"recommended_action":"что сделать","suggested_message":"готовый текст ответа"}',
  ];
  return lines.join("\n");
}

export function buildUserPrompt(input: PromptInput): string {
  const lines: string[] = [];
  const idx = new Map<number, number>();
  const win = buildWindow(input.messages);
  win.forEach((m, i) => idx.set(m.tgMsgId, i + 1));

  lines.push("Разговор (новые сообщения ниже):");
  for (const m of win) {
    const author = m.author ?? "неизвестно";
    const reply = m.replyTo != null ? ` (ответ на #${idx.get(m.replyTo) ?? "?"})` : "";
    const out = m.isOutgoing ? " [владелец]" : "";
    lines.push(`#${idx.get(m.tgMsgId)} [${author}, ${fmtTime(m.ts)}]${reply}${out}: ${m.text}`);
  }

  if (input.personHistory.length > 0) {
    lines.push("");
    lines.push("Известная история участников (за 30 дней):");
    for (const p of input.personHistory) {
      lines.push(`- ${p.name}: темы — ${p.topics.slice(0, 5).join(", ")}`);
    }
  }

  if (input.previousAnalysis) {
    lines.push("");
    lines.push(`Предыдущий анализ этого разговора: ${input.previousAnalysis}`);
    lines.push("Обнови оценки с учётом новых сообщений.");
  }

  return lines.join("\n");
}
