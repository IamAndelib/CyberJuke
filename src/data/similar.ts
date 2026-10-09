/**
 * Jukebox autoplay (AP2): tracks similar to a seed, picked from the cached catalog. Pure: no
 * network, no globals (the random source is injectable). A Jukebox seed only ever leads to
 * Jukebox tracks; Global tracks are never candidates.
 *
 * How alike two tracks are (pairScore):
 *  - the same artist (split credits, so features count);
 *  - the same genre: equal, overlapping words ("indie rock" ~ "rock") or one genre family
 *    (rock/metal/punk..., see GENRE_FAMILIES);
 *  - "same vibe": the posters who share artist A also share artist B (cosine over the two
 *    artists' poster sets), built once per catalog array and memoised;
 *  - the same poster: a small boost.
 * A candidate's score is 60% its likeness to the seed and 40% to the last 3 played (so the
 * radio follows the vibe without wandering off), plus light boosts for saves and recency.
 *
 * Picking: weighted random draws from the top candidates, so each radio differs. Never the
 * same artist twice in a row, at most 2 tracks by one artist in any 10. When good matches run
 * out it widens to the seed's genre family, then to popular Jukebox tracks.
 */
import { isGlobal, type Track } from './model';
import { artistKey, splitArtists } from './artists';
import { normalize, words } from './search';

export const W_ARTIST = 3;
export const W_GENRE = 2.5;
export const W_VIBE = 2;
export const W_POSTER = 0.5;
export const W_SAVES = 0.4;
export const W_RECENT = 0.3;
/** Share of the score from the seed; the rest from the last DRIFT_TRACKS played. */
export const SEED_SHARE = 0.6;
export const DRIFT_TRACKS = 3;
/** Recently played tracks left out. */
export const EXCLUDE_RECENT = 50;
/** Draws are made among this many best candidates. */
export const TOP_K = 12;
/** Likeness that counts as a good match (an equal genre, the same artist, a strong vibe...). */
export const GOOD_MATCH = 1;
export const VARIETY_WINDOW = 10;
export const MAX_PER_ARTIST = 2;
const RECENCY_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Genre families: a genre belongs to every family with a key among its words (normalized,
 * whole words, so "r&b" is "r b" and "hip hop" needs both words). Families may overlap.
 */
export const GENRE_FAMILIES: Record<string, readonly string[]> = {
  rock: ['rock', 'metal', 'punk', 'grunge', 'alt', 'alternative', 'hardcore', 'emo', 'shoegaze', 'post rock', 'post punk', 'garage rock', 'prog', 'doom', 'stoner', 'screamo', 'math rock', 'new wave'],
  electronic: [
    'electronic', 'electronica', 'house', 'techno', 'edm', 'dnb', 'drum and bass', 'drum n bass', 'jungle', 'trance', 'synthwave', 'outrun', 'idm', 'dubstep',
    'breakcore', 'breakbeat', 'electro', 'acid', 'chiptune', 'vaporwave', 'chillwave', 'darkwave', 'industrial', 'minimal', 'downtempo', 'trip hop', '2 step',
    'uk garage', 'hardstyle', 'eurodance', 'witch house', 'future bass', 'synth',
  ],
  'hip hop': ['hip hop', 'hiphop', 'rap', 'trap', 'drill', 'grime', 'phonk', 'boom bap', 'cloud rap'],
  'r&b': ['r b', 'rnb', 'soul', 'funk', 'disco', 'gospel', 'motown', 'neo soul', 'new jack swing'],
  pop: ['pop', 'k pop', 'kpop', 'j pop', 'jpop', 'dance pop', 'synthpop', 'synth pop', 'electropop', 'city pop', 'hyperpop', 'europop', 'italo disco', 'ポップ'],
  indie: ['indie', 'lo fi', 'lofi', 'bedroom', 'dream pop', 'chillwave', 'shoegaze', 'slowcore', 'jangle'],
  jazz: ['jazz', 'blues', 'bossa nova', 'swing', 'bebop', 'fusion', 'big band'],
  classical: ['classical', 'ambient', 'soundtrack', 'ost', 'score', 'orchestral', 'piano', 'new age', 'drone', 'neoclassical', 'cinematic'],
  folk: ['folk', 'country', 'acoustic', 'bluegrass', 'americana', 'singer songwriter'],
  latin: ['latin', 'reggaeton', 'salsa', 'bachata', 'cumbia', 'dembow', 'musica popular', 'bossa nova', 'zouk'],
  reggae: ['reggae', 'dub', 'ska', 'dancehall', 'rocksteady'],
  african: ['afrobeat', 'afrobeats', 'amapiano', 'highlife', 'zouk'],
  experimental: ['experimental', 'noise', 'plunderphonics', 'avant garde', 'glitch', 'idm'],
};

