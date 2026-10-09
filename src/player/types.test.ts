import { describe, expect, it } from 'vitest';
import type { Track } from '../data/model';
import { nsfwAutoplayIds, type UpNextItem } from './types';

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
