/**
 * Artists from artist credits. Pure functions, no globals.
 *
 * A credit is split into separate artists only on `,` `;` `/` and feat./ft./featuring.
 * It is never split on "and" or "&": "The Jesus and Mary Chain" and "Joey Valence & Brae"
 * are one artist each. A `/` only separates when it has a space on at least one side,
 * so "AC/DC" stays whole while "Artist A / Artist B" splits.
 * Names are matched by `normalize` (accents, case and punctuation ignored).
 */
import { UNKNOWN_ARTIST, type Track } from './model';
import { normalize } from './text';

/** "(feat. X)" / "[ft. X]" become ", X" so the brackets don't stick to the names. */
const BRACKETED_FEAT = /[([]\s*(?:feat\.?|ft\.?|featuring)\s+([^)\]]*)[)\]]/gi;
const SEPARATOR = /\s*(?:[,;]|\s\/|\/\s|\s(?:feat\.?|ft\.?|featuring)\s)\s*/i;

/** The separate artists in one credit, in order, without duplicates. */
export function splitArtists(credit: string): string[] {
  const s = (credit ?? '').replace(BRACKETED_FEAT, ', $1').trim();
  if (!s || s === UNKNOWN_ARTIST) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of s.split(SEPARATOR)) {
    const name = tidy(raw);
    const k = artistKey(name);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(name);
  }
  return out;
}

/** Trim, and drop a bracket left dangling by the split ("Name (" / "Other)"). */
function tidy(raw: string): string {
  let n = raw.trim();
  const opens = (n.match(/[([]/g) ?? []).length;
  const closes = (n.match(/[)\]]/g) ?? []).length;
  if (opens > closes) n = n.replace(/^[([]\s*/, '').replace(/\s*[([]\s*$/, '');
  if (closes > opens) n = n.replace(/^\s*[)\]]/, '').replace(/\s*[)\]]$/, '');
  return n.trim();
}

export function artistKey(name: string): string {
  return normalize(name ?? '');
}

/** Drop YouTube's " - Topic" channel suffix from an uploader name. */
export function cleanCredit(credit: string): string {
  return (credit ?? '').replace(/\s+-\s+Topic$/i, '').trim();
}

export interface Artist {
  key: string;
  /** Display name: the most common spelling. */
  name: string;
  /** Tracks crediting this artist (ordering only, never shown). */
  count: number;
}

interface ArtistIndex {
  /** Most-shared first, then by name. */
  artists: Artist[];
  /** Tracks per artist key, in the input order (newest first for the catalog). */
  tracks: Map<string, Track[]>;
  byKey: Map<string, Artist>;
}

export function buildArtistIndex(tracks: Track[]): ArtistIndex {
  const spell = new Map<string, Map<string, number>>();
  const lists = new Map<string, Track[]>();
  for (const t of tracks) {
    for (const name of splitArtists(t.artist)) {
      const k = artistKey(name);
      let sp = spell.get(k);
      if (!sp) spell.set(k, (sp = new Map()));
      sp.set(name, (sp.get(name) ?? 0) + 1);
      let l = lists.get(k);
      if (!l) lists.set(k, (l = []));
      l.push(t);
    }
  }
  const artists: Artist[] = [];
  for (const [key, sp] of spell) {
    // Most common spelling; ties go to the first one seen (the newest post).
    let name = '';
    let best = 0;
    for (const [n, c] of sp) if (c > best) [name, best] = [n, c];
    artists.push({ key, name, count: lists.get(key)!.length });
  }
  artists.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { artists, tracks: lists, byKey: new Map(artists.map((a) => [a.key, a])) };
}
