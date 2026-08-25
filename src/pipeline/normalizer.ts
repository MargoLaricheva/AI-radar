// Нормализация и отсев мусора (junk). Дёшево, без LLM.

export interface Normalized {
  text: string;
  lang: string; // ru | en | und
  junk: string | null; // причина отсева или null
}

const MIN_LEN = 20;
const MAX_LEN = 2000;
const MAX_LINKS = 3;
const MAX_MENTIONS = 3;

export function detectLang(text: string): string {
  let cyr = 0;
  let lat = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if ((code >= 0x0400 && code <= 0x04ff) || code === 0x0451 || code === 0x0401) cyr++;
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) lat++;
  }
  const total = cyr + lat;
  if (total === 0) return "und";
  if (cyr / total >= 0.3) return "ru";
  if (lat / total >= 0.3) return "en";
  return "und";
}

export function normalizeMessage(raw: string): Normalized {
  const text = raw.trim();
  if (text.length === 0) return { text, lang: "und", junk: "empty" };
  if (text.length < MIN_LEN) return { text, lang: detectLang(text), junk: "too_short" };
  if (text.length > MAX_LEN) return { text: text.slice(0, MAX_LEN), lang: detectLang(text), junk: "too_long" };

  const links = (text.match(/https?:\/\/\S+/g) ?? []).length;
  if (links > MAX_LINKS) return { text, lang: detectLang(text), junk: "link_spam" };

  const mentions = (text.match(/@\w{3,}/g) ?? []).length;
  if (mentions > MAX_MENTIONS) return { text, lang: detectLang(text), junk: "mention_spam" };

  return { text, lang: detectLang(text), junk: null };
}
