import { effect } from '@preact/signals';
import { describe, expect, it } from 'vitest';
import type { Track } from '../data/model';
import { liked } from './library';
import { hasSavedLiked, isSaved, savedLiked, savedOffline, savedQueue, savedTracks, setSavedOffline } from './savedOffline';

const t = (id: string): Track => ({ id, ytId: id.padEnd(11, '0') }) as Track;
const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(t);

describe('savedOffline', () => {
  it('holds what native reports, and changes only when the set does', () => {
    let runs = 0;
    const stop = effect(() => {
      void savedOffline.value;
      runs++;
    });
    setSavedOffline([a.ytId, b.ytId]);
    expect(runs).toBe(2);
    // The same set again (another order, a duplicate): no change, nothing re-renders.
    setSavedOffline([b.ytId, a.ytId, a.ytId]);
    expect(runs).toBe(2);
    expect(isSaved(a)).toBe(true);
    expect(isSaved(c)).toBe(false);
    // Junk from the bridge is ignored.
    setSavedOffline([c.ytId, 3, null, '']);
    expect([...savedOffline.value]).toEqual([c.ytId]);
    expect(runs).toBe(3);
    stop();
    setSavedOffline([]);
  });

  it('knows a saved Jukebox MP3 by its audio id', () => {
    const mp3 = { id: 'p1', ytId: '', mp3: 'https://latex.gg/share/IZq8cMcx.mp3' } as Track;
    const other = { id: 'p2', ytId: '', mp3: 'https://latex.gg/share/FEHdI7AK.mp3' } as Track;
    liked.value = [other, mp3, a];
    setSavedOffline(['mp3:IZq8cMcx.mp3', a.ytId]);
    expect(isSaved(mp3)).toBe(true);
    expect(isSaved(other)).toBe(false);
    expect(savedLiked.value).toEqual([mp3, a]);
    expect(savedQueue([other, mp3, a], 1, savedOffline.value)).toEqual({ tracks: [mp3, a], start: 0 });
    // Not by its link, nor by a placeholder's empty id.
    setSavedOffline(['https://latex.gg/share/IZq8cMcx.mp3', '']);
    expect(isSaved(mp3)).toBe(false);
    expect(isSaved({ id: 'x', ytId: '' } as Track)).toBe(false);
    liked.value = [];
    setSavedOffline([]);
  });

  it('lists the liked songs that play offline, in Liked order', () => {
    liked.value = [d, c, b, a];
    setSavedOffline([a.ytId, c.ytId, 'notliked00']);
    expect(savedLiked.value).toEqual([c, a]);
    expect(hasSavedLiked.value).toBe(true);
    setSavedOffline([]);
    expect(hasSavedLiked.value).toBe(false);
    // Saved, but not liked any more: not offered.
    setSavedOffline([b.ytId]);
    liked.value = [a];
    expect(hasSavedLiked.value).toBe(false);
    liked.value = [];
    setSavedOffline([]);
  });

  it('builds the offline queue from the tapped song: the saved ones, in order', () => {
    const saved = new Set([a.ytId, c.ytId, d.ytId]);
    expect(savedQueue([a, b, c, d], 2, saved)).toEqual({ tracks: [a, c, d], start: 1 });
    expect(savedQueue([a, b, c, d], 0, saved)).toEqual({ tracks: [a, c, d], start: 0 });
    expect(savedQueue([b, a], 1, saved)).toEqual({ tracks: [a], start: 0 });
    // The tapped one isn't saved (or there is none): nothing to start from.
    expect(savedQueue([a, b, c, d], 1, saved)).toBeNull();
    expect(savedQueue([a], 5, saved)).toBeNull();
    expect(savedQueue([a, b], 0, new Set())).toBeNull();
  });

  it('offline, any list plays its saved songs, in order (Play and Shuffle)', () => {
    const saved = new Set([a.ytId, c.ytId]);
    expect(savedTracks([d, c, b, a], saved)).toEqual([c, a]);
    expect(savedTracks([b, d], saved)).toEqual([]);
  });
});
