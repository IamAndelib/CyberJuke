/**
 * User library: liked tracks, recently played, favorite genres and settings.
 * Small keys live in Preferences (localStorage on the web). Liked and history are files,
 * `cyberjuke/liked.json` and `cyberjuke/history.json` (see core/storage), migrated once from
 * Preferences: they can hold members-only tracks, and that folder is kept out of backups
 * (android/app/src/main/res/xml/data_extraction_rules.xml), unlike Preferences.
 */
import { computed, signal } from '@preact/signals';
import type { Track } from '../data/model';
import { artistKey } from '../data/artists';
import { auth } from '../data/auth';
import { asTrack, asTracks } from '../core/guards';
import { jsonFile, kv, readJson, type JsonFile, type KV } from '../core/storage';
import { addPlay, dayKey, decodeHistory, encodeHistory, pruneHistory, uniqueTracks, withinHistoryDays, type HistoryEntry } from './history';

export const THEMES = ['dark', 'light', 'c64', 'vt320', 'matrix', 'crypt', 'bubblegum', 'brutalist'] as const;
export type ThemeId = (typeof THEMES)[number];
export const THEME_LABELS: Record<ThemeId, string> = {
  dark: 'Dark',
  light: 'Light',
  c64: 'C64',
  vt320: 'VT320',
  matrix: 'Matrix',
  crypt: 'Crypt',
  bubblegum: 'Bubblegum',
  brutalist: 'Brutalist',
};

export type Quality = 'high' | 'low';

/** Minutes between checks for new tracks; 0 = only when I refresh. */
type CheckEvery = 5 | 15 | 30 | 60 | 0;
export const CHECK_EVERY_OPTIONS: readonly CheckEvery[] = [5, 15, 30, 60, 0];
export const CHECK_EVERY_LABELS: Record<CheckEvery, string> = {
  5: '5 min',
  15: '15 min',
  30: '30 min',
  60: '1 hour',
  0: 'Only when I refresh',
};

export interface Settings {
  theme: ThemeId;
  showNsfw: boolean;
  quality: Quality;
  checkEvery: CheckEvery;
  /**
   * Y6: YouTube requests over IPv4. 'auto' switches by itself when YouTube limits a request
   * that went out over IPv6 (remembered per kind of network for a day); 'always' and 'off'
   * force it either way. Before 1.0.0 this was an on/off `preferIpv4`.
   */
  ipv4: Ipv4Mode;
  /** C3: when a list ends, keep playing similar songs. */
  autoplay: boolean;
  /** Look for a newer release by itself (daily at most; never for F-Droid installs). */
  checkUpdates: boolean;
}

export type Ipv4Mode = 'auto' | 'always' | 'off';
export const IPV4_MODES: readonly Ipv4Mode[] = ['auto', 'always', 'off'];

const DEFAULT_SETTINGS: Settings = { theme: 'dark', showNsfw: false, quality: 'high', checkEvery: 15, ipv4: 'auto', autoplay: true, checkUpdates: true };

/** The old Preferences key of Liked, migrated into its file. */
const LIKED_LEGACY_KEYS = ['liked'] as const;
/** Old Preferences keys of history, migrated into the history file: timed entries, then the untimed list. */
const HISTORY_LEGACY_KEYS = ['history', 'recent'] as const;
const K_SETTINGS = 'settings';
const K_FAV_GENRES = 'favGenres';
const K_FAV_ARTISTS = 'favArtists';

/** Theme ids that were renamed or replaced, mapped to their successor. */
const THEME_MIGRATIONS: Record<string, ThemeId> = { grid: 'brutalist' };

export const liked = signal<Track[]>([]);
/** Listening history, newest first (see ./history for the retention rules). */
export const history = signal<HistoryEntry[]>([]);
/** History as a plain track list, each track once. */
export const recent = computed<Track[]>(() => uniqueTracks(history.value));
export const settings = signal<Settings>({ ...DEFAULT_SETTINGS });
/** The NSFW setting alone: a theme change doesn't touch what depends on it (the catalog, the search index). */
export const showNsfw = computed(() => settings.value.showNsfw);
/** Favorite genres, in the order they were added. */
export const favoriteGenres = signal<string[]>([]);
/** Favorite artists (display names), in the order they were added. Matched by artistKey. */
export const favoriteArtists = signal<string[]>([]);

