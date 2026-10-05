/** Genres seen so far in any loaded page, with how many distinct tracks carry each. */
import { computed, signal } from '@preact/signals';
import type { Track } from '../data/model';

const seen = new Set<string>();
const counts = signal<Record<string, number>>({});

export function recordTracks(tracks: Track[]): void {
  let next: Record<string, number> | null = null;
  for (const t of tracks) {
    if (!t.genre || seen.has(t.id)) continue;
    seen.add(t.id);
    next ??= { ...counts.value };
    next[t.genre] = (next[t.genre] ?? 0) + 1;
  }
  if (next) counts.value = next;
}

export interface GenreCount {
  name: string;
  count: number;
}

export const genres = computed<GenreCount[]>(() =>
  Object.entries(counts.value)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
);
