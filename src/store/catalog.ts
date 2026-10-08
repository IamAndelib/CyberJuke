/**
 * The whole Jukebox, kept on the phone so it can be searched and ranked locally.
 *
 * Refresh rules (courtesy: someone else's database):
 *  - first launch (nothing cached): one full fetch;
 *  - cache older than 1 hour: fetch only posts newer than the newest cached one, merge;
 *  - cache older than 24 hours: full refetch (fresh save counts, drops deleted posts);
 *  - at most one fetch at a time; no polling (refreshes are triggered by app start,
 *    app resume, coming back online, or a pull-to-refresh).
 * The cache holds NSFW tracks too; `tracks` applies the setting so toggling it is instant.
 */
import { computed, signal, type ReadonlySignal } from '@preact/signals';
import { Preferences } from '@capacitor/preferences';
import type { Track } from '../data/model';
import type { TrackSource } from '../data/source';
import { source } from '../data';
import { settings } from './library';

export const CATALOG_KEY = 'catalog.v1';
export const INCREMENTAL_AFTER_MS = 60 * 60 * 1000;
export const FULL_AFTER_MS = 24 * 60 * 60 * 1000;

export type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface CatalogStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface CatalogDeps {
  source: Pick<TrackSource, 'catalog'>;
  storage: CatalogStorage;
  showNsfw: () => boolean;
  now?: () => number;
}

interface Persisted {
  v: 1;
  /** When the last full fetch finished. */
  fullAt: number;
  /** When the last fetch of any kind finished. */
  checkedAt: number;
  tracks: Track[];
}

export interface Catalog {
  /** Every known track, newest first, with the NSFW setting applied. */
  tracks: ReadonlySignal<Track[]>;
  /** Total tracks including NSFW ones (for diagnostics/tests). */
  all: ReadonlySignal<Track[]>;
  status: ReadonlySignal<CatalogStatus>;
  error: ReadonlySignal<{ message: string; offline: boolean } | null>;
  /**
   * Bring the catalog up to date following the refresh rules. `force` skips the
   * 1-hour wait (pull-to-refresh) but still prefers an incremental fetch.
   * Never rejects; failures land in `error`/`status`.
   */
  refresh(opts?: { force?: boolean }): Promise<void>;
}

function byNewest(a: Track, b: Track): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Merge `incoming` into `existing` by id (incoming wins), newest first. */
export function mergeTracks(existing: Track[], incoming: Track[]): Track[] {
  const map = new Map<string, Track>();
  for (const t of existing) map.set(t.id, t);
  for (const t of incoming) map.set(t.id, t);
  return [...map.values()].sort(byNewest);
}

function isTrack(t: unknown): t is Track {
  const x = t as Track;
  return !!x && typeof x.id === 'string' && typeof x.ytId === 'string' && typeof x.createdAt === 'string' && typeof x.title === 'string';
}

function parsePersisted(raw: string | null): Persisted | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<Persisted>;
    if (!p || p.v !== 1 || !Array.isArray(p.tracks)) return null;
    return {
      v: 1,
      fullAt: Number(p.fullAt) || 0,
      checkedAt: Number(p.checkedAt) || 0,
      tracks: p.tracks.filter(isTrack),
    };
  } catch {
    return null;
  }
}

export function createCatalog(deps: CatalogDeps): Catalog {
  const now = deps.now ?? (() => Date.now());
  const all = signal<Track[]>([]);
  const status = signal<CatalogStatus>('idle');
  const error = signal<{ message: string; offline: boolean } | null>(null);
  const tracks = computed(() => (deps.showNsfw() ? all.value : all.value.filter((t) => !t.nsfw)));
  let fullAt = 0;
  let checkedAt = 0;
  let restored: Promise<void> | null = null;
  let inflight: Promise<void> | null = null;

  function restore(): Promise<void> {
    restored ??= deps.storage
      .get(CATALOG_KEY)
      .catch(() => null)
      .then((raw) => {
        const p = parsePersisted(raw);
        if (!p || !p.tracks.length || all.value.length) return;
        all.value = p.tracks.slice().sort(byNewest);
        fullAt = p.fullAt;
        checkedAt = p.checkedAt;
        status.value = 'ready';
      });
    return restored;
  }

  function persist(): void {
    const p: Persisted = { v: 1, fullAt, checkedAt, tracks: all.value };
    deps.storage.set(CATALOG_KEY, JSON.stringify(p)).catch(() => {});
  }

  async function run(force: boolean): Promise<void> {
    await restore();
    const have = all.value.length > 0;
    const age = now() - fullAt;
    const mode = !have || age >= FULL_AFTER_MS ? 'full' : force || now() - checkedAt >= INCREMENTAL_AFTER_MS ? 'incremental' : null;
    if (!mode) return;
    try {
      if (mode === 'full') {
        all.value = mergeTracks([], await deps.source.catalog());
        fullAt = checkedAt = now();
      } else {
        const since = new Date(all.value[0].createdAt);
        const fresh = await deps.source.catalog(isNaN(since.getTime()) ? undefined : since);
        if (fresh.length) all.value = mergeTracks(all.value, fresh);
        checkedAt = now();
      }
      error.value = null;
      status.value = 'ready';
      persist();
    } catch (e) {
      error.value = {
        message: e instanceof Error ? e.message : String(e),
        offline: !!(e as { offline?: boolean })?.offline,
      };
      // With a cache we keep showing it; only an empty catalog is an error state.
      status.value = all.value.length ? 'ready' : 'error';
    }
  }

  return {
    tracks,
    all,
    status,
    error,
    refresh(opts = {}) {
      if (inflight) return inflight;
      if (!all.value.length) status.value = 'loading';
      inflight = run(!!opts.force).finally(() => (inflight = null));
      return inflight;
    },
  };
}

// ---- Ranking helpers -----------------------------------------------------------------

export type SavedRange = 'month' | 'all';
export const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * "Most saved": tracks with at least one save, optionally in one genre and within
 * the last 30 days, by saves, then replies, then newest.
 */
export function mostSaved(tracks: Track[], opts: { genre?: string | null; range: SavedRange; now?: number }): Track[] {
  const cutoff = opts.range === 'month' ? new Date((opts.now ?? Date.now()) - MONTH_MS).toISOString() : '';
  return tracks
    .filter((t) => (t.saves ?? 0) > 0 && (opts.genre == null || t.genre === opts.genre) && (!cutoff || t.createdAt >= cutoff))
    .sort((a, b) => (b.saves ?? 0) - (a.saves ?? 0) || (b.replies ?? 0) - (a.replies ?? 0) || byNewest(a, b));
}

/** Genres in `tracks`, most-used first (ties alphabetical). */
export function genreCounts(tracks: Track[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const t of tracks) if (t.genre) counts.set(t.genre, (counts.get(t.genre) ?? 0) + 1);
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// ---- App instance --------------------------------------------------------------------

const prefsStorage: CatalogStorage = {
  get: async (key) => (await Preferences.get({ key })).value,
  set: async (key, value) => {
    await Preferences.set({ key, value });
  },
};

/** The app's catalog. */
export const catalog = createCatalog({ source, storage: prefsStorage, showNsfw: () => settings.value.showNsfw });
