// Cheap filter: правила + embeddings-скоринг (профиль + якоря, веса чата).
// Recall-ориентирован: задача не пропустить потенциально интересное.

import type { Profile, Weights } from "../db/schema";
import { cosine, embedTexts } from "./embeddings";
import type { ThreadState } from "./builder";

export interface Anchor {
  id: number;
  text: string;
  embedding?: number[];
  enabled: boolean;
}

export interface FilterInput {
  thread: ThreadState;
  profileEmbedding: number[];
  chatWeight: number;
  anchors: Anchor[];
  threshold: number;
  singleMsgBoost?: number;
  weights?: Weights;
  blacklistedTopics?: string[];
}

export interface FilterResult {
  pass: boolean;
  score: number;
  source: "embeddings" | "rules";
  reason?: string;
}

/** Представитель окна — последние ≤5 текстов */
function windowTexts(thread: ThreadState): string[] {
  const all: string[] = [];
  for (const s of thread.segments) for (const m of s.messages) all.push(m.text);
  return all.slice(-5);
}

function topicPenalty(text: string, blacklisted: string[] | undefined): number {
  if (!blacklisted || blacklisted.length === 0) return 1;
  const lower = text.toLowerCase();
  let penalty = 1;
  for (const t of blacklisted) {
    if (lower.includes(t.toLowerCase())) penalty *= 0.3;
  }
  return penalty;
}

export async function runFilter(input: FilterInput): Promise<FilterResult> {
  const texts = windowTexts(input.thread);
  if (texts.length === 0) return { pass: false, score: 0, source: "rules", reason: "empty_window" };

  const single = input.thread.segments.length === 1 && input.thread.segments[0]!.messages.length === 1;
  const boost = single ? (input.singleMsgBoost ?? 1.25) : 1;
  const effectiveThreshold = input.threshold * boost;

  const penalty = topicPenalty(texts.join("\n"), input.blacklistedTopics);
  const chatW = Math.max(0.05, input.chatWeight);

  const winEmb = await embedTexts(texts);
  const profileSim = cosine(winEmb, input.profileEmbedding);
  let anchorSim = 0;
  for (const a of input.anchors) {
    if (!a.enabled || !a.embedding) continue;
    anchorSim = Math.max(anchorSim, cosine(winEmb, a.embedding));
  }

  const score = Math.max(profileSim, anchorSim) * chatW * penalty;
  const pass = score >= effectiveThreshold;
  return { pass, score, source: "embeddings" };
}

export function buildProfileEmbeddingText(p: Profile): string {
  const parts = [
    p.what_i_do,
    p.services?.join(", "),
    p.products?.join(", "),
    p.niches?.join(", "),
    p.audience,
    p.topics?.join(", "),
    p.expertise?.join(", "),
  ].filter(Boolean);
  return parts.join(". ") || "";
}

export function weightsToChatWeight(weights: Weights | undefined, chatDbId: number): number {
  return weights?.chats?.[String(chatDbId)] ?? 1;
}