// Lookups for the stars and hearts: a component reads its own item through these (with
// useComputed), so a change re-renders only the stars whose state flipped.
/** Favorite genre names. */
export const favGenreSet = computed(() => new Set(favoriteGenres.value));
/** Favorite artists by artistKey. */
export const favArtistKeys = computed(() => new Set(favoriteArtists.value.map(artistKey)));
/** Liked track ids. */
export const likedIds = computed(() => new Set(liked.value.map((t) => t.id)));

let store: KV = kv;
let historyFile: JsonFile<unknown> = jsonFile('data', 'history', (raw) => raw, { legacyKeys: HISTORY_LEGACY_KEYS });
let likedFile: JsonFile<unknown> = jsonFile('data', 'liked', (raw) => raw, { legacyKeys: LIKED_LEGACY_KEYS });
/** Members-only likes and plays kept while signed out, per account (dropMembersOnly). */
const keptFile: JsonFile<unknown> = jsonFile('data', 'members-kept', (raw) => raw);

/** Tests: use other storage. */
export function setLibraryStorage(s: KV, history: JsonFile<unknown>, likes: JsonFile<unknown> = likedFile): void {
  store = s;
  historyFile = history;
  likedFile = likes;
}

function write(key: string, value: unknown): void {
  store.set(key, JSON.stringify(value)).catch(() => {});
}

/** loadLibrary ran: history may be written, and later loads replace the library outright. */
let loadedOnce = false;

/** Like saveHistory: not before the file was first read (that load replaces Liked anyway). */
function saveLiked(tracks: Track[]): void {
  if (loadedOnce) void likedFile.save(tracks);
}

function saveHistory(entries: HistoryEntry[]): void {
  // Before the file was first read, a write would replace the history in it: loadLibrary
  // merges what was played meanwhile and saves then.
  if (!loadedOnce) return;
  void historyFile.save(encodeHistory(entries));
}

export async function loadLibrary(): Promise<void> {
  const [l, h, s, g, a] = await Promise.all([
    likedFile.load().catch(() => null),
    historyFile.load().catch(() => null),
    readJson<Partial<Settings>>(store, K_SETTINGS, {}),
    readJson<unknown>(store, K_FAV_GENRES, []),
    readJson<unknown>(store, K_FAV_ARTISTS, []),
  ]);
  liked.value = asTracks(l);
  // A play recorded before the first read (the app reopened mid-song) is kept, not overwritten.
  const early = loadedOnce ? [] : history.value;
  loadedOnce = true;
  history.value = early.length ? mergeHistory(early, decodeHistory(h, Date.now()), Date.now()) : decodeHistory(h, Date.now());
  // Rewrites a migrated (old-shape) history in the current one, and keeps early plays; skipped when unchanged.
  if (h != null || early.length) saveHistory(history.value);
  // There but unreadable (not missing): what's played now is kept in memory, and the
  // file is read again later and merged, never replaced.
  if (historyFile.unreadable) retryHistory(0);
  favoriteGenres.value = Array.isArray(g)
    ? [...new Set(g.filter((x): x is string => typeof x === 'string' && x.trim() !== ''))]
    : [];
  const artists: string[] = [];
  const seenArtists = new Set<string>();
  for (const x of Array.isArray(a) ? a : []) {
    if (typeof x !== 'string') continue;
    const k = artistKey(x);
    if (!k || seenArtists.has(k)) continue;
    seenArtists.add(k);
    artists.push(x.trim());
  }
  favoriteArtists.value = artists;
  const stored = (s && typeof s === 'object' ? s : {}) as Partial<Settings> & { preferIpv4?: unknown };
  const { preferIpv4, ...rest } = stored;
  const merged = { ...DEFAULT_SETTINGS, ...rest };
  const migrated = THEME_MIGRATIONS[merged.theme as string];
  if (migrated) merged.theme = migrated;
  if (!THEMES.includes(merged.theme)) merged.theme = DEFAULT_SETTINGS.theme;
  if (merged.quality !== 'low') merged.quality = 'high';
  merged.showNsfw = merged.showNsfw === true;
  // The old on/off "Prefer IPv4": on is 'always'; off becomes the new default, 'auto'.
  if (!IPV4_MODES.includes(rest.ipv4 as Ipv4Mode)) merged.ipv4 = preferIpv4 === true ? 'always' : DEFAULT_SETTINGS.ipv4;
  merged.autoplay = merged.autoplay !== false;
  merged.checkUpdates = merged.checkUpdates !== false;
  if (!CHECK_EVERY_OPTIONS.includes(merged.checkEvery)) merged.checkEvery = DEFAULT_SETTINGS.checkEvery;
  settings.value = merged;
  if (migrated || preferIpv4 !== undefined) write(K_SETTINGS, merged);
}

