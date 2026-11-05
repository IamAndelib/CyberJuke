import { describe, expect, it } from 'vitest';
import type { Track } from '../data/model';
import { PLAYLIST_MAX_SONGS } from '../stores/playlists';
import { saveSongs } from './saveSongs';

const t = (id: string) => ({ id }) as Track;
const ids = (xs: Track[]) => xs.map((x) => x.id);
const base = { listStart: 0, nextStart: -1, shuffle: false, shown: [] as Track[], mine: [] as number[], gone: [] };

describe('saveSongs', () => {
  it('saves the current list, not the history before it nor the list on the way', () => {
    const queue = ['h1', 'a', 'b', 'c', 'n1'].map(t);
    expect(ids(saveSongs({ ...base, queue, listStart: 1, nextStart: 4 }))).toEqual(['a', 'b', 'c']);
  });

  it('shuffled, saves the list in play order: the rows as they show, then the rest', () => {
    const queue = ['a', 'b', 'c', 'd'].map(t);
    expect(ids(saveSongs({ ...base, queue, shuffle: true, shown: ['c', 'a'].map(t) }))).toEqual(['c', 'a', 'b', 'd']);
  });

  it('puts the songs you queued and heard in earlier lists of the chain first, in play order', () => {
    const queue = ['a1', 'm1', 'a2', 'm2', 'b1', 'b2'].map(t);
    expect(ids(saveSongs({ ...base, queue, listStart: 4, mine: [1, 3] }))).toEqual(['m1', 'm2', 'b1', 'b2']);
    const shown = ['a2', 'm2', 'a1', 'm1', 'b2'].map(t);
    expect(ids(saveSongs({ ...base, queue, listStart: 4, mine: [1, 3], shuffle: true, shown }))).toEqual(['m2', 'm1', 'b2', 'b1']);
  });

  it('puts a song you queued that left the queue right after the song it followed, else at the end', () => {
    const queue = ['a', 'b', 'c'].map(t);
    const gone = [
      { track: t('m1'), after: 'a' },
      { track: t('m2'), after: 'm1' },
      { track: t('m3'), after: 'x' },
      { track: t('m4'), after: 'a' },
    ];
    // m4 followed a in a later lap: after what a led to before.
    expect(ids(saveSongs({ ...base, queue, gone }))).toEqual(['a', 'm1', 'm2', 'm4', 'b', 'c', 'm3']);
  });

  it('leaves out a remembered song still in the queue, and saves each song once', () => {
    const queue = ['a', 'm1', 'b', 'a'].map(t);
    const gone = [
      { track: t('m1'), after: 'a' },
      { track: t('m2'), after: 'b' },
      { track: t('m2'), after: 'a' },
    ];
    expect(ids(saveSongs({ ...base, queue, mine: [1], gone }))).toEqual(['a', 'm1', 'b', 'm2']);
  });

  it('saves at most PLAYLIST_MAX_SONGS', () => {
    const queue = Array.from({ length: PLAYLIST_MAX_SONGS + 5 }, (_, i) => t(`s${i}`));
    expect(saveSongs({ ...base, queue })).toHaveLength(PLAYLIST_MAX_SONGS);
  });
});
