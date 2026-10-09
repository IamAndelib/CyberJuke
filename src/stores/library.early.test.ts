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

const track = (id: string): Track => ({
  id, ytId: `${id}__________`.slice(0, 11), title: id, artist: 'A', genre: 'house', by: 'p',
  postTitle: '', postUrl: '', createdAt: '2026-09-01T00:00:00Z', nsfw: false, artworkUrl: '',
});

describe('history at startup', () => {
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
});