/** Waits before each new attempt at reading a history file that couldn't be read. */
export const HISTORY_RETRY_MS = [5_000, 30_000, 120_000, 600_000];
let historyRetry: ReturnType<typeof setTimeout> | null = null;

function retryHistory(attempt: number): void {
  if (historyRetry) clearTimeout(historyRetry);
  historyRetry = null;
  if (attempt >= HISTORY_RETRY_MS.length) return;
  historyRetry = setTimeout(() => {
    historyRetry = null;
    void historyFile
      .load()
      .catch(() => null)
      .then((h) => {
        if (historyFile.unreadable) return retryHistory(attempt + 1);
        const now = Date.now();
        let merged = mergeHistory(history.value, decodeHistory(h, now), now);
        if (!auth.signedIn()) merged = merged.filter((e) => !e.track.membersOnly);
        history.value = merged;
        saveHistory(merged);
      });
  }, HISTORY_RETRY_MS[attempt]);
}

/** Both lists of plays, newest first; a track played twice on one day is listed once, at its newest play. */
function mergeHistory(a: HistoryEntry[], b: HistoryEntry[], now: number): HistoryEntry[] {
  const seen = new Set<string>();
  const merged = [...a, ...b]
    .sort((x, y) => y.playedAt - x.playedAt)
    .filter((e) => {
      const k = e.track.id + '|' + dayKey(e.playedAt);
      return seen.has(k) ? false : (seen.add(k), true);
    });
  return pruneHistory(merged, now);
}

export function isFavoriteGenre(name: string): boolean {
  return favGenreSet.value.has(name);
}

/** Toggle a favorite genre; returns the new state. New favorites go last. */
export function toggleFavoriteGenre(name: string): boolean {
  const was = isFavoriteGenre(name);
  favoriteGenres.value = was ? favoriteGenres.value.filter((x) => x !== name) : [...favoriteGenres.value, name];
  write(K_FAV_GENRES, favoriteGenres.value);
  return !was;
}

/**
 * Where an item sat in a list before it was removed, so Undo can put it back there:
 * before the item that followed it (`next`), else after the one before it (`prev`),
 * else at `index`. Neighbours are matched by key, so other changes meanwhile (another
 * removal, a new like on top) don't shift it.
 */
export interface Removed<T> {
  item: T;
  index: number;
  next?: string;
  prev?: string;
}

function removedFrom<T>(list: T[], index: number, key: (x: T) => string): Removed<T> {
  const r: Removed<T> = { item: list[index], index };
  if (index + 1 < list.length) r.next = key(list[index + 1]);
  if (index > 0) r.prev = key(list[index - 1]);
  return r;
}

function putBack<T>(list: T[], r: Removed<T>, key: (x: T) => string): T[] {
  let i = r.next != null ? list.findIndex((x) => key(x) === r.next) : -1;
  if (i < 0 && r.prev != null) {
    const p = list.findIndex((x) => key(x) === r.prev);
    if (p >= 0) i = p + 1;
  }
  if (i < 0) i = Math.max(0, Math.min(r.index, list.length));
  return [...list.slice(0, i), r.item, ...list.slice(i)];
}

const sameText = (x: string) => x;
const trackId = (t: Track) => t.id;

/** Remove a favorite genre; returns what Undo needs (null if it wasn't one). */
export function removeFavoriteGenre(name: string): Removed<string> | null {
  const index = favoriteGenres.value.indexOf(name);
  if (index < 0) return null;
  const r = removedFrom(favoriteGenres.value, index, sameText);
  toggleFavoriteGenre(name);
  return r;
}

/** Undo: put a removed favorite genre back where it was. */
export function restoreFavoriteGenre(r: Removed<string>): void {
  if (isFavoriteGenre(r.item)) return;
  favoriteGenres.value = putBack(favoriteGenres.value, r, sameText);
  write(K_FAV_GENRES, favoriteGenres.value);
}

