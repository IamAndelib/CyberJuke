import { describe, expect, it } from 'vitest';
import type { Track } from '../data/model';
import {
  HISTORY_EXTRA,
  HISTORY_MAX,
  MIGRATION_STEP_MS,
  addPlay,
  dayLabel,
  groupByDay,
  migrateHistory,
  pruneHistory,
  uniqueTracks,
  type HistoryEntry,
} from './history';

const tr = (id: string): Track => ({ id, ytId: 'y' + id, title: id, artist: 'A', genre: '', by: '', postTitle: '', postUrl: '', createdAt: '', nsfw: false, artworkUrl: '' });
const H = 3600_000;
const D = 24 * H;
const NOW = new Date(2026, 9, 8, 15, 0).getTime(); // Thu 8 Oct 2026, 15:00 local
const ids = (es: HistoryEntry[]) => es.map((e) => e.track.id);

describe('retention', () => {
  it('keeps everything from the last 3 days even past 100 entries', () => {
    const es = Array.from({ length: 300 }, (_, i) => ({ track: tr('r' + i), playedAt: NOW - i * 10 * 60_000 })); // 50 h
    expect(pruneHistory(es, NOW)).toHaveLength(300);
  });

  it('keeps 100 more beyond the 3 days, and no older ones', () => {
    const inWindow = Array.from({ length: 20 }, (_, i) => ({ track: tr('n' + i), playedAt: NOW - i * H }));
    const old = Array.from({ length: 250 }, (_, i) => ({ track: tr('o' + i), playedAt: NOW - 4 * D - i * H }));
    const kept = pruneHistory([...old, ...inWindow], NOW);
    expect(kept).toHaveLength(20 + HISTORY_EXTRA);
    expect(ids(kept).slice(0, 20)).toEqual(inWindow.map((e) => e.track.id));
    expect(kept[kept.length - 1].track.id).toBe('o99');
  });

  it('keeps at least 100 when nothing is recent', () => {
    const old = Array.from({ length: 150 }, (_, i) => ({ track: tr('o' + i), playedAt: NOW - 10 * D - i * H }));
    expect(pruneHistory(old, NOW)).toHaveLength(100);
  });

  it('caps the total at 1000', () => {
    const es = Array.from({ length: 1500 }, (_, i) => ({ track: tr('x' + i), playedAt: NOW - i * 60_000 }));
    expect(pruneHistory(es, NOW)).toHaveLength(HISTORY_MAX);
  });
});

describe('addPlay', () => {
  it('lists a track once per day, moving a replay to the top', () => {
    let es: HistoryEntry[] = [];
    es = addPlay(es, tr('a'), NOW - 2 * H);
    es = addPlay(es, tr('b'), NOW - H);
    es = addPlay(es, tr('a'), NOW);
    expect(ids(es)).toEqual(['a', 'b']);
    expect(es[0].playedAt).toBe(NOW);
  });

  it('keeps the same track on different days', () => {
    let es = addPlay([], tr('a'), NOW - D);
    es = addPlay(es, tr('a'), NOW);
    expect(ids(es)).toEqual(['a', 'a']);
    expect(uniqueTracks(es).map((t) => t.id)).toEqual(['a']);
  });

  it('returns the same array when the track is already on top today', () => {
    const es = addPlay([], tr('a'), NOW - 1000);
    expect(addPlay(es, tr('a'), NOW)).toBe(es);
  });
});

describe('migration', () => {
  it('gives old untimed entries staggered timestamps, keeping order and dropping junk', () => {
    const es = migrateHistory([tr('a'), null, tr('b'), { id: 3 }, tr('c')], NOW);
    expect(ids(es)).toEqual(['a', 'b', 'c']);
    expect(es.map((e) => e.playedAt)).toEqual([NOW, NOW - MIGRATION_STEP_MS, NOW - 2 * MIGRATION_STEP_MS]);
  });

  it('reads the new shape as is and ignores non-arrays', () => {
    const es = [{ track: tr('a'), playedAt: NOW - D }, { track: tr('b'), playedAt: NOW }];
    expect(ids(migrateHistory(es, NOW))).toEqual(['b', 'a']);
    expect(migrateHistory({ nope: 1 }, NOW)).toEqual([]);
  });
});

describe('day groups', () => {
  it('labels Today, Yesterday and older days', () => {
    expect(dayLabel(NOW - H, NOW)).toBe('Today');
    expect(dayLabel(NOW - D, NOW)).toBe('Yesterday');
    expect(dayLabel(new Date(2026, 9, 5, 9).getTime(), NOW)).toBe('Mon 5 Oct');
    expect(dayLabel(new Date(2025, 11, 31, 9).getTime(), NOW)).toBe('Wed 31 Dec 2025');
  });

  it('groups by local day, newest first', () => {
    const es = pruneHistory(
      [
        { track: tr('a'), playedAt: NOW - H },
        { track: tr('b'), playedAt: NOW - 2 * H },
        { track: tr('c'), playedAt: NOW - D },
        { track: tr('d'), playedAt: NOW - 3 * D },
      ],
      NOW,
    );
    const g = groupByDay(es, NOW);
    expect(g.map((d) => d.label)).toEqual(['Today', 'Yesterday', 'Mon 5 Oct']);
    expect(g[0].tracks.map((t) => t.id)).toEqual(['a', 'b']);
  });
});
