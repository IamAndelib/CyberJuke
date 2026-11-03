/**
 * Artists from artist credits. Pure functions, no globals.
 *
 * A credit is split into separate artists only on `,` `;` `/` and feat./ft./featuring.
 * It is never split on "and" or "&": "The Jesus and Mary Chain" and "Joey Valence & Brae"
 * are one artist each. A `/` only separates when it has a space on at least one side,
 * so "AC/DC" stays whole while "Artist A / Artist B" splits. A comma before Jr., Sr., II, III,
 * IV, Inc. or Ltd. belongs to the name: "Grover Washington, Jr." is one artist. So do the
 * well-known names that hold a separator (artistNames.json): "Earth, Wind & Fire" is one artist.
 * Names are matched by `normalize` (accents, case and punctuation ignored).
 */
import { UNKNOWN_ARTIST, type Track } from './model';
import { normalize } from './text';
import artistNames from './artistNames.json' with { type: 'json' };

/** "(feat. X)" / "[ft. X]" become ", X" so the brackets don't stick to the names. */
const BRACKETED_FEAT = /[([]\s*(?:feat\.?|ft\.?|featuring)\s+([^)\]]*)[)\]]/gi;
/** A suffix that ends a name: followed by the end of the credit or another separator. */
const SUFFIX = String.raw`\s*(?:jr|sr|ii|iii|iv|inc|ltd)\.?(?=\s*(?:$|[,;)\]]|\/|\s(?:feat\.?|ft\.?|featuring)\s))`;
/** Captured, so a known name's parts can be joined back with what stood between them. */
const SEPARATOR = new RegExp(String.raw`(\s*(?:;|,(?!${SUFFIX})|\s\/|\/\s|\s(?:feat\.?|ft\.?|featuring)\s)\s*)`, 'i');
/** A known name's key: "&" reads as "and", so "Earth, Wind and Fire" is known too. */
const knownKey = (s: string) => normalize(s.replace(/&/g, ' and '));
const KNOWN_NAMES = artistNames.names;
const KNOWN = new Set(KNOWN_NAMES.map(knownKey));
/** Most pieces (names and separators) a known name splits into. */
const KNOWN_SPAN = Math.max(1, ...KNOWN_NAMES.map((n) => n.split(SEPARATOR).length));

/** The pieces of a split credit as names: the longest run of pieces that is a known name, else one. */
function rejoinKnown(pieces: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < pieces.length; ) {
    let j = Math.min(pieces.length, i + KNOWN_SPAN);
    while (j > i + 1 && !KNOWN.has(knownKey(pieces.slice(i, j).join('')))) j -= 2;
    out.push(pieces.slice(i, j).join(''));
    i = j + 1;
  }
  return out;
}

/** The separate artists in one credit, in order, without duplicates. */
export function splitArtists(credit: string): string[] {
  const s = (credit ?? '').replace(BRACKETED_FEAT, ', $1').trim();
  if (!s || s === UNKNOWN_ARTIST) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of rejoinKnown(s.split(SEPARATOR))) {
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

/** A credited artist, with their channel when YouTube Music linked one. */
export interface CreditedArtist {
  name: string;
  channelId?: string;
}

/** A track's artists: a Global song's linked credits as YouTube Music gives them, else its split credit. */
export function creditedArtists(t: Pick<Track, 'artist' | 'artists'>): CreditedArtist[] {
  return t.artists?.length ? t.artists : splitArtists(t.artist).map((name) => ({ name }));
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
