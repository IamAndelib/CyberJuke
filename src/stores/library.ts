/**
 * User library: liked tracks, recently played, favorite genres and settings.
 * Small keys live in Preferences (localStorage on the web); history is a file,
 * `cyberjuke/history.json` (see core/storage), migrated once from Preferences.
 */
import { computed, signal } from '@preact/signals';
import type { Track } from '../data/model';
import { artistKey } from '../data/artists';
import { asTracks } from '../core/guards';
import { jsonFile, kv, readJson, type JsonFile, type KV } from '../core/storage';
import { addPlay, dayKey, decodeHistory, encodeHistory, pruneHistory, uniqueTracks, type HistoryEntry } from './history';

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
export type CheckEvery = 5 | 15 | 30 | 60 | 0;
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
  /** Y6: resolve YouTube hosts to IPv4 only (can help when a network's IPv6 is blocked). */
  preferIpv4: boolean;
  /** C3: when a list ends, keep playing similar songs. */
  autoplay: boolean;
}

export const DEFAULT_SETTINGS: Settings = { theme: 'dark', showNsfw: false, quality: 'high', checkEvery: 15, preferIpv4: false, autoplay: true };

const K_LIKED = 'liked';
/** Old Preferences keys of history, migrated into the history file: timed entries, then the untimed list. */
export const HISTORY_LEGACY_KEYS = ['history', 'recent'] as const;
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

let store: KV = kv;
let historyFile: JsonFile<unknown> = jsonFile('data', 'history', (raw) => raw, { legacyKeys: HISTORY_LEGACY_KEYS });

/** Tests: use other storage. */
export function setLibraryStorage(s: KV, history: JsonFile<unknown>): void {
  store = s;
  historyFile = history;
}

function write(key: string, value: unknown): void {
  store.set(key, JSON.stringify(value)).catch(() => {});
}

function saveHistory(entries: HistoryEntry[]): void {
  void historyFile.save(encodeHistory(entries));
}

export async function loadLibrary(): Promise<void> {
  const [l, h, s, g, a] = await Promise.all([
    readJson<unknown>(store, K_LIKED, []),
    historyFile.load().catch(() => null),
    readJson<Partial<Settings>>(store, K_SETTINGS, {}),
    readJson<unknown>(store, K_FAV_GENRES, []),
    readJson<unknown>(store, K_FAV_ARTISTS, []),
  ]);
  liked.value = asTracks(l);
  history.value = decodeHistory(h, Date.now());
  // Rewrites a migrated (old-shape) history in the current one; skipped when unchanged.
  if (h != null) saveHistory(history.value);
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
  const merged = { ...DEFAULT_SETTINGS, ...(s && typeof s === 'object' ? s : {}) };
  const migrated = THEME_MIGRATIONS[merged.theme as string];
  if (migrated) merged.theme = migrated;
  if (!THEMES.includes(merged.theme)) merged.theme = DEFAULT_SETTINGS.theme;
  if (merged.quality !== 'low') merged.quality = 'high';
  merged.showNsfw = merged.showNsfw === true;
  merged.preferIpv4 = merged.preferIpv4 === true;
  merged.autoplay = merged.autoplay !== false;
  if (!CHECK_EVERY_OPTIONS.includes(merged.checkEvery)) merged.checkEvery = DEFAULT_SETTINGS.checkEvery;
  settings.value = merged;
  if (migrated) write(K_SETTINGS, merged);
}

export function isFavoriteGenre(name: string): boolean {
  return favoriteGenres.value.includes(name);
}

/** Toggle a favorite genre; returns the new state. New favorites go last. */
export function toggleFavoriteGenre(name: string): boolean {
  const was = isFavoriteGenre(name);
  favoriteGenres.value = was ? favoriteGenres.value.filter((x) => x !== name) : [...favoriteGenres.value, name];
  write(K_FAV_GENRES, favoriteGenres.value);
  return !was;
}

