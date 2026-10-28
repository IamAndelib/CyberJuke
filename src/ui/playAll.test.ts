import { describe, expect, it, vi } from 'vitest';
import type { Track } from '../data/model';

const calls = vi.hoisted(() => [] as string[]);
vi.mock('../player', () => ({
  playableNow: (ts: Track[]) => ts,
  player: {
    playList: vi.fn(() => {
      calls.push('list');
      return Promise.resolve();
    }),
    // Shuffle's answer never comes: Play must not wait for it to send the list.
    setShuffle: vi.fn((on: boolean) => {
      calls.push(`shuffle:${on}`);
      return new Promise(() => {});
    }),
  },
}));

const { playAll } = await import('./playAll');

describe('playAll', () => {
  it('Play sends shuffle off and the list together, not waiting for the first answer', async () => {
    const t = { id: 'a', ytId: 'aaaaaaaaaaa', title: 'A', artist: 'X' } as Track;
    void playAll([t], { shuffle: false, ctx: { label: 'L', mode: 'list' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls[0]).toBe('shuffle:false');
    expect(calls).toContain('list');
  });
});
