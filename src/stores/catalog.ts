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
 *
 * Signed in with Cyberspace the catalog also holds members-only posts, so it is kept
 * under its own key (CATALOG_MEMBERS_KEY). Signing in or out calls `reset`: both
 * saved catalogs are dropped and the next refresh is a full one. Until it lands, the
 * catalog shown stays, less its members-only posts, so the chips, Most saved and search
 * don't empty out or jump about meanwhile.
 *
 * Saved as two parts: the tracks under the key (in the app, the files
 * cyberjuke/catalog-public.json and cyberjuke/catalog-members.json, migrated once
 * from the Preferences keys of the same name) and the fetch times under `<key>.meta`
 * (a small Preferences key). The tracks are written only when they changed, so an
 * hourly check that finds nothing new writes a few bytes, not the whole catalog.
 *
 * The meta also holds the catalog's format (CATALOG_FORMAT). A catalog saved by an older
 * format lacks posts the app now shows (1.2.0's has no MP3 posts) that an incremental
 * fetch would never bring, being older than its newest post: it gets one full refetch.
 */
import { computed, signal, type ReadonlySignal } from '@preact/signals';
import type { Track } from '../data/model';
import type { GenreCount } from '../data/search';
import type { TrackSource } from '../data/source';
import { source } from '../data';
import { auth } from '../data/auth';
import { toLoadError, type LoadError } from '../core/errors';
import { online } from '../core/network';
import { isObj, isTrackFull } from '../core/guards';
import { kv, textFile, type TextFile } from '../core/storage';
import { showNsfw } from './library';

export const CATALOG_KEY = 'catalog.v1';
/** The signed-in catalog (members-only posts included). */
export const CATALOG_MEMBERS_KEY = 'catalog.v1.members';
/** Storage key for the catalog of one sign-in state. */
export function catalogKey(signedIn: boolean): string {
  return signedIn ? CATALOG_MEMBERS_KEY : CATALOG_KEY;
}
/** Where a catalog's fetch times are kept. */
function metaKey(key: string): string {
  return key + '.meta';
}
/**
 * What a saved catalog holds; a lower (or missing) one is refetched in full. 2: Jukebox MP3
 * posts are in it.
 */
export const CATALOG_FORMAT = 2;
export const INCREMENTAL_AFTER_MS = 60 * 60 * 1000;
export const FULL_AFTER_MS = 24 * 60 * 60 * 1000;

type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

interface CatalogStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove?(key: string): Promise<void>;
}

interface CatalogDeps {
  source: Pick<TrackSource, 'catalog'>;
  storage: CatalogStorage;
  showNsfw: () => boolean;
  now?: () => number;
  /** Storage key, read on every restore/save (per sign-in state). Default CATALOG_KEY. */
  storageKey?: () => string;
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
  error: ReadonlySignal<LoadError | null>;
  /**
   * Bring the catalog up to date following the refresh rules. `force` skips the
   * 1-hour wait (pull-to-refresh) but still prefers an incremental fetch.
   * Never rejects; failures land in `error`/`status`.
   */
  refresh(opts?: { force?: boolean }): Promise<void>;
  /**
   * Show the saved catalog, if there is one, without any request (refresh() reads it
   * too, first). Never rejects.
   */
  restoreSaved(): Promise<void>;
  /**
   * Sign-in state changed: drop both saved catalogs and the members-only posts, drop the
   * result of any fetch still running, and do a full refresh (the rest shows meanwhile).
   */
  reset(): Promise<void>;
  /** Settles once the catalog is the current sign-in state's: at once, but while reset's refresh runs. */
  settled(): Promise<void>;
}

/** A track's post and its place in it (`<post>-<n>` for a post with several songs, data/model). */
const postOf = (id: string): [string, number] => {
  const m = /^(.+)-(\d+)$/.exec(id);
  return m ? [m[1], Number(m[2])] : [id, 0];
};

/** Newest first; at the same moment the later post first, and a post's songs in its own order, as Cyberspace lists them. */
function byNewest(a: Track, b: Track): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  const [pa, na] = postOf(a.id);
  const [pb, nb] = postOf(b.id);
  return pa !== pb ? (pa < pb ? 1 : -1) : na - nb;
}

/** Merge `incoming` into `existing` by id (incoming wins), newest first. */
export function mergeById(existing: Track[], incoming: Track[]): Track[] {
  const map = new Map<string, Track>();
  for (const t of existing) map.set(t.id, t);
  for (const t of incoming) map.set(t.id, t);
  return [...map.values()].sort(byNewest);
}

/** The saved tracks (`{ v: 1, tracks }`; older saves also carry the times). */
function parsePersisted(raw: string | null, meta: string | null): Persisted | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as unknown;
    if (!isObj(p) || p.v !== 1 || !Array.isArray(p.tracks)) return null;
    let m: Record<string, unknown> = p;
    try {
      const parsed = meta ? (JSON.parse(meta) as unknown) : null;
      if (isObj(parsed)) m = parsed;
    } catch {
      /* no times: treated as stale */
    }
    const current = (Number(m.fmt) || 0) >= CATALOG_FORMAT;
    return {
      v: 1,
      // An older format's full fetch doesn't count: the next refresh is a full one.
      fullAt: current ? Number(m.fullAt) || 0 : 0,
      checkedAt: Number(m.checkedAt) || 0,
      tracks: p.tracks.filter(isTrackFull),
    };
  } catch {
    return null;
  }
}

