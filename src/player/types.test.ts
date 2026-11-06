import { describe, expect, it } from 'vitest';
import type { Track } from '../data/model';
import { EMPTY_STATE, nsfwAutoplayIds, placeOf, sectionsOf, undoOf, type PlayerState, type UpNextItem } from './types';

const t = (id: string, nsfw: boolean) => ({ id, nsfw }) as Track;

describe('nsfwAutoplayIds', () => {
  it('lists only NSFW autoplay picks, once each; what you queued or chose stays', () => {
    const upNext: UpNextItem[] = [
      { track: t('a', true), index: 1, queued: true },
      { track: t('b', true), index: 2 },
      { track: t('c', true), index: 3, auto: true },
      { track: t('d', false), index: 4, auto: true },
      { track: t('c', true), index: 5, auto: true },
    ];
    expect(nsfwAutoplayIds(upNext)).toEqual(['c']);
    expect(nsfwAutoplayIds([])).toEqual([]);
  });
});

describe('placeOf', () => {
  const tracks = (n: number, p: string) => Array.from({ length: n }, (_, i) => ({ id: `${p}${i}`, nsfw: false }) as Track);
  const at = (list: Track[], auto: Track[], index: number): PlayerState => {
    const queue = [...list, ...auto];
    const upNext = queue.slice(index + 1, index + 51).map((track, i) => ({ track, index: index + 1 + i, ...(i + index + 1 >= list.length && { auto: true }) }));
    return { ...EMPTY_STATE, queue, index, upNext };
  };

  it('counts the list you started, not autoplay, however many autoplay songs are past Up next\'s 50', () => {
    expect(placeOf(at(tracks(12, 'l'), tracks(60, 'a'), 3))).toBe('4 of 12');
    expect(placeOf(at(tracks(12, 'l'), [], 3))).toBe('4 of 12');
    expect(placeOf(at(tracks(80, 'l'), [], 0))).toBe('1 of 80');
    expect(placeOf(at(tracks(1, 'l'), tracks(30, 'a'), 0))).toBe('Single track');
  });
});

describe('sectionsOf', () => {
  const u = (id: string, index: number, more: Partial<UpNextItem> = {}): UpNextItem => ({ track: t(id, false), index, ...more });
  const runs = (upNext: UpNextItem[], nextStart: number) => sectionsOf(upNext, null, nextStart).runs.map((r) => [r.kind, r.items.map((x) => x.track.id)]);

  it("starts a new run where the list on the way starts, so ↑ ↓ never cross that line (S7, D15)", () => {
    // A radio's own suggestions, then the next batch: one kind, two runs.
    const up = [u('s1', 1, { auto: true }), u('s2', 2, { auto: true }), u('t1', 3, { auto: true }), u('t2', 4, { auto: true })];
    expect(runs(up, 3)).toEqual([['autoplay', ['s1', 's2']], ['autoplay', ['t1', 't2']]]);
    expect(runs(up, -1)).toEqual([['autoplay', ['s1', 's2', 't1', 't2']]]);
    expect(sectionsOf(up, null, 3).autoplay.map((x) => x.track.id)).toEqual(['s1', 's2', 't1', 't2']);
    // List songs a shuffled tap brought along start the list on the way.
    expect(runs([u('b', 2), u('c', 3), u('t1', 4, { auto: true })], 3)).toEqual([['list', ['b']], ['list', ['c']], ['autoplay', ['t1']]]);
  });
});

describe('undoOf', () => {
  const u = (id: string, index: number, more: Partial<UpNextItem> = {}): UpNextItem => ({ track: t(id, false), index, ...more });
  const none = { upNext: [], previous: [], lap: [], mine: [], listStart: 0, nextStart: -1, shuffle: false };

  it('anchors a Played row on the song after it in play order, heard or not, at its index once it is gone (S9)', () => {
    // Repeat all, Previous from a to c: Played shows a, From the top a and b.
    const s = { ...none, previous: [u('a', 0)], lap: [u('a', 0), u('b', 1)] };
    expect(undoOf(s, u('a', 0), 'played')).toEqual({ kind: 'played', before: { id: 'b', index: 0 }, heard: true });
    // A song you queued and heard is only in Played: unshuffled the nearer in list order comes first, shuffled the Played row.
    const m = { ...none, previous: [u('a', 0), u('M', 2)], lap: [u('a', 0), u('b', 1)], mine: [2] };
    expect(undoOf(m, u('a', 0), 'played').before).toEqual({ id: 'b', index: 0 });
    expect(undoOf({ ...m, shuffle: true }, u('a', 0), 'played').before).toEqual({ id: 'M', index: 1 });
    // The next Played row is in From the top too: an unheard song before it comes first.
    const n = { ...none, previous: [u('a', 0), u('c', 2)], lap: [u('a', 0), u('b', 1), u('c', 2)] };
    expect(undoOf(n, u('a', 0), 'played').before?.id).toBe('b');
    // A From the top row you heard goes back among the played, with its tag.
    expect(undoOf({ ...s, previous: [u('a', 0, { auto: true })], lap: [u('a', 0, { auto: true }), u('b', 1)] }, u('a', 0), 'top')).toEqual({ kind: 'played', before: { id: 'b', index: 0 }, auto: true, heard: true });
    expect(undoOf(s, u('b', 1), 'top')).toEqual({ kind: 'top', before: null });
    // A song of an earlier list (before the current list's marker) goes back into that one.
    expect(undoOf({ ...s, listStart: 1 }, u('a', 0), 'played').earlier).toBe(true);
    expect(undoOf({ ...s, listStart: 1 }, u('b', 1), 'top').earlier).toBeUndefined();
  });

  it("keeps an Up next row's kind, tag, heard state and mark; a suggestion of the list you're in goes back into it (S6, S8, S15)", () => {
    const s = { ...none, upNext: [u('b', 1, { heard: true }), u('s1', 2, { auto: true }), u('t1', 3, { auto: true })], mine: [1], nextStart: 3 };
    expect(undoOf(s, u('b', 1), 'list')).toEqual({ kind: 'list', before: { id: 's1', index: 1 }, mine: true, heard: true });
    expect(undoOf(s, u('s1', 2), 'autoplay')).toEqual({ kind: 'list', before: { id: 't1', index: 2 }, auto: true });
    expect(undoOf(s, u('t1', 3), 'autoplay')).toEqual({ kind: 'autoplay', before: null, auto: true });
  });
});
