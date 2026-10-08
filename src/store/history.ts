/**
 * Listening history: pure functions over `{ track, playedAt }` entries, newest first.
 *
 * Retention: everything played in the last HISTORY_DAYS days is kept, plus the latest
 * HISTORY_EXTRA entries before that, never more than HISTORY_MAX in all. A track is
 * listed once per (local) day: replaying it moves it to the top of that day.
 */
import type { Track } from '../data/model';

export interface HistoryEntry {
  track: Track;
  /** Epoch ms. */
  playedAt: number;
}

export const HISTORY_DAYS = 3;
export const HISTORY_EXTRA = 100;
export const HISTORY_MAX = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Spacing of the timestamps given to entries migrated from the old, untimed list. */
export const MIGRATION_STEP_MS = 60 * 1000;

/** Local calendar day, e.g. "2026-10-08". */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Newest first, the retention rules applied. */
export function pruneHistory(entries: HistoryEntry[], now: number): HistoryEntry[] {
  const sorted = entries.slice().sort((a, b) => b.playedAt - a.playedAt);
  const cutoff = now - HISTORY_DAYS * DAY_MS;
  let recentCount = 0;
  while (recentCount < sorted.length && sorted[recentCount].playedAt >= cutoff) recentCount++;
  return sorted.slice(0, Math.min(HISTORY_MAX, recentCount + HISTORY_EXTRA));
}

/** Record a play. Returns the same array when nothing changes (already on top today). */
export function addPlay(entries: HistoryEntry[], track: Track, now: number): HistoryEntry[] {
  const today = dayKey(now);
  const top = entries[0];
  if (top && top.track.id === track.id && dayKey(top.playedAt) === today) return entries;
  const rest = entries.filter((e) => !(e.track.id === track.id && dayKey(e.playedAt) === today));
  return pruneHistory([{ track, playedAt: now }, ...rest], now);
}

function isTrack(t: unknown): t is Track {
  return !!t && typeof (t as Track).id === 'string' && typeof (t as Track).ytId === 'string';
}

/**
 * Read stored history. Accepts the current `{ track, playedAt }[]` shape and the old
 * plain `Track[]` list (newest first, no timestamps): old entries get staggered
 * timestamps going back from `now`, so their order is kept and nothing is lost.
 */
export function migrateHistory(raw: unknown, now: number): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryEntry[] = [];
  let k = 0;
  for (const x of raw) {
    const e = x as Partial<HistoryEntry>;
    if (e && isTrack(e.track) && typeof e.playedAt === 'number' && isFinite(e.playedAt)) out.push({ track: e.track, playedAt: e.playedAt });
    else if (isTrack(x)) out.push({ track: x, playedAt: now - k++ * MIGRATION_STEP_MS });
  }
  return pruneHistory(out, now);
}

/** Tracks in history order, each once (for Play all, search and id lookups). */
export function uniqueTracks(entries: HistoryEntry[]): Track[] {
  const seen = new Set<string>();
  const out: Track[] = [];
  for (const e of entries) {
    if (seen.has(e.track.id)) continue;
    seen.add(e.track.id);
    out.push(e.track);
  }
  return out;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Today", "Yesterday", or "Mon 6 Oct" (with the year when it isn't this year). */
export function dayLabel(ms: number, now: number): string {
  const k = dayKey(ms);
  if (k === dayKey(now)) return 'Today';
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (k === dayKey(y.getTime())) return 'Yesterday';
  const d = new Date(ms);
  const base = `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

export interface HistoryDay {
  key: string;
  label: string;
  tracks: Track[];
}

/** Entries grouped by local day, newest day first. */
export function groupByDay(entries: HistoryEntry[], now: number): HistoryDay[] {
  const days: HistoryDay[] = [];
  for (const e of entries) {
    const key = dayKey(e.playedAt);
    let d = days[days.length - 1];
    if (!d || d.key !== key) days.push((d = { key, label: dayLabel(e.playedAt, now), tracks: [] }));
    d.tracks.push(e.track);
  }
  return days;
}
