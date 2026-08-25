// Scoring Engine: приоритет по трекам + персональные веса, уровни уведомлений

import type { AnalysisResult } from "../llm/schema";
import type { OpportunityType, Weights } from "../db/schema";

export interface Scored {
  priority: number;
  base: number;
  weightsApplied: { chat: number; topic: number; type: number };
}

export function basePriority(r: AnalysisResult): number {
  if (r.type === "NOISE") return 0;
  if (r.signal_track === "client") {
    return 0.4 * r.purchase_intent + 0.3 * r.relevance + 0.2 * r.urgency + 0.1 * r.engagement_opportunity;
  }
  return 0.4 * r.engagement_opportunity + 0.3 * r.future_potential + 0.2 * r.relevance + 0.1 * r.purchase_intent;
}

export function applyWeights(
  base: number,
  r: AnalysisResult,
  weights: Weights | undefined,
  chatDbId: number,
): Scored {
  const w = weights ?? { topics: {}, chats: {}, types: {} };
  const chatW = Math.max(0.05, w.chats?.[String(chatDbId)] ?? 1);
  const topicW = Math.max(0.05, w.topics?.[normalizeTopicKey(r.topic)] ?? 1);
  const typeW = Math.max(0.05, w.types?.[r.type] ?? 1);
  const priority = Math.min(100, base * chatW * topicW * typeW);
  return { priority, base, weightsApplied: { chat: chatW, topic: topicW, type: typeW } };
}

export function normalizeTopicKey(topic: string): string {
  return topic.trim().toLowerCase().replace(/\s+/g, " ");
}

export type NotifyLevel = "critical" | "important" | "opportunities";

export function passesLevel(type: OpportunityType, priority: number, level: NotifyLevel): boolean {
  switch (level) {
    case "critical":
      return type === "HOT_LEAD" && priority >= 80;
    case "important":
      return (type === "HOT_LEAD" || type === "WARM_LEAD") && priority >= 65;
    case "opportunities":
      // клиентский трек (HOT/WARM_LEAD) — ниже порог: тёплые запросы важны даже при средней схожести
      if (type === "HOT_LEAD" || type === "WARM_LEAD") return priority >= 45;
      return type !== "NOISE" && type !== "INFORMATION" && priority >= 50;
  }
}

export const TYPE_LABELS: Record<OpportunityType, string> = {
  HOT_LEAD: "🔥 Горячий лид",
  WARM_LEAD: "🟢 Тёплый лид",
  DISCUSSION: "🟡 Обсуждение",
  EXPERTISE: "🧠 Экспертиза",
  NETWORKING: "🤝 Нетворкинг",
  FUTURE: "🔵 На будущее",
  INFORMATION: "ℹ️ Информация",
  NOISE: "🔇 Шум",
};
