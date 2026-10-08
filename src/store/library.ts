/**
 * User library: liked tracks, recently played, favorite genres and settings.
 * Persisted with @capacitor/preferences (localStorage on the web).
 */
import { computed, signal } from '@preact/signals';
import { Preferences } from '@capacitor/preferences';
import type { Track } from '../data/model';
import { artistKey } from '../data/artists';
import { addPlay, migrateHistory, uniqueTracks, type HistoryEntry } from './history';

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
}

export const DEFAULT_SETTINGS: Settings = { theme: 'dark', showNsfw: false, quality: 'high', checkEvery: 15 };

const K_LIKED = 'liked';
/** Old untimed history (Track[]); read once and migrated to K_HISTORY. */
const K_RECENT = 'recent';
const K_HISTORY = 'history';
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
/** Favorite genres, in the order they were added. */
export const favoriteGenres = signal<string[]>([]);
/** Favorite artists (display names), in the order they were added. Matched by artistKey. */
export const favoriteArtists = signal<string[]>([]);

async function read<T>(key: string, fallback: T): Promise<T> {
  try {
    const { value } = await Preferences.get({ key });
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  Preferences.set({ key, value: JSON.stringify(value) }).catch(() => {});
}

function isTrack(t: unknown): t is Track {
  return !!t && typeof (t as Track).id === 'string' && typeof (t as Track).ytId === 'string';
}

export async function loadLibrary(): Promise<void> {
  const [l, h, s, g, a] = await Promise.all([
    read<unknown[]>(K_LIKED, []),
    read<unknown[] | null>(K_HISTORY, null),
    read<Partial<Settings>>(K_SETTINGS, {}),
    read<unknown[]>(K_FAV_GENRES, []),
    read<unknown[]>(K_FAV_ARTISTS, []),
  ]);
  liked.value = Array.isArray(l) ? l.filter(isTrack) : [];
  if (h == null) {
    // First run with timed history: migrate the old list, keeping every entry.
    history.value = migrateHistory(await read<unknown[]>(K_RECENT, []), Date.now());
    if (history.value.length) write(K_HISTORY, history.value);
    try {
      Preferences.remove({ key: K_RECENT }).catch(() => {});
    } catch {
      /* ignore */
    }
  } else {
    history.value = migrateHistory(h, Date.now());
  }
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

export function addRecent(track: Track, now = Date.now()): void {
  const next = addPlay(history.value, track, now);
  if (next === history.value) return;
  history.value = next;
  write(K_HISTORY, next);
}

export function clearRecent(): void {
  history.value = [];
  write(K_HISTORY, []);
}

export function updateSettings(patch: Partial<Settings>): void {
  settings.value = { ...settings.value, ...patch };
  write(K_SETTINGS, settings.value);
}

/** Look up a track we know about locally (used to resolve ids from native state). */
export function knownTrack(id: string): Track | undefined {
  return liked.value.find((t) => t.id === id) ?? recent.value.find((t) => t.id === id);
}
