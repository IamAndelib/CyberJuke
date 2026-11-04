import { describe, expect, it } from 'vitest';
import type { Track } from '../data/model';
import { EMPTY_STATE, nsfwAutoplayIds, placeOf, type PlayerState, type UpNextItem } from './types';

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
