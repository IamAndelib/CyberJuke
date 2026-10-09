/**
 * P9: the last few searches, shown under the search field while it's empty. Newest
 * first, each once (case-insensitive), kept in a small key.
 */
import { signal } from '@preact/signals';
import { kv, readJson, type KV } from '../core/storage';

export const RECENT_SEARCHES_MAX = 5;
const K_RECENT_SEARCHES = 'recentSearches';

export const recentSearches = signal<string[]>([]);

let store: KV = kv;
let loaded: Promise<void> | null = null;

/** Tests: other storage, read afresh. */
export function setSearchesStorage(s: KV): void {
  store = s;
  loaded = null;
  recentSearches.value = [];
}

function clean(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const x of list) {
    if (typeof x !== 'string') continue;
    const q = x.trim();
    if (q && !out.some((o) => o.toLowerCase() === q.toLowerCase())) out.push(q);
  }
  return out.slice(0, RECENT_SEARCHES_MAX);
}

/** Read the stored list once (later calls return the same promise). */
export function loadRecentSearches(): Promise<void> {
  loaded ??= readJson<unknown>(store, K_RECENT_SEARCHES, []).then((raw) => {
    const stored = clean(raw);
    // Anything added before the read finished stays on top, and the merged list is saved.
    const merged = clean([...recentSearches.value, ...stored]);
    recentSearches.value = merged;
    if (merged.length !== stored.length || merged.some((x, i) => x !== stored[i])) write();
  });
  return loaded;
}

function write(): void {
  store.set(K_RECENT_SEARCHES, JSON.stringify(recentSearches.value)).catch(() => {});
}

/** Saved once the stored list has been read and merged (a save before it would replace it). */
function save(): void {
  void loadRecentSearches().then(write, write);
}

/** Remember a search (a query someone acted on). Too short to be worth keeping: ignored. */
export function addRecentSearch(q: string): void {
  const query = q.trim();
  if (query.length < 2) return;
  const next = clean([query, ...recentSearches.value]);
  if (next.length === recentSearches.value.length && next.every((x, i) => x === recentSearches.value[i])) return;
  recentSearches.value = next;
  save();
}

export function removeRecentSearch(q: string): void {
  const next = recentSearches.value.filter((x) => x !== q);
  if (next.length === recentSearches.value.length) return;
  recentSearches.value = next;
  save();
}

/** Empties the list; returns what it held, for Undo (restoreRecentSearches). */
export function clearRecentSearches(): string[] {
  const old = recentSearches.value;
  if (!old.length) return old;
  recentSearches.value = [];
  save();
  return old;
}

/** Undo of a clear: the old searches come back, after any made since. */
export function restoreRecentSearches(old: string[]): void {
  const next = clean([...recentSearches.value, ...old]);
  recentSearches.value = next;
  save();
}
