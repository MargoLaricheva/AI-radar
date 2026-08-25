// OpenAI-совместимый LLM-клиент (opencode go / DeepSeek) с ретраями и учётом расходов

import { getDb } from "../db/client";
import { llmRequests } from "../db/schema";
import { analysisSchema, type AnalysisResult } from "./schema";
import type { Env } from "../config";
import type pino from "pino";

export type LlmStage = "analyze" | "filter" | "teach" | "digest";

export interface LlmUsage {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  ms: number;
}

export interface LlmCall {
  result: AnalysisResult | null;
  usage: LlmUsage;
  error?: string;
}

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

interface RawChatResult {
  content: string;
  tokensIn: number;
  tokensOut: number;
}

export class LlmClient {
  constructor(
    private env: Env,
    private log: pino.Logger,
  ) {}

  analyze(system: string, user: string): Promise<LlmCall> {
    return this.chat([{ role: "system", content: system }, { role: "user", content: user }], "analyze");
  }

  classify(system: string, user: string): Promise<LlmCall> {
    return this.chat([{ role: "system", content: system }, { role: "user", content: user }], "filter");
  }

  teach(system: string, user: string): Promise<LlmCall> {
    return this.chat([{ role: "system", content: system }, { role: "user", content: user }], "teach");
  }

  private async chat(messages: ChatMessage[], stage: LlmStage): Promise<LlmCall> {
    const started = Date.now();
    let lastError: string | undefined;
    let lastRaw = "";

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await this.rawChat(messages);
        lastRaw = raw.content;
        const parsed = this.parseAnalysis(raw.content);
        if (!parsed) {
          lastError = "invalid_json";
          if (attempt === 0) {
            messages = [...messages, { role: "user", content: "Верни ТОЛЬКО валидный JSON по схеме, без markdown." }];
            continue;
          }
          break;
        }
        await this.recordUsage(stage, raw, started);
        return { result: parsed, usage: this.toUsage(raw, started) };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.log.warn({ err: lastError, attempt }, "LLM-вызов не удался, повтор");
      }
    }

    this.log.error({ error: lastError, raw: lastRaw.slice(0, 300) }, "LLM: все попытки исчерпаны");
    return { result: null, usage: { tokensIn: 0, tokensOut: 0, costUsd: 0, ms: Date.now() - started }, error: lastError };
  }

  private async rawChat(messages: ChatMessage[]): Promise<RawChatResult> {
    const { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL } = this.env;
    const res = await fetch(`${LLM_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages,
        temperature: 0.2,
        max_tokens: 6000,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM: пустой ответ");
    return {
      content,
      tokensIn: data.usage?.prompt_tokens ?? 0,
      tokensOut: data.usage?.completion_tokens ?? 0,
    };
  }

  private parseAnalysis(raw: string): AnalysisResult | null {
    const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    try {
      const obj = JSON.parse(cleaned);
      const parsed = analysisSchema.safeParse(obj);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private toUsage(raw: RawChatResult, started: number): LlmUsage {
    const costUsd = (raw.tokensIn / 1_000_000) * this.env.LLM_COST_IN + (raw.tokensOut / 1_000_000) * this.env.LLM_COST_OUT;
    return { tokensIn: raw.tokensIn, tokensOut: raw.tokensOut, costUsd, ms: Date.now() - started };
  }

  private async recordUsage(stage: LlmStage, raw: RawChatResult, started: number): Promise<void> {
    try {
      const db = getDb();
      await db.insert(llmRequests).values({
        stage,
        model: this.env.LLM_MODEL,
        tokensIn: raw.tokensIn,
        tokensOut: raw.tokensOut,
        costUsd: this.toUsage(raw, started).costUsd,
        ms: Date.now() - started,
      });
    } catch (err) {
      this.log.warn({ err }, "не удалось записать llm_requests");
    }
  }
}
