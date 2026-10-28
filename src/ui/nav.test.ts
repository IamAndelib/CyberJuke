import { signal } from '@preact/signals';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { artistChoice, canGoBack, confirmRequest, goBack, lyricsOpen, menuTrack, nowPlayingOpen, openArtistPage, openGenrePage, openNowPlayingWhen, openSettings, popToRoot, selectTab, stacks, tab, topEntry } from './nav';
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

describe('Settings (its own screen, opened from Home)', () => {
  afterEach(() => {
    selectTab('home');
    nowPlayingOpen.value = false;
  });

  it('is not a page on Home: Home stays as it was, and the Home tab shows Home', () => {
    selectTab('home');
    openSettings();
    expect(tab.value).toBe('settings');
    expect(stacks.value.home).toEqual([]);
    // Another tab, then Home: Home itself, not Settings.
    selectTab('genres');
    selectTab('home');
    expect(tab.value).toBe('home');
    expect(topEntry.value).toBeNull();
  });

  it('closes over Now Playing and goes back to Home on Back, Android back or Escape', () => {
    for (const switchTab of [true, false]) {
      nowPlayingOpen.value = true;
      openSettings();
      expect(nowPlayingOpen.value).toBe(false);
      expect(goBack(switchTab)).toBe(true);
      expect(tab.value).toBe('home');
      expect(topEntry.value).toBeNull();
    }
  });
});

describe('canGoBack (Android back goes to the page only then)', () => {
  const reset = () => {
    confirmRequest.value = null;
    menuTrack.value = null;
    artistChoice.value = null;
    nowPlayingOpen.value = false;
    lyricsOpen.value = false;
    for (const t of ['home', 'genres', 'settings'] as const) popToRoot(t);
    selectTab('home');
  };
  afterEach(reset);

  it("is false only at Home's root, where Android back is left to Android", () => {
    reset();
    expect(canGoBack.value).toBe(false);
    expect(goBack()).toBe(false);
  });

  it('is true exactly while goBack has something to close, and false again once all of it is closed', () => {
    const states: [string, () => void][] = [
      ['a confirm sheet', () => (confirmRequest.value = { title: 'Clear?', confirm: 'Clear', run: () => {} })],
      ['a track menu', () => (menuTrack.value = { id: 'x' } as Track)],
      ['the artist chooser', () => (artistChoice.value = ['A', 'B'])],
      ['Now Playing with lyrics', () => ((nowPlayingOpen.value = true), (lyricsOpen.value = true))],
      ['a page on Home', () => openArtistPage('A')],
      ['Settings', () => openSettings()],
      ['another tab', () => selectTab('genres')],
      ['a page on another tab', () => (selectTab('genres'), openGenrePage('Rock'))],
    ];
    for (const [what, open] of states) {
      reset();
      open();
      expect(canGoBack.value, what).toBe(true);
      let backs = 0;
      while (canGoBack.value) {
        expect(goBack(), what).toBe(true);
        expect(++backs, what).toBeLessThan(5);
      }
      expect(goBack(), what).toBe(false);
      expect(tab.value, what).toBe('home');
    }
  });
});
