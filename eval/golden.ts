// Eval: прогон cheap filter (реальные локальные embeddings) по golden-набору.
// Запуск: bun eval/golden.ts → пишет eval/report.md
import { writeFileSync } from "node:fs";
import { ensureEmbeddings, embedOne, cosine, embedTexts } from "../src/pipeline/embeddings";
import type { ThreadState } from "../src/pipeline/builder";
import { runFilter } from "../src/pipeline/filter";

const golden = (await import("./golden-set.json", { with: { type: "json" } })).default as {
  profile: string;
  cases: { id: number; should_pass: boolean; messages: string[] }[];
};

const ok = await ensureEmbeddings();
if (!ok) {
  console.error("❌ embeddings недоступны");
  process.exit(1);
}

const profileEmb = await embedOne(golden.profile);
const threshold = Number(process.env.FILTER_THRESHOLD ?? 0.3);

const results: { id: number; should: boolean; got: boolean; score: number }[] = [];
for (const c of golden.cases) {
  const base = new Date("2026-08-12T10:00:00Z");
  const thread: ThreadState = {
    id: c.id,
    chatDbId: 1,
    segments: [
      {
        id: 1,
        rootMsgId: 1,
        messages: c.messages.map((text, i) => ({
          chatId: 1,
          tgMsgId: i + 1,
          authorId: 100 + i,
          authorName: `U${i}`,
          text,
          lang: "ru",
          ts: new Date(base.getTime() + i * 60_000),
          isOutgoing: false,
          replyToTgMsgId: null,
        })),
        firstTs: base.getTime(),
        lastTs: base.getTime(),
      },
    ],
    lastTs: base.getTime(),
    lastAnalyzedAt: null,
    analysesToday: 0,
    dayKey: "2026-08-12",
  };
  const res = await runFilter({
    thread,
    profileEmbedding: profileEmb,
    chatWeight: 1,
    anchors: [],
    threshold,
  });
  results.push({ id: c.id, should: c.should_pass, got: res.pass, score: res.score });
}

const tp = results.filter((r) => r.should && r.got).length;
const fp = results.filter((r) => !r.should && r.got).length;
const fn = results.filter((r) => r.should && !r.got).length;
const tn = results.filter((r) => !r.should && !r.got).length;
const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
const accuracy = (tp + tn) / results.length;

const lines = [
  `# Eval report (${new Date().toISOString()})`,
  "",
  `Порог фильтра: ${threshold} · Примеров: ${results.length}`,
  `TP=${tp} FP=${fp} FN=${fn} TN=${tn}`,
  `**Precision: ${(precision * 100).toFixed(1)}%** · **Recall: ${(recall * 100).toFixed(1)}%** · Accuracy: ${(accuracy * 100).toFixed(1)}%`,
  "",
  "| id | должен пройти | фильтр | score |",
  "|---|---|---|---|",
  ...results.map((r) => `| ${r.id} | ${r.should ? "✅" : "❌"} | ${r.got ? "✅" : "❌"} | ${r.score.toFixed(3)} |`),
  "",
  `Провалы: ${results.filter((r) => r.should !== r.got).map((r) => r.id).join(", ") || "нет"}`,
];
writeFileSync("eval/report.md", lines.join("\n"));
console.log(lines.slice(0, 8).join("\n"));
process.exit(0);
