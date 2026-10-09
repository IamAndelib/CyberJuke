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
    // The player shows them; 5 are left when it asks again.
    const picked = added[0][0].map((id) => track(id));
    s.value = { ...s.value, queue: [seed, track('c1'), ...picked], upNext: picked.slice(-5).map((t, k) => ({ track: t, index: 22 + k, auto: true })) };
    await ap.fill({ left: 5, seedId: 'c0' });
    expect(added[1][0]).toHaveLength(AUTOPLAY_MORE);
  });

  it('a low signal from during a refill is counted again: no second batch while the first is ahead, even before the state shows it', async () => {
    const seed = track('c0', { artist: 'A0' });
    const { ap, added, s, player } = setup({ current: seed, seed, queue: [seed], upNext: [] });
    // Natively the call resolves before the state event with the new queue.
    let release: () => void = () => {};
    vi.mocked(player.addAutoplay).mockImplementation(async (tracks: Track[], seedId: string) => {
      added.push([tracks.map((t) => t.id), seedId]);
      await new Promise<void>((r) => (release = r));
    });
    const first = ap.fill({ left: 0, seedId: 'c0' });
    void ap.fill({ left: 0, seedId: 'c0' }); // e.g. Add to queue meanwhile: native signals again
    await vi.waitFor(() => expect(added).toHaveLength(1));
    release();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    release();
    expect(added).toHaveLength(1);
    // Once the state shows the batch and it has run low, a refill goes ahead, without repeats.
    const picked = added[0][0].map((id) => track(id));
    s.value = { ...s.value, queue: [seed, ...picked], index: 20, current: picked[19], upNext: picked.slice(20).map((t, k) => ({ track: t, index: 21 + k, auto: true })) };
    const again = ap.fill({ left: 5, seedId: 'c0' });
    await vi.waitFor(() => expect(added).toHaveLength(2));
    release();
    await again;
    expect(added[1][0].filter((id) => added[0][0].includes(id))).toEqual([]);
  });

  it('a batch the player dropped (repeat on and off again) does not hold up the next one', async () => {
    const seed = track('c0', { artist: 'A0' });
    const { ap, added, s } = setup({ current: seed, seed, queue: [seed], upNext: [] });
    await ap.fill({ left: 0, seedId: 'c0' });
    // The state showed the batch, then repeat dropped it: a new list without it.
    s.value = { ...s.value, queue: [seed] };
    await ap.fill({ left: 0, seedId: 'c0' });
    expect(added).toHaveLength(2);
  });

  it('the seed drifts only with what played since it started', async () => {
    const seed = track('c0', { artist: 'A0' });
    const before = track('old', { artist: 'Elsewhere', genre: 'techno' });
    const since = track('c7', { artist: 'A7' });
    const history = vi.fn(() => [since, seed, before]);
    const { ap, added } = setup({ current: since, seed, index: 2, queue: [before, seed, since], upNext: [] }, { history });
    const spy = await import('../data/similar');
    const calls = vi.spyOn(spy, 'similarTracks');
    await ap.fill({ left: 0, seedId: 'c0' });
    expect(added).toHaveLength(1);
    expect(calls.mock.calls[0][1].played?.map((t) => t.id)).toEqual(['c7']);
    calls.mockRestore();
  });

  it('a Global seed plays its radio, continuing from the last page', async () => {
    const seed = track('ytm:gseed', { source: 'ytmusic', genre: '' });
    const { ap, added, radio, s } = setup({ current: seed, seed, queue: [seed] });
    await ap.fill({ left: 0, seedId: seed.id });
    s.value = { ...s.value, queue: [seed, ...added[0][0].map((id) => track(id))] };
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