/** Where an item sat in a list before it was removed, so Undo can put it back there. */
export interface Removed<T> {
  item: T;
  index: number;
}

function insertAt<T>(list: T[], item: T, index: number): T[] {
  const i = Math.max(0, Math.min(index, list.length));
  return [...list.slice(0, i), item, ...list.slice(i)];
}

/** Remove a favorite genre; returns what Undo needs (null if it wasn't one). */
export function removeFavoriteGenre(name: string): Removed<string> | null {
  const index = favoriteGenres.value.indexOf(name);
  if (index < 0) return null;
  toggleFavoriteGenre(name);
  return { item: name, index };
}

/** Undo: put a removed favorite genre back where it was. */
export function restoreFavoriteGenre(r: Removed<string>): void {
  if (isFavoriteGenre(r.item)) return;
  favoriteGenres.value = insertAt(favoriteGenres.value, r.item, r.index);
  write(K_FAV_GENRES, favoriteGenres.value);
}

export function isFavoriteArtist(name: string): boolean {
  const k = artistKey(name);
  return !!k && favoriteArtists.value.some((x) => artistKey(x) === k);
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
  const item = favoriteArtists.value[index];
  toggleFavoriteArtist(name);
  return { item, index };
}

/** Undo: put a removed favorite artist back where they were. */
export function restoreFavoriteArtist(r: Removed<string>): void {
  if (isFavoriteArtist(r.item)) return;
  favoriteArtists.value = insertAt(favoriteArtists.value, r.item, r.index);
  write(K_FAV_ARTISTS, favoriteArtists.value);
}

export function isLiked(id: string): boolean {
  return liked.value.some((t) => t.id === id);
}

/** Toggle like; returns the new liked state. */
export function toggleLike(track: Track): boolean {
  const was = isLiked(track.id);
  liked.value = was ? liked.value.filter((t) => t.id !== track.id) : [track, ...liked.value];
  write(K_LIKED, liked.value);
  return !was;
}

/** Unlike; returns what Undo needs (null if it wasn't liked). */
export function unlike(id: string): Removed<Track> | null {
  const index = liked.value.findIndex((t) => t.id === id);
  if (index < 0) return null;
  const item = liked.value[index];
  liked.value = liked.value.filter((t) => t.id !== id);
  write(K_LIKED, liked.value);
  return { item, index };
}

/** Undo an unlike: the track goes back where it was in Liked. */
export function restoreLike(r: Removed<Track>): void {
  if (isLiked(r.item.id)) return;
  liked.value = insertAt(liked.value, r.item, r.index);
  write(K_LIKED, liked.value);
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
  if (!old.length) return;
  const seen = new Set<string>();
  const merged = [...history.value, ...old]
    .sort((a, b) => b.playedAt - a.playedAt)
    .filter((e) => {
      const k = e.track.id + '|' + dayKey(e.playedAt);
      return seen.has(k) ? false : (seen.add(k), true);
    });
  history.value = pruneHistory(merged, now);
  saveHistory(history.value);
}

/**
 * Signed out of Cyberspace: members-only tracks leave Liked and history (they can't
 * be opened signed out, and shouldn't stay on the phone).
 */
export function dropMembersOnly(): void {
  if (liked.value.some((t) => t.membersOnly)) {
    liked.value = liked.value.filter((t) => !t.membersOnly);
    write(K_LIKED, liked.value);
  }
  if (history.value.some((e) => e.track.membersOnly)) {
    history.value = history.value.filter((e) => !e.track.membersOnly);
    saveHistory(history.value);
  }
}

export function updateSettings(patch: Partial<Settings>): void {
  settings.value = { ...settings.value, ...patch };
  write(K_SETTINGS, settings.value);
}

/** Look up a track we know about locally (used to resolve ids from native state). */
export function knownTrack(id: string): Track | undefined {
  return liked.value.find((t) => t.id === id) ?? recent.value.find((t) => t.id === id);
}
