// Daily Digest: сводка возможностей и люди для наблюдения

import { desc, gte, ne, sql } from "drizzle-orm";
import type { Bot, Context } from "grammy";
import { getDb } from "../db/client";
import { opportunities } from "../db/schema";
import { topPeople } from "../people/index";
import type { SettingsStore } from "../settings";
import type { CommandDeps } from "../bot/commands";

export async function buildDigest(deps: { store: SettingsStore }, db = getDb()): Promise<string> {
  const since = new Date(Date.now() - 86_400_000);
  const [rows, people] = await Promise.all([
    db.select().from(opportunities).where(gte(opportunities.createdAt, since)).orderBy(desc(opportunities.priority)).limit(10),
    topPeople(3, 7, db),
  ]);

  const byType = new Map<string, number>();
  for (const r of rows) byType.set(r.type, (byType.get(r.type) ?? 0) + 1);

  const lines: string[] = [];
  lines.push(`📊 Дайджест: найдено возможностей — ${rows.length}`);
  const typeCounts = [
    ["HOT_LEAD", "🔥 горячих"],
    ["WARM_LEAD", "🟢 тёплых"],
    ["EXPERTISE", "🧠 экспертных"],
    ["FUTURE", "🔵 долгосрочных"],
  ] as const;
  const counts = typeCounts.map(([t, label]) => `${byType.get(t) ?? 0} ${label}`).join(" · ");
  if (counts) lines.push(counts);

  const top = rows.slice(0, 3);
  if (top.length > 0) {
    lines.push("");
    lines.push("Лучшие возможности:");
    top.forEach((r, i) => lines.push(`${i + 1}. ${Math.round(r.priority)}% — ${r.summary.slice(0, 70)} (#${r.id})`));
  }

  if (people.length > 0) {
    lines.push("");
    lines.push("Люди для наблюдения:");
    for (const p of people) {
      lines.push(`• ${p.name} — ${p.topics.slice(0, 3).join(", ")} (${p.count} обсуждений)`);
    }
  }

  return lines.join("\n");
}

/** Отправка дайджеста владельцу (команда /digest или по расписанию) */
export async function sendDigest(bot: Bot, deps: CommandDeps, ctx?: Context): Promise<void> {
  const text = await buildDigest(deps);
  const owner = await deps.store.getOwnerId();
  if (owner == null) return;
  if (ctx) {
    await ctx.reply(text);
  } else {
    await bot.api.sendMessage(owner, text, { parse_mode: "HTML" });
  }
}