export function isFavoriteArtist(name: string): boolean {
  const k = artistKey(name);
  return !!k && favArtistKeys.value.has(k);
}

/** Toggle a favorite artist; returns the new state. New favorites go last. */
export function toggleFavoriteArtist(name: string): boolean {
  const k = artistKey(name);
  if (!k) return false;
  const was = isFavoriteArtist(name);
  favoriteArtists.value = was ? favoriteArtists.value.filter((x) => artistKey(x) !== k) : [...favoriteArtists.value, name.trim()];
  write(K_FAV_ARTISTS, favoriteArtists.value);
  return !was;
}

/** Remove a favorite artist; returns what Undo needs (null if they weren't one). */
export function removeFavoriteArtist(name: string): Removed<string> | null {
  const k = artistKey(name);
  const index = k ? favoriteArtists.value.findIndex((x) => artistKey(x) === k) : -1;
  if (index < 0) return null;
  const r = removedFrom(favoriteArtists.value, index, artistKey);
  toggleFavoriteArtist(name);
  return r;
}

/** Undo: put a removed favorite artist back where they were. */
export function restoreFavoriteArtist(r: Removed<string>): void {
  if (isFavoriteArtist(r.item)) return;
  favoriteArtists.value = putBack(favoriteArtists.value, r, artistKey);
  write(K_FAV_ARTISTS, favoriteArtists.value);
}

export function isLiked(id: string): boolean {
  return likedIds.value.has(id);
}

/** Toggle like; returns the new liked state. */
export function toggleLike(track: Track): boolean {
  const was = isLiked(track.id);
  liked.value = was ? liked.value.filter((t) => t.id !== track.id) : [track, ...liked.value];
  saveLiked(liked.value);
  return !was;
}

/** Unlike; returns what Undo needs (null if it wasn't liked). */
export function unlike(id: string): Removed<Track> | null {
  const index = liked.value.findIndex((t) => t.id === id);
  if (index < 0) return null;
  const r = removedFrom(liked.value, index, trackId);
  liked.value = liked.value.filter((t) => t.id !== id);
  saveLiked(liked.value);
  return r;
}

/** Undo an unlike: the track goes back where it was in Liked (not a members-only one after signing out). */
export function restoreLike(r: Removed<Track>): void {
  if (isLiked(r.item.id) || (r.item.membersOnly && !auth.signedIn())) return;
  liked.value = putBack(liked.value, r, trackId);
  saveLiked(liked.value);
}

export function addRecent(track: Track, now = Date.now()): void {
  const next = addPlay(history.value, track, now);
  if (next === history.value) return;
  history.value = next;
  saveHistory(next);
}

/** Clear history; returns the entries that were there (for Undo). */
export function clearRecent(): HistoryEntry[] {
  const old = history.value;
  history.value = [];
  saveHistory([]);
  return old;
}

/**
 * Undo a clear: the old entries come back, merged with anything played since (a
 * track played again today is listed once, at its newest play).
 */
export function restoreHistory(old: HistoryEntry[], now = Date.now()): void {
  // Signed out since: members-only plays don't come back (S8).
  if (!auth.signedIn()) old = old.filter((e) => !e.track.membersOnly);
  if (!old.length) return;
  history.value = mergeHistory(history.value, old, now);
  saveHistory(history.value);
}

/** One account's members-only records put away at a sign-out: likes with where each one was, and plays. */
interface KeptAccount {
  liked: Removed<Track>[];
  plays: HistoryEntry[];
}

function asRemovedTracks(x: unknown): Removed<Track>[] {
  const out: Removed<Track>[] = [];
  for (const r of Array.isArray(x) ? (x as Partial<Removed<unknown>>[]) : []) {
    const item = asTrack(r?.item);
    if (!item || typeof r.index !== 'number') continue;
    out.push({ item, index: r.index, ...(typeof r.next === 'string' && { next: r.next }), ...(typeof r.prev === 'string' && { prev: r.prev }) });
  }
  return out;
}

