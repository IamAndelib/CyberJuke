/**
 * Which liked songs are saved whole on the phone, by audio id (the native listening cache: a
 * video id, or `mp3:<file>` for a Jukebox MP3, core/guards audioIdOf). Offline they are the only
 * music that plays. Native reports the set (player/listeningCache: at start and on
 * `cacheChanged`); in the browser nothing is ever saved, so it stays empty.
 */
import { computed, signal } from '@preact/signals';
import { audioIdOf, isAudioId } from '../core/guards';
import type { Track } from '../data/model';
import { likedShown } from './library';

/** Audio ids of the liked songs saved whole on the phone. */
export const savedOffline = signal<ReadonlySet<string>>(new Set());

/** What native reports; the signal changes only when the set does. */
export function setSavedOffline(audioIds: readonly unknown[]): void {
  const next = new Set(audioIds.filter(isAudioId));
  const cur = savedOffline.peek();
  if (next.size === cur.size && [...next].every((id) => cur.has(id))) return;
  savedOffline.value = next;
}

/** The liked songs that play offline, in Liked's order (those Liked shows: hidden NSFW songs aren't offered). */
export const savedLiked = computed<Track[]>(() => {
  const saved = savedOffline.value;
  return saved.size ? likedShown.value.filter((t) => isSaved(t, saved)) : [];
});

/** Some liked song plays offline (the offline banner and toast point to Liked then). */
export const hasSavedLiked = computed(() => savedLiked.value.length > 0);

/** Whether `t` plays offline. */
export function isSaved(t: Track | null | undefined, saved: ReadonlySet<string> = savedOffline.peek()): boolean {
  const id = audioIdOf(t);
  return !!id && saved.has(id);
}

/** Offline, the songs of `tracks` that play: the saved ones, in order. */
export function savedTracks(tracks: readonly Track[], saved: ReadonlySet<string>): Track[] {
  return tracks.filter((t) => isSaved(t, saved));
}

/**
 * Offline, a list (from wherever it was started) plays only its saved songs, from the tapped
 * one: those of `tracks` that are saved, and where `tracks[start]` is among them. Null when the
 * tapped one isn't saved (nothing to start from).
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
