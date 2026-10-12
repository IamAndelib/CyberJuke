import { describe, expect, it, vi } from 'vitest';
import type { Track } from '../data/model';
import { encodeHistory } from './history';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} },
}));
const files = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => files.get(k) ?? null,
  setItem: (k: string, v: string) => void files.set(k, v),
  removeItem: (k: string) => void files.delete(k),
};
const HISTORY_FILE = 'cyberjuke.file:data/cyberjuke/history.json';
const LIKED_FILE = 'cyberjuke.file:data/cyberjuke/liked.json';

const track = (id: string): Track => ({
  id, ytId: `${id}__________`.slice(0, 11), title: id, artist: 'A', genre: 'house', by: 'p',
  postTitle: '', postUrl: '', createdAt: '2026-09-01T00:00:00Z', nsfw: false, artworkUrl: '',
});

describe('history and Liked at startup', () => {
  it('a play recorded before the library was first read is kept (the app reopened mid-song)', async () => {
    const now = Date.now();
    files.set(HISTORY_FILE, JSON.stringify(encodeHistory([{ track: track('old'), playedAt: now - 60_000 }])));
    const lib = await import('./library');
    lib.addRecent(track('playing'), now);
    await lib.loadLibrary();
    expect(lib.history.value.map((e) => e.track.id)).toEqual(['playing', 'old']);
    // Later loads replace it outright (nothing is merged twice).
    await lib.loadLibrary();
    expect(lib.history.value.map((e) => e.track.id)).toEqual(['playing', 'old']);
  });

  it('a like made before Liked was first read (the screen shows first) is kept on top and saved', async () => {
    vi.resetModules();
    files.clear();
    files.set(LIKED_FILE, JSON.stringify([track('a'), track('b')]));
    const lib = await import('./library');
    await lib.loadSettings();
    // The settings alone don't touch Liked.
    expect(lib.liked.value).toEqual([]);
    lib.toggleLike(track('new'));
    lib.toggleLike(track('b'));
    await lib.loadLists();
    expect(lib.liked.value.map((t) => t.id)).toEqual(['b', 'new', 'a']);
    await vi.waitFor(() => expect(JSON.parse(files.get(LIKED_FILE)!).map((t: Track) => t.id)).toEqual(['b', 'new', 'a']));
  });
});
