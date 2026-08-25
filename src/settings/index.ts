// Доступ к настройкам/профилю/весам единственного пользователя (users.settings, users.profile)

import { eq } from "drizzle-orm";
import { getDb, type Db } from "../db/client";
import { users } from "../db/schema";
import type { Profile, Settings, Weights } from "../db/schema";
import { parseQuietHours } from "../config";
import type { Env } from "../config";
import { embedOne } from "../pipeline/embeddings";
import { buildProfileEmbeddingText } from "../pipeline/filter";

export interface SettingsStore {
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  getProfile(): Promise<Profile>;
  updateProfile(patch: Partial<Profile>): Promise<Profile>;
  getWeights(): Promise<Weights>;
  saveWeights(w: Weights): Promise<void>;
  getOwnerId(): Promise<number | null>;
  setOwnerId(id: number): Promise<void>;
  getProfileEmbedding(): Promise<number[]>;
  isPaused(): Promise<boolean>;
  quietHours(env: Env): Promise<{ start: number; end: number } | null>;
}

export function createSettingsStore(db: Db = getDb()): SettingsStore {
  let profileEmbCache: { text: string; emb: number[] } | null = null;

  async function userRow(): Promise<{ id: number; profile: Profile; settings: Settings }> {
    const rows = await db.select({ id: users.id, profile: users.profile, settings: users.settings }).from(users).limit(1);
    if (rows[0]) return rows[0]!;
    const created = await db.insert(users).values({}).returning({ id: users.id, profile: users.profile, settings: users.settings });
    return created[0]!;
  }

  return {
    async getSettings() {
      const u = await userRow();
      return u.settings ?? {};
    },
    async updateSettings(patch) {
      const u = await userRow();
      const merged = { ...(u.settings ?? {}), ...patch };
      await db.update(users).set({ settings: merged }).where(eq(users.id, u.id));
      return merged;
    },
    async getProfile() {
      const u = await userRow();
      return u.profile ?? {};
    },
    async updateProfile(patch) {
      const u = await userRow();
      const merged = { ...(u.profile ?? {}), ...patch };
      await db.update(users).set({ profile: merged }).where(eq(users.id, u.id));
      profileEmbCache = null;
      return merged;
    },
    async getWeights() {
      const s = await this.getSettings();
      return s.weights ?? { topics: {}, chats: {}, types: {} };
    },
    async saveWeights(w) {
      await this.updateSettings({ weights: w });
    },
    async getOwnerId() {
      const s = await this.getSettings();
      const raw = s.owner_id ?? process.env.OWNER_ID ?? "";
      const n = Number(raw);
      return raw && Number.isFinite(n) ? n : null;
    },
    async setOwnerId(id) {
      await this.updateSettings({ owner_id: String(id) });
    },
    async getProfileEmbedding() {
      const profile = await this.getProfile();
      const text = buildProfileEmbeddingText(profile);
      if (profileEmbCache && profileEmbCache.text === text) return profileEmbCache.emb;
      const emb = text ? await embedOne(text) : [];
      profileEmbCache = { text, emb };
      return emb;
    },
    async isPaused() {
      const s = await this.getSettings();
      return s.paused === true;
    },
    async quietHours(env) {
      const s = await this.getSettings();
      const raw = s.quiet_hours ? `${pad(s.quiet_hours.start)}-${pad(s.quiet_hours.end)}` : env.QUIET_HOURS;
      const qh = parseQuietHours(raw);
      if (qh.start === qh.end) return null;
      return qh;
    },
  };
}

function pad(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export type SettingsStoreT = ReturnType<typeof createSettingsStore>;