const FAMILY_KEYS: [string, string][] = Object.entries(GENRE_FAMILIES).flatMap(([f, keys]) => keys.map((k) => [f, ` ${normalize(k)} `] as [string, string]));
const STOP = new Set(['music', 'and', 'the', 'of', 'n', 'x']);

/** The genre families of a free-text genre. */
export function genreFamilies(genre: string): Set<string> {
  const g = ` ${normalize(genre ?? '')} `;
  const out = new Set<string>();
  if (g.trim()) for (const [f, k] of FAMILY_KEYS) if (g.includes(k)) out.add(f);
  return out;
}

interface Feat {
  track: Track;
  artists: string[];
  genre: string;
  tokens: Set<string>;
  families: Set<string>;
  poster: string;
}

export interface SimilarIndex {
  feats: Feat[];
  /** artist key -> the posters who shared them */
  posters: Map<string, Set<string>>;
  maxSaves: number;
  /** Memoised artist-pair cosines. */
  cos: Map<string, number>;
}

function featOf(t: Track): Feat {
  const genre = normalize(t.genre ?? '');
  return {
    track: t,
    artists: splitArtists(t.artist ?? '').map(artistKey).filter(Boolean),
    genre,
    tokens: new Set(words(t.genre ?? '').filter((w) => w.length > 1 && !STOP.has(w))),
    families: genreFamilies(t.genre ?? ''),
    poster: (t.by ?? '').trim().toLowerCase(),
  };
}

const indexes = new WeakMap<readonly Track[], SimilarIndex>();

/** The similarity index of one catalog array (memoised: build once per catalog version). */
export function similarIndex(catalog: readonly Track[]): SimilarIndex {
  const hit = indexes.get(catalog);
  if (hit) return hit;
  const feats = catalog.map(featOf);
  const posters = new Map<string, Set<string>>();
  let maxSaves = 0;
  for (const f of feats) {
    maxSaves = Math.max(maxSaves, f.track.saves ?? 0);
    if (!f.poster) continue;
    for (const a of f.artists) {
      let s = posters.get(a);
      if (!s) posters.set(a, (s = new Set()));
      s.add(f.poster);
    }
  }
  const idx: SimilarIndex = { feats, posters, maxSaves, cos: new Map() };
  indexes.set(catalog, idx);
  return idx;
}

