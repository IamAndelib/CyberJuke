/**
 * Local search over the catalog. Pure functions, no globals.
 *
 * Word-based matching with light typo tolerance:
 *  - query and text are normalized (NFKD, accents stripped, lowercase, anything that
 *    is not a letter or digit becomes a space) and split into words;
 *  - every query word must match somewhere (AND), taking its best match:
 *      exact 1.0, start of a word 0.9, inside a word 0.6 (3+ letters),
 *      typo 0.5 (Damerau-Levenshtein 1 for 5-7 letters, 2 for 8+; never for 1-4);
 *  - each match is weighted by field (title/artist 3, genre/poster 2, post title 1);
 *  - +2 when the whole query appears in the title or artist as a phrase starting at a
 *    word boundary; ties go to Jukebox tracks before Global ones, then the newest post.
 */
import { isGlobal, type Track } from './model';

export const MAX_RESULTS = 100;
export const MAX_GENRES = 8;
export const PHRASE_BONUS = 2;

export const W_TITLE = 3;
export const W_ARTIST = 3;
export const W_GENRE = 2;
export const W_POSTER = 2;
export const W_POST_TITLE = 1;

/** Letters NFKD leaves alone but people type without the diacritic. */
const FOLD: Record<string, string> = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i' };

export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[ßæœøłđðþı]/g, (c) => FOLD[c] ?? c)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function words(s: string): string[] {
  const n = normalize(s);
  return n ? n.split(' ') : [];
}

/** Optimal-string-alignment distance (Damerau-Levenshtein with adjacent swaps), capped. */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

/** How well one query word matches one indexed word (0 = not at all). */
export function matchWord(q: string, w: string): number {
  if (q === w) return 1;
  if (w.startsWith(q)) return 0.9;
  if (q.length >= 3 && w.includes(q)) return 0.6;
  if (q.length >= 5) {
    const max = q.length >= 8 ? 2 : 1;
    if (editDistance(q, w, max) <= max) return 0.5;
    if (w.length > q.length && editDistance(q, w.slice(0, q.length), max) <= max) return 0.5;
  }
  return 0;
}

interface Field {
  words: string[];
  weight: number;
}

export interface IndexedTrack {
  track: Track;
  fields: Field[];
  /** Normalized title and artist, space-padded, for the phrase bonus. */
  phrase: string[];
}

export type SearchIndex = IndexedTrack[];

export function buildIndex(tracks: Track[]): SearchIndex {
  return tracks.map((track) => ({
    track,
    fields: [
      { words: words(track.title), weight: W_TITLE },
      { words: words(track.artist), weight: W_ARTIST },
      { words: words(track.genre), weight: W_GENRE },
      { words: words(track.by), weight: W_POSTER },
      { words: words(track.postTitle), weight: W_POST_TITLE },
    ],
    phrase: [' ' + normalize(track.title) + ' ', ' ' + normalize(track.artist) + ' '],
  }));
}

/** Sum of each query word's best weighted match, or 0 if any word matches nothing. */
function scoreFields(qWords: string[], fields: Field[]): number {
  let total = 0;
  for (const q of qWords) {
    let best = 0;
    for (const f of fields) {
      for (const w of f.words) {
        const m = matchWord(q, w) * f.weight;
        if (m > best) best = m;
      }
    }
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

export function scoreTrack(qWords: string[], qPhrase: string, item: IndexedTrack): number {
  const s = scoreFields(qWords, item.fields);
  if (s === 0) return 0;
  const needle = ' ' + qPhrase;
  return item.phrase.some((p) => p.includes(needle)) ? s + PHRASE_BONUS : s;
}

export function searchTracks(index: SearchIndex, query: string, limit = MAX_RESULTS): Track[] {
  const qWords = words(query);
  if (!qWords.length) return [];
  const qPhrase = qWords.join(' ');
  const hits: { t: Track; s: number }[] = [];
  for (const item of index) {
    const s = scoreTrack(qWords, qPhrase, item);
    if (s > 0) hits.push({ t: item.track, s });
  }
  hits.sort(
    (a, b) =>
      b.s - a.s ||
      Number(isGlobal(a.t)) - Number(isGlobal(b.t)) ||
      (a.t.createdAt < b.t.createdAt ? 1 : a.t.createdAt > b.t.createdAt ? -1 : 0),
  );
  return hits.slice(0, limit).map((h) => h.t);
}

/** Identity for de-duplicating one song across lists: normalized title and first credited artist. */
function songKey(t: Track): string {
  const first = t.artist.split(/\s*(?:[,;]|\s\/\s|\s(?:feat\.?|ft\.?|featuring)\s)\s*/i)[0] ?? '';
  return normalize(t.title) + '|' + normalize(first);
}

/**
 * Several track lists as one, in the order given (earlier lists win: pass the
 * Jukebox's first). A track is dropped when an earlier list already has the same
 * song: the same ytId, or the same normalized title and first credited artist.
 * Within one list nothing is dropped (two posts of one song stay two posts).
 * At most `limit` tracks.
 */
export function mergeTracks(lists: readonly (readonly Track[])[], limit = Infinity): Track[] {
  const out: Track[] = [];
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const list of lists) {
    const added: Track[] = [];
    for (const t of list) {
      if (out.length >= limit) return out;
      if ((t.ytId && ids.has(t.ytId)) || keys.has(songKey(t))) continue;
      out.push(t);
      added.push(t);
    }
    for (const t of added) {
      if (t.ytId) ids.add(t.ytId);
      keys.add(songKey(t));
    }
  }
  return out;
}

/** Items whose title matches the query (every word, typo-tolerant), best first; ties keep their order. */
export function searchTitles<T>(items: readonly T[], title: (item: T) => string, query: string, limit = MAX_GENRES): T[] {
  const qWords = words(query);
  if (!qWords.length) return [];
  const needle = ' ' + qWords.join(' ');
  const hits: { item: T; s: number; i: number }[] = [];
  items.forEach((item, i) => {
    const norm = normalize(title(item));
    let s = scoreFields(qWords, [{ words: norm ? norm.split(' ') : [], weight: 1 }]);
    if (s === 0) return;
    if ((' ' + norm + ' ').includes(needle)) s += PHRASE_BONUS;
    hits.push({ item, s, i });
  });
  hits.sort((a, b) => b.s - a.s || a.i - b.i);
  return hits.slice(0, limit).map((h) => h.item);
}

/** Genre names matching the query, best first (ties: more tracks first). */
export function searchGenres(genres: { name: string; count: number }[], query: string, limit = MAX_GENRES): string[] {
  const qWords = words(query);
  if (!qWords.length) return [];
  const needle = ' ' + qWords.join(' ');
  const hits: { name: string; s: number; count: number }[] = [];
  for (const g of genres) {
    const norm = normalize(g.name);
    let s = scoreFields(qWords, [{ words: norm ? norm.split(' ') : [], weight: 1 }]);
    if (s === 0) continue;
    if ((' ' + norm + ' ').includes(needle)) s += PHRASE_BONUS;
    hits.push({ name: g.name, s, count: g.count });
  }
  hits.sort((a, b) => b.s - a.s || b.count - a.count || a.name.localeCompare(b.name));
  return hits.slice(0, limit).map((h) => h.name);
}
