import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Шифрование session-string (AES-256-GCM, random IV на каждое сохранение)

const DATA_DIR = "data";
const KEY_FILE = `${DATA_DIR}/key.bin`;

function loadOrCreateKey(envKey: string): Buffer {
  if (envKey) {
    const hex = envKey.replace(/^0x/, "");
    if (hex.length !== 64) throw new Error("SESSION_KEY должен быть 32 байта в hex (64 символа)");
    return Buffer.from(hex, "hex");
  }
  if (existsSync(KEY_FILE)) return readFileSync(KEY_FILE);
  mkdirSync(dirname(KEY_FILE), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(KEY_FILE, key, { mode: 0o600 });
  return key;
}

export function getKey(envKey: string): Buffer {
  return loadOrCreateKey(envKey);
}

export function encryptSession(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptSession(payload: string, key: Buffer): string {
  const buf = Buffer.from(payload, "base64");
  if (buf.length < 28) throw new Error("Некорректный шифротекст session");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

export function hashSecret(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
