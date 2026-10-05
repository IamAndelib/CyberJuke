/**
 * User library: liked tracks, recently played, and settings.
 * Persisted with @capacitor/preferences (localStorage on the web).
 */
import { signal } from '@preact/signals';
import { Preferences } from '@capacitor/preferences';
import type { Track } from '../data/model';

export const THEMES = ['dark', 'light', 'c64', 'vt320', 'matrix', 'crypt', 'bubblegum', 'grid'] as const;
export type ThemeId = (typeof THEMES)[number];
export const THEME_LABELS: Record<ThemeId, string> = {
  dark: 'Dark',
  light: 'Light',
  c64: 'C64',
  vt320: 'VT320',
  matrix: 'Matrix',
  crypt: 'Crypt',
  bubblegum: 'Bubblegum',
  grid: 'GRiD',
};

export type Quality = 'high' | 'low';

export interface Settings {
  theme: ThemeId;
  showNsfw: boolean;
  quality: Quality;
}

export const DEFAULT_SETTINGS: Settings = { theme: 'dark', showNsfw: false, quality: 'high' };
export const RECENT_MAX = 100;

const K_LIKED = 'liked';
const K_RECENT = 'recent';
const K_SETTINGS = 'settings';

export const liked = signal<Track[]>([]);
export const recent = signal<Track[]>([]);
export const settings = signal<Settings>({ ...DEFAULT_SETTINGS });

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
  const [l, r, s] = await Promise.all([
    read<unknown[]>(K_LIKED, []),
    read<unknown[]>(K_RECENT, []),
    read<Partial<Settings>>(K_SETTINGS, {}),
  ]);
  liked.value = Array.isArray(l) ? l.filter(isTrack) : [];
  recent.value = Array.isArray(r) ? r.filter(isTrack).slice(0, RECENT_MAX) : [];
  const merged = { ...DEFAULT_SETTINGS, ...(s && typeof s === 'object' ? s : {}) };
  if (!THEMES.includes(merged.theme)) merged.theme = DEFAULT_SETTINGS.theme;
  if (merged.quality !== 'low') merged.quality = 'high';
  merged.showNsfw = merged.showNsfw === true;
  settings.value = merged;
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

export function addRecent(track: Track): void {
  if (recent.value[0]?.id === track.id) return;
  recent.value = [track, ...recent.value.filter((t) => t.id !== track.id)].slice(0, RECENT_MAX);
  write(K_RECENT, recent.value);
}

export function clearRecent(): void {
  recent.value = [];
  write(K_RECENT, []);
}

export function updateSettings(patch: Partial<Settings>): void {
  settings.value = { ...settings.value, ...patch };
  write(K_SETTINGS, settings.value);
}

/** Look up a track we know about locally (used to resolve ids from native state). */
export function knownTrack(id: string): Track | undefined {
  return liked.value.find((t) => t.id === id) ?? recent.value.find((t) => t.id === id);
}
