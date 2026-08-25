// Локальные embeddings (transformers.js + MiniLM multilingual).
// Ленивая загрузка модели; при ошибке — сигнал для fallback на LLM-фильтр.

import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import type pino from "pino";

const MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

let extractor: FeatureExtractionPipeline | null = null;
let failed = false;

export function embeddingsFailed(): boolean {
  return failed;
}

export async function ensureEmbeddings(log?: pino.Logger): Promise<boolean> {
  if (extractor) return true;
  if (failed) return false;
  try {
    extractor = await pipeline("feature-extraction", MODEL, { dtype: "q8" });
    log?.info({ model: MODEL }, "embeddings загружены");
    return true;
  } catch (err) {
    failed = true;
    log?.error({ err }, "не удалось загрузить embeddings, переключаюсь на LLM-фильтр");
    return false;
  }
}

async function embed(text: string): Promise<number[]> {
  if (!extractor) throw new Error("embeddings не инициализированы");
  const out = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(out.data as unknown as Float32Array);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** mean-pool эмбеддинг для набора текстов (представитель окна) */
export async function embedTexts(texts: string[]): Promise<number[]> {
  if (texts.length === 0) return [];
  if (texts.length === 1) return embed(texts[0]!);
  const vecs = await Promise.all(texts.map((t) => embed(t)));
  const dim = vecs[0]!.length;
  const sum = new Array<number>(dim).fill(0);
  for (const v of vecs) for (let i = 0; i < dim; i++) sum[i]! += v[i]!;
  return sum.map((x) => x / vecs.length);
}

export async function embedOne(text: string): Promise<number[]> {
  return embed(text);
}