/** The kept file by account uid; anything unreadable reads as nothing kept. */
function asKept(raw: unknown, now: number): Map<string, KeptAccount> {
  const out = new Map<string, KeptAccount>();
  const o = raw as { v?: unknown; accounts?: unknown } | null;
  if (!o || o.v !== 1 || !o.accounts || typeof o.accounts !== 'object') return out;
  for (const [uid, a] of Object.entries(o.accounts as Record<string, { liked?: unknown; plays?: unknown } | null>)) {
    const entry = { liked: asRemovedTracks(a?.liked), plays: withinHistoryDays(decodeHistory(a?.plays, now), now) };
    if (entry.liked.length || entry.plays.length) out.set(uid, entry);
  }
  return out;
}

async function loadKept(now: number): Promise<Map<string, KeptAccount>> {
  return asKept(await keptFile.load().catch(() => null), now);
}

/** Writes what is kept; plays past the history's days go (no account keeps them longer). */
async function saveKept(kept: Map<string, KeptAccount>, now: number): Promise<void> {
  const accounts: Record<string, { liked: Removed<Track>[]; plays: unknown }> = {};
  for (const [uid, a] of kept) {
    const plays = withinHistoryDays(a.plays, now);
    if (a.liked.length || plays.length) accounts[uid] = { liked: a.liked, plays: encodeHistory(plays) };
  }
  if (Object.keys(accounts).length) await keptFile.save({ v: 1, accounts });
  else await keptFile.remove();
}

/** The kept file's reads and writes, one at a time, in call order. */
let keptJob: Promise<void> = Promise.resolve();
const queueKept = (job: () => Promise<void>): Promise<void> => (keptJob = keptJob.then(job, job));

/**
 * Signed out of Cyberspace: members-only tracks leave Liked and history (they can't be
 * opened signed out). [uid], the account just signed out: its members-only likes and plays
 * are kept on the phone for it, apart from every other account's (in a file outside
 * backups, like Liked and history), and come back when it signs in again
 * (returnMembersOnly). Unknown (null), they go for good.
 */
export function dropMembersOnly(uid: string | null = null): void {
  const all = liked.value;
  const likes = uid ? all.flatMap((t, i) => (t.membersOnly ? [removedFrom(all, i, trackId)] : [])) : [];
  const plays = uid ? history.value.filter((e) => e.track.membersOnly) : [];
  if (all.some((t) => t.membersOnly)) {
    liked.value = all.filter((t) => !t.membersOnly);
    saveLiked(liked.value);
  }
  if (history.value.some((e) => e.track.membersOnly)) {
    history.value = history.value.filter((e) => !e.track.membersOnly);
    saveHistory(history.value);
  }
  if (!uid || (!likes.length && !plays.length)) return;
  void queueKept(async () => {
    const now = Date.now();
    const kept = await loadKept(now);
    // Signed out twice without signing in again in between: both sign-outs' records are kept.
    const before = kept.get(uid);
    kept.set(uid, {
      liked: [...likes, ...(before?.liked ?? []).filter((r) => !likes.some((x) => x.item.id === r.item.id))],
      plays: mergeHistory(plays, before?.plays ?? [], now),
    });
    await saveKept(kept, now);
  });
}

/**
 * Signed in as [uid]: its members-only likes from before its last sign-out go back where
 * they were, and its plays back into history (those still within its days). Every other
 * account's stay kept for it.
 */
export function returnMembersOnly(uid: string): Promise<void> {
  return queueKept(async () => {
    const now = Date.now();
    const kept = await loadKept(now);
    const mine = kept.get(uid);
    if (!mine) return;
    kept.delete(uid);
    await saveKept(kept, now);
    let list = liked.value;
    // In their old order: each finds the neighbour it had, or the one put back before it.
    for (const r of mine.liked) if (!list.some((t) => t.id === r.item.id)) list = putBack(list, r, trackId);
    if (list !== liked.value) {
      liked.value = list;
      saveLiked(list);
    }
    if (mine.plays.length) {
      history.value = mergeHistory(history.value, mine.plays, now);
      saveHistory(history.value);
    }
  });
}

export function updateSettings(patch: Partial<Settings>): void {
  settings.value = { ...settings.value, ...patch };
  write(K_SETTINGS, settings.value);
}

/** Look up a track we know about locally (used to resolve ids from native state). */
export function knownTrack(id: string): Track | undefined {
  return liked.value.find((t) => t.id === id) ?? recent.value.find((t) => t.id === id);
}