export function createCatalog(deps: CatalogDeps): Catalog {
  const now = deps.now ?? (() => Date.now());
  const all = signal<Track[]>([]);
  const status = signal<CatalogStatus>('idle');
  const error = signal<LoadError | null>(null);
  const tracks = computed(() => (deps.showNsfw() ? all.value : all.value.filter((t) => !t.nsfw)));
  let fullAt = 0;
  let checkedAt = 0;
  let restored: Promise<void> | null = null;
  let inflight: Promise<void> | null = null;
  /** Bumped by reset(): a fetch from before it is thrown away. */
  let gen = 0;
  /** The last reset's removals and full refresh (settled). */
  let switching: Promise<void> = Promise.resolve();
  const key = deps.storageKey ?? (() => CATALOG_KEY);

  /** The track list last saved (or restored): unchanged lists aren't written again. */
  let saved: Track[] | null = null;

  function restore(k: string): Promise<void> {
    const g = gen;
    const get = (x: string) => deps.storage.get(x).catch(() => null);
    restored ??= Promise.all([get(k), get(metaKey(k))]).then(([raw, meta]) => {
      const p = parsePersisted(raw, meta);
      if (g !== gen || !p || !p.tracks.length || all.value.length) return;
      all.value = p.tracks.slice().sort(byNewest);
      saved = all.value;
      fullAt = p.fullAt;
      checkedAt = p.checkedAt;
      status.value = 'ready';
    });
    return restored;
  }

  /** Save under `k`: the key of the sign-in state the fetch was made in. */
  function persist(k: string): void {
    if (saved !== all.value) {
      saved = all.value;
      deps.storage.set(k, JSON.stringify({ v: 1, tracks: all.value })).catch(() => {});
    }
    deps.storage.set(metaKey(k), JSON.stringify({ fullAt, checkedAt, fmt: CATALOG_FORMAT })).catch(() => {});
  }

  async function run(force: boolean): Promise<void> {
    const g = gen;
    // Captured now: a sign-in during the fetch bumps `gen`, and the result is dropped.
    const k = key();
    await restore(k);
    if (g !== gen) return;
    const have = all.value.length > 0;
    const age = now() - fullAt;
    const mode = !have || age >= FULL_AFTER_MS ? 'full' : force || now() - checkedAt >= INCREMENTAL_AFTER_MS ? 'incremental' : null;
    if (!mode) return;
    try {
      if (mode === 'full') {
        const fetched = await deps.source.catalog();
        if (g !== gen) return;
        all.value = mergeById([], fetched);
        fullAt = checkedAt = now();
      } else {
        const since = new Date(all.value[0].createdAt);
        const fresh = await deps.source.catalog(isNaN(since.getTime()) ? undefined : since);
        if (g !== gen) return;
        if (fresh.length) all.value = mergeById(all.value, fresh);
        checkedAt = now();
      }
      error.value = null;
      status.value = 'ready';
      persist(k);
    } catch (e) {
      if (g !== gen) return;
      error.value = toLoadError(e, !online.peek());
      // With a cache we keep showing it; only an empty catalog is an error state.
      status.value = all.value.length ? 'ready' : 'error';
    }
  }

  const api: Catalog = {
    tracks,
    all,
    status,
    error,
    refresh(opts = {}) {
      if (inflight) return inflight;
      if (!all.value.length) status.value = 'loading';
      const mine = run(!!opts.force).finally(() => {
        if (inflight === mine) inflight = null;
      });
      inflight = mine;
      return mine;
    },
    restoreSaved() {
      return restore(key());
    },
    reset() {
      gen++;
      inflight = null;
      restored = Promise.resolve();
      saved = null;
      all.value = all.value.filter((t) => !t.membersOnly);
      fullAt = checkedAt = 0;
      error.value = null;
      if (!all.value.length) status.value = 'idle';
      const keys = [CATALOG_KEY, CATALOG_MEMBERS_KEY].flatMap((k) => [k, metaKey(k)]);
      const removed = Promise.all(keys.map((k) => (deps.storage.remove ? deps.storage.remove(k) : deps.storage.set(k, '')).catch(() => {})));
      return (switching = removed.then(() => api.refresh()));
    },
    settled: () => switching,
  };
  return api;
}

// ---- Ranking helpers -----------------------------------------------------------------

export type SavedRange = 'month' | 'all';
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

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
export function genreCounts(tracks: Track[]): GenreCount[] {
  const counts = new Map<string, number>();
  for (const t of tracks) if (t.genre) counts.set(t.genre, (counts.get(t.genre) ?? 0) + 1);
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// ---- App instance --------------------------------------------------------------------

/** The catalogs' track lists are files; everything else (the times) small keys. */
const CATALOG_FILES: Record<string, TextFile> = {
  [CATALOG_KEY]: textFile('data', 'catalog-public', { legacyKeys: [CATALOG_KEY] }),
  [CATALOG_MEMBERS_KEY]: textFile('data', 'catalog-members', { legacyKeys: [CATALOG_MEMBERS_KEY] }),
};

const appStorage: CatalogStorage = {
  get: (key) => (CATALOG_FILES[key] ? CATALOG_FILES[key].read() : kv.get(key)),
  set: (key, value) => (CATALOG_FILES[key] ? CATALOG_FILES[key].write(value) : kv.set(key, value)),
  remove: (key) => (CATALOG_FILES[key] ? CATALOG_FILES[key].remove() : kv.remove(key)),
};

/** The app's catalog. */
export const catalog = createCatalog({
  source,
  storage: appStorage,
  showNsfw: () => showNsfw.value,
  storageKey: () => catalogKey(auth.signedIn()),
});
