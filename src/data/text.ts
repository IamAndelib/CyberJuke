/** How names and titles are compared: search, artist matching, similar tracks. */

/** Letters NFKD leaves alone but people type without the diacritic. */
const FOLD: Record<string, string> = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i' };

/** Text as search compares it: NFKD, accents stripped, lowercase, anything not a letter or digit a space. */
export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[ßæœøłđðþı]/g, (c) => FOLD[c] ?? c)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The normalized words of [s]. */
export function words(s: string): string[] {
  const n = normalize(s);
  return n ? n.split(' ') : [];
}