/** Cosine over two artists' poster sets, shrunk when few posters are shared. */
function artistCosine(idx: SimilarIndex, x: string, y: string): number {
  if (x === y) return 1;
  const key = x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`;
  const hit = idx.cos.get(key);
  if (hit !== undefined) return hit;
  const a = idx.posters.get(x);
  const b = idx.posters.get(y);
  let v = 0;
  if (a && b) {
    let inter = 0;
    for (const p of a.size < b.size ? a : b) if ((a.size < b.size ? b : a).has(p)) inter++;
    v = inter ? (inter / Math.sqrt(a.size * b.size)) * (inter / (inter + 1)) : 0;
  }
  idx.cos.set(key, v);
  return v;
}

function genreScore(a: Feat, b: Feat): number {
  if (!a.genre || !b.genre) return 0;
  if (a.genre === b.genre) return 1;
  let s = 0;
  if (a.tokens.size && b.tokens.size) {
    let inter = 0;
    for (const w of a.tokens) if (b.tokens.has(w)) inter++;
    s = (0.8 * inter) / Math.min(a.tokens.size, b.tokens.size);
  }
  for (const f of a.families) {
    if (b.families.has(f)) return Math.max(s, 0.4);
  }
  return s;
}

/** How alike two tracks are (0 = nothing in common). */
function pairScore(idx: SimilarIndex, a: Feat, b: Feat): number {
  let s = 0;
  if (a.artists.some((x) => b.artists.includes(x))) s += W_ARTIST;
  else {
    let vibe = 0;
    for (const x of a.artists) for (const y of b.artists) vibe = Math.max(vibe, artistCosine(idx, x, y));
    s += W_VIBE * vibe;
  }
  s += W_GENRE * genreScore(a, b);
  if (a.poster && a.poster === b.poster) s += W_POSTER;
  return s;
}

export interface SimilarOptions {
  seed: Track;
  /** Recently played, newest first: the first EXCLUDE_RECENT are left out. */
  recent?: readonly Track[];
  /**
   * Played since this seed started (the radio or list), newest first: the first
   * DRIFT_TRACKS Jukebox ones steer the seed. Plays from before it don't.
   */
  played?: readonly Track[];
  /** Ids or video ids to leave out (everything already in the queue). */
  exclude?: Iterable<string>;
  /** What plays just before the picks, oldest first (the variety rules look at it). */
  before?: readonly Track[];
  count: number;
  showNsfw: boolean;
  signedIn: boolean;
  rng?: () => number;
  now?: number;
}

interface Scored {
  f: Feat;
  like: number;
  score: number;
}

/**
 * Up to `count` Jukebox tracks to play after `seed`, best matches first in spirit but drawn
 * at random among the top candidates. Fewer (or none) when the catalog has nothing left that
 * passes the filters and variety rules.
 */
export function similarTracks(catalog: readonly Track[], o: SimilarOptions): Track[] {
  if (o.count <= 0 || !catalog.length) return [];
  const idx = similarIndex(catalog);
  const rng = o.rng ?? Math.random;
  const now = o.now ?? Date.now();
  const recent = o.recent ?? [];

  const out = new Set<string>(o.exclude ?? []);
  out.add(o.seed.id);
  out.add(o.seed.ytId);
  for (const t of recent.slice(0, EXCLUDE_RECENT)) {
    out.add(t.id);
    out.add(t.ytId);
  }

  const seed = featOf(o.seed);
  const drift = (o.played ?? [])
    .filter((t) => t.id !== o.seed.id && !isGlobal(t))
    .slice(0, DRIFT_TRACKS)
    .map(featOf);

  const seen = new Set<string>();
  const scored: Scored[] = [];
  for (const f of idx.feats) {
    const t = f.track;
    if (isGlobal(t) || out.has(t.id) || out.has(t.ytId) || seen.has(t.ytId)) continue;
    if (t.nsfw && !o.showNsfw) continue;
    if (t.membersOnly && !o.signedIn) continue;
    seen.add(t.ytId);
    const toSeed = pairScore(idx, seed, f);
    const like = drift.length ? SEED_SHARE * toSeed + (1 - SEED_SHARE) * mean(drift.map((d) => pairScore(idx, d, f))) : toSeed;
    scored.push({ f, like, score: like + boost(idx, t, now) });
  }

  // Tiers: good matches, then the seed's genre family (or anything alike at all), then popular.
  const byScore = (a: Scored, b: Scored) => b.score - a.score;
  const good = scored.filter((s) => s.like >= GOOD_MATCH).sort(byScore);
  const near = scored.filter((s) => s.like < GOOD_MATCH && (s.like > 0 || [...s.f.families].some((x) => seed.families.has(x)))).sort(byScore);
  const inNear = new Set(near);
  const rest = scored
    .filter((s) => s.like < GOOD_MATCH && !inNear.has(s))
    .map((s) => ({ ...s, score: boost(idx, s.f.track, now) }))
    .sort(byScore);
  const tiers = [good, near, rest];

  // What plays before the picks; when nothing is given, the seed does.
  const history: string[][] = (o.before ?? []).slice(-(VARIETY_WINDOW - 1)).map((t) => featOf(t).artists);
  if (!history.length) history.push(seed.artists);
  const used = new Set<Scored>();
  const picks: Track[] = [];
  while (picks.length < o.count) {
    let pool: Scored[] = [];
    for (const tier of tiers) {
      pool = [];
      for (const s of tier) {
        if (used.has(s) || !varietyOk(history, s.f.artists)) continue;
        pool.push(s);
        if (pool.length >= TOP_K) break;
      }
      if (pool.length) break;
    }
    if (!pool.length) break;
    const pick = draw(pool, rng);
    used.add(pick);
    picks.push(pick.f.track);
    history.push(pick.f.artists);
  }
  return picks;
}

/** Saves and recency: light, so they only break near-ties. */
function boost(idx: SimilarIndex, t: Track, now: number): number {
  const saves = idx.maxSaves > 0 ? Math.log1p(t.saves ?? 0) / Math.log1p(idx.maxSaves) : 0;
  const at = Date.parse(t.createdAt);
  const fresh = Number.isFinite(at) ? Math.exp(-Math.max(0, now - at) / (RECENCY_DAYS * DAY_MS)) : 0;
  return W_SAVES * saves + W_RECENT * fresh;
}

/** Never the same artist twice in a row; at most MAX_PER_ARTIST by one artist in any VARIETY_WINDOW. */
function varietyOk(history: string[][], artists: string[]): boolean {
  if (!artists.length) return true;
  const last = history[history.length - 1];
  if (last && artists.some((a) => last.includes(a))) return false;
  const window = history.slice(-(VARIETY_WINDOW - 1));
  for (const a of artists) {
    let n = 0;
    for (const h of window) if (h.includes(a)) n++;
    if (n >= MAX_PER_ARTIST) return false;
  }
  return true;
}

/** A weighted random pick (weight = score squared, so better matches come up more often). */
function draw(pool: Scored[], rng: () => number): Scored {
  const w = pool.map((s) => Math.max(0.05, s.score) ** 2);
  let r = rng() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) {
    r -= w[i];
    if (r < 0) return pool[i];
  }
  return pool[pool.length - 1];
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
