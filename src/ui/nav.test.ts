import { signal } from '@preact/signals';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { artistChoice, menuTrack, nowPlayingOpen, openNowPlayingWhen } from './nav';
import type { Track } from '../data/model';

describe('openNowPlayingWhen (notification tap)', () => {
  afterEach(() => {
    vi.useRealTimers();
    nowPlayingOpen.value = false;
    menuTrack.value = null;
    artistChoice.value = null;
  });

  it('opens Now Playing at once when there is a track, closing menus', () => {
    menuTrack.value = { id: 'x' } as Track;
    artistChoice.value = ['A', 'B'];
    openNowPlayingWhen(signal(true));
    expect(nowPlayingOpen.value).toBe(true);
    expect(menuTrack.value).toBeNull();
    expect(artistChoice.value).toBeNull();
  });

  it('at a cold start, opens once the player reports a track', async () => {
    const has = signal(false);
    openNowPlayingWhen(has);
    expect(nowPlayingOpen.value).toBe(false);
    has.value = true;
    expect(nowPlayingOpen.value).toBe(true);
    // Once: closing it and a later track change don't reopen it.
    await Promise.resolve();
    nowPlayingOpen.value = false;
    has.value = false;
    has.value = true;
    expect(nowPlayingOpen.value).toBe(false);
  });

  it('gives up when no track comes in time', () => {
    vi.useFakeTimers();
    const has = signal(false);
    openNowPlayingWhen(has, 5000);
    vi.advanceTimersByTime(5000);
    has.value = true;
    expect(nowPlayingOpen.value).toBe(false);
  });
});
