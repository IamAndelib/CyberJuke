import { signal } from '@preact/signals';
import { describe, expect, it, vi } from 'vitest';
import type { Track } from '../data/model';
import { createAutoplay, type AutoplayDeps } from './autoplay';
import { AUTOPLAY_FIRST, AUTOPLAY_MORE, EMPTY_STATE, type Player, type PlayerState, type QueueLow } from './types';

const track = (id: string, p: Partial<Track> = {}): Track => ({
  id,
  ytId: (id + '___________').slice(0, 11),
  title: id,
  artist: p.artist ?? `Artist ${id}`,
  genre: p.genre ?? 'house',
  by: 'p',
  postTitle: '',
  postUrl: '',
  createdAt: '2026-09-01T00:00:00Z',
  nsfw: false,
  artworkUrl: '',
  ...p,
});

function setup(state: Partial<PlayerState>, more: Partial<AutoplayDeps> = {}) {
  const s = signal<PlayerState>({ ...EMPTY_STATE, ...state });
  let low: ((e: QueueLow) => void) | null = null;
  const added: [string[], string][] = [];
  const player = {
    kind: 'web',
    state: s,
    addAutoplay: vi.fn(async (tracks: Track[], seedId: string) => void added.push([tracks.map((t) => t.id), seedId])),
    onQueueLow: (cb: (e: QueueLow) => void) => ((low = cb), () => (low = null)),
  } as unknown as Player;
  const catalog = Array.from({ length: 60 }, (_, i) => track(`c${i}`, { artist: `A${i % 15}` }));
  const radio = vi.fn(async (ytId: string, next?: string) => ({
    tracks: Array.from({ length: 4 }, (_, i) => track(`ytm:${ytId.slice(0, 4)}${next ?? 'p1'}${i}`, { source: 'ytmusic', genre: '' })),
    next: next ? undefined : 'tok2',
  }));
  const ap = createAutoplay({
    player,
    catalog: () => catalog,
    history: () => [],
    showNsfw: () => false,
    signedIn: () => false,
    blocked: () => false,
    radio,
    rng: () => 0.5,
    ...more,
  });
  return { ap, s, added, radio, player, signal: (e: QueueLow) => low?.(e) };
}

describe('autoplay', () => {
  it('fills a Jukebox seed from the catalog: 25 at first, 20 on a refill, nothing already queued', async () => {
    const seed = track('c0', { artist: 'A0' });
    const { ap, added, s } = setup({ current: seed, seed, queue: [seed, track('c1')], upNext: [] });
    await ap.fill({ left: 0, seedId: 'c0' });
    expect(added[0][0]).toHaveLength(AUTOPLAY_FIRST);
    expect(added[0][1]).toBe('c0');
    expect(added[0][0]).not.toContain('c0');
    expect(added[0][0]).not.toContain('c1');
    s.value = { ...s.value };
    await ap.fill({ left: 5, seedId: 'c0' });
    expect(added[1][0]).toHaveLength(AUTOPLAY_MORE);
  });

  it('a Global seed plays its radio, continuing from the last page', async () => {
    const seed = track('ytm:gseed', { source: 'ytmusic', genre: '' });
    const { ap, added, radio } = setup({ current: seed, seed, queue: [seed] });
    await ap.fill({ left: 0, seedId: seed.id });
    await ap.fill({ left: 3, seedId: seed.id });
    expect(radio).toHaveBeenNthCalledWith(1, seed.ytId, undefined);
    expect(radio).toHaveBeenNthCalledWith(2, seed.ytId, 'tok2');
    expect(added).toHaveLength(2);
    expect(added.every(([ids]) => ids.every((id) => id.startsWith('ytm:')))).toBe(true);
  });

  it('natively, Global radios are left to the playback service; none while blocked', async () => {
    const seed = track('ytm:gseed', { source: 'ytmusic', genre: '' });
    const a = setup({ current: seed, seed, queue: [seed] });
    (a.player as { kind: string }).kind = 'native';
    await a.ap.fill({ left: 0, seedId: seed.id });
    expect(a.radio).not.toHaveBeenCalled();
    const b = setup({ current: seed, seed, queue: [seed] }, { blocked: () => true });
    await b.ap.fill({ left: 0, seedId: seed.id });
    expect(b.radio).not.toHaveBeenCalled();
  });

  it('nothing with repeat on or for an old seed', async () => {
    const seed = track('c0');
    const { ap, added, s } = setup({ current: seed, seed, queue: [seed], repeat: 'all' });
    await ap.fill({ left: 0, seedId: 'c0' });
    s.value = { ...s.value, repeat: 'off' };
    await ap.fill({ left: 0, seedId: 'other' });
    expect(added).toHaveLength(0);
  });

  it('one refill at a time; a signal meanwhile runs after it', async () => {
    const seed = track('ytm:gseed', { source: 'ytmusic', genre: '' });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const radio = vi.fn(async () => {
      await gate;
      return { tracks: [track('ytm:x', { source: 'ytmusic' })] };
    });
    const { ap, signal: low } = setup({ current: seed, seed, queue: [seed] }, { radio });
    const first = ap.fill({ left: 0, seedId: seed.id });
    low({ left: 0, seedId: seed.id });
    low({ left: 0, seedId: seed.id });
    expect(radio).toHaveBeenCalledTimes(1);
    release();
    await first;
    await vi.waitFor(() => expect(radio).toHaveBeenCalledTimes(2));
  });
});
