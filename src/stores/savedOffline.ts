/**
 * Which liked songs are saved whole on the phone, by ytId (the native listening cache). Offline
 * they are the only music that plays. Native reports the set (player/listeningCache: at start
 * and on `cacheChanged`); in the browser nothing is ever saved, so it stays empty.
 */
import { computed, signal } from '@preact/signals';
import type { Track } from '../data/model';
import { liked } from './library';

/** The play context label of Library → Liked: offline, a list started from there plays its saved songs. */
export const LIKED_LABEL = 'Liked';

/** ytIds of the liked songs saved whole on the phone. */
export const savedOffline = signal<ReadonlySet<string>>(new Set());

/** What native reports; the signal changes only when the set does. */
export function setSavedOffline(ytIds: readonly unknown[]): void {
  const next = new Set(ytIds.filter((x): x is string => typeof x === 'string' && x !== ''));
  const cur = savedOffline.peek();
  if (next.size === cur.size && [...next].every((id) => cur.has(id))) return;
  savedOffline.value = next;
}

/** The liked songs that play offline, in Liked's order. */
export const savedLiked = computed<Track[]>(() => {
  const saved = savedOffline.value;
  return saved.size ? liked.value.filter((t) => saved.has(t.ytId)) : [];
});

/** Some liked song plays offline (the offline banner and toast point to Liked then). */
export const hasSavedLiked = computed(() => savedLiked.value.length > 0);

/** Whether `t` plays offline. */
export function isSaved(t: Track | null | undefined, saved: ReadonlySet<string> = savedOffline.peek()): boolean {
  return !!t?.ytId && saved.has(t.ytId);
}

/**
 * Offline, a list started from Liked plays only its saved songs, from the tapped one: those of
 * `tracks` that are saved, and where `tracks[start]` is among them. Null when the tapped one
 * isn't saved (nothing to start from).
 */
export function savedQueue(tracks: readonly Track[], start: number, saved: ReadonlySet<string>): { tracks: Track[]; start: number } | null {
  if (!isSaved(tracks[start], saved)) return null;
  const out: Track[] = [];
  let at = 0;
  tracks.forEach((t, i) => {
    if (i === start) at = out.length;
    if (isSaved(t, saved)) out.push(t);
  });
  return { tracks: out, start: at };
}
