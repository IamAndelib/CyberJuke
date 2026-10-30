import { signal } from '@preact/signals';
import { describe, expect, it, vi } from 'vitest';
import type { Track } from '../data/model';
import { createAutoplay, shuffleLabel, type AutoplayDeps } from './autoplay';
import { AUTOPLAY_FIRST, AUTOPLAY_MORE, AUTOPLAY_RESERVE, EMPTY_STATE, type Player, type PlayerState, type QueueLow } from './types';

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

  it("a signal that came before the player's state (a reloaded page) is answered once it is there", async () => {
    const { ap, added, s } = setup({});
    await ap.fill({ left: 0, seedId: 'c0' });
    expect(added).toHaveLength(0);
    const seed = track('c0', { artist: 'A0' });
    s.value = { ...s.value, current: seed, seed, queue: [seed] };
    ap.ready();
    await vi.waitFor(() => expect(added).toHaveLength(1));
    expect(added[0][0]).toHaveLength(AUTOPLAY_FIRST);
  });

  it('going to the background, it lines up a reserve: the page may be gone when the list runs low', async () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('document', doc);
    try {
      const list = Array.from({ length: 12 }, (_, i) => track(`c${i}`, { artist: `A${i}` }));
      const { added } = setup({ current: list[0], seed: list[0], index: 0, queue: list, upNext: list.slice(1).map((t, k) => ({ track: t, index: k + 1 })) });
      doc.dispatchEvent(new Event('visibilitychange'));
      expect(added).toHaveLength(0);
      doc.visibilityState = 'hidden';
      doc.dispatchEvent(new Event('visibilitychange'));
      await vi.waitFor(() => expect(added).toHaveLength(1));
      // 11 of the list to go: 39 more, for 50 ahead.
      expect(added[0][0]).toHaveLength(AUTOPLAY_RESERVE - 11);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a list gets more only near its end: with more than 5 tracks of it to go, nothing yet', async () => {
    const list = Array.from({ length: 8 }, (_, i) => track(`c${i}`, { artist: `A${i}` }));
    const at = (i: number) => ({ current: list[i], seed: list[0], index: i, queue: list, upNext: list.slice(i + 1).map((t, k) => ({ track: t, index: i + 1 + k })) });
    const { ap, added, s } = setup(at(0));
    await ap.fill({ left: 0, seedId: 'c0' });
    expect(added).toHaveLength(0);
    // 5 to go: more follows the list.
    s.value = { ...s.value, ...at(2) };
    await ap.fill({ left: 5, seedId: 'c0' });
    expect(added[0][0]).toHaveLength(AUTOPLAY_MORE);
    expect(added[0][0].some((id) => list.some((t) => t.id === id))).toBe(false);
  });

  it('a signal that came before the catalog loaded is answered once it has (the player asks only once)', async () => {
    const seed = track('c0', { artist: 'A0' });
    let cat: Track[] = [];
    const full = Array.from({ length: 60 }, (_, i) => track(`c${i}`, { artist: `A${i % 15}` }));
    const { ap, added } = setup({ current: seed, seed, queue: [seed], upNext: [] }, { catalog: () => cat });
    await ap.fill({ left: 0, seedId: 'c0' });
    expect(added).toHaveLength(0);
    cat = full;
    ap.ready();
    await vi.waitFor(() => expect(added).toHaveLength(1));
    expect(added[0][0]).toHaveLength(AUTOPLAY_FIRST);
    // Answered once: another ready signal adds nothing more.
    ap.ready();
    await Promise.resolve();
    expect(added).toHaveLength(1);
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

  it('a Signal Radio station goes on with the next round of its station, natively too, never with Global radio or the catalog', async () => {
    const { stationById, stationLabel, stationTracks } = await import('./radio');
    const st = stationById('cold-wave')!;
    const round = stationTracks(st);
    const seed = round[0];
    const last = round.at(-1)!;
    // Near the end of the round (3 to go), the next one comes.
    const at = round.length - 4;
    const a = setup({ current: round[at], seed, index: at, queue: [...round], upNext: round.slice(at + 1).map((t, i) => ({ track: t, index: at + 1 + i })), context: { label: stationLabel(st), mode: 'list' } });
    (a.player as { kind: string }).kind = 'native';
    await a.ap.fill({ left: 3, seedId: seed.id });
    expect(a.added).toHaveLength(1);
    const [ids, seedId] = a.added[0];
    expect(seedId).toBe(seed.id);
    expect([...ids].sort()).toEqual(round.map((t) => t.id).sort());
    expect(ids[0]).not.toBe(last.id);
    expect(a.radio).not.toHaveBeenCalled();
    // Asked again before the state shows the round (native lags the call): nothing more.
    await a.ap.fill({ left: 3, seedId: seed.id });
    expect(a.added).toHaveLength(1);
    // The state shows it, and it has run low: the round after that.
    const next = ids.map((id) => round.find((t) => t.id === id)!);
    a.s.value = { ...a.s.value, queue: [...round, ...next], index: round.length + next.length - 4, upNext: next.slice(-3).map((t, k) => ({ track: t, index: round.length + next.length - 3 + k, auto: true })) };
    await a.ap.fill({ left: 3, seedId: seed.id });
    expect(a.added).toHaveLength(2);
    expect(a.added[1][0]).toHaveLength(round.length);
    expect(a.added[1][0][0]).not.toBe(next.at(-1)!.id);
  });

  it("a station's track in another list (Recently played) gets similar picks, not the station's rounds", async () => {
    const { stationById, stationTracks } = await import('./radio');
    const seed = stationTracks(stationById('cold-wave')!)[0];
    const a = setup({ current: seed, seed, index: 0, queue: [seed], context: { label: 'Recently played', mode: 'list' } });
    await a.ap.fill({ left: 0, seedId: seed.id });
    for (const [ids] of a.added) expect(ids.some((id) => id.startsWith('sig:'))).toBe(false);
  });

  it("Home's genre shuffle goes on with random songs of that genre not yet queued, not similar ones", async () => {
    const rock = Array.from({ length: 30 }, (_, i) => track(`r${i}`, { genre: 'rock', artist: 'A' }));
    const house = Array.from({ length: 30 }, (_, i) => track(`h${i}`, { genre: 'house', artist: 'A' }));
    const seed = rock[0];
    const queue = rock.slice(0, 10);
    const { ap, added } = setup({ current: seed, seed, index: 0, queue, context: { label: shuffleLabel('rock'), mode: 'list' } }, { catalog: () => [...rock, ...house] });
    await ap.fill({ left: 0, seedId: seed.id });
    expect(added[0][0]).toHaveLength(20);
    expect(new Set(added[0][0])).toEqual(new Set(rock.slice(10).map((t) => t.id)));
  });

  it("Home's Jukebox shuffle goes on with random songs from the whole catalog, past the variety rules of similar picks", async () => {
    // One artist only: similar picks would hold back on playing them all in a row.
    const cat = Array.from({ length: AUTOPLAY_FIRST + 1 }, (_, i) => track(`a${i}`, { artist: 'A' }));
    const { ap, added } = setup({ current: cat[0], seed: cat[0], index: 0, queue: [cat[0]], context: { label: shuffleLabel(null), mode: 'list' } }, { catalog: () => cat });
    await ap.fill({ left: 0, seedId: 'a0' });
    expect(new Set(added[0][0])).toEqual(new Set(cat.slice(1).map((t) => t.id)));
  });

  it("once a shuffle's whole pool is queued, another round of it, without the song just queued (and no members-only songs signed out)", async () => {
    const rock = Array.from({ length: 5 }, (_, i) => track(`r${i}`, { genre: 'rock' }));
    const members = track('m0', { genre: 'rock', membersOnly: true });
    const { ap, added } = setup({ current: rock[0], seed: rock[0], index: 0, queue: rock, context: { label: shuffleLabel('rock'), mode: 'list' } }, { catalog: () => [...rock, members] });
    await ap.fill({ left: 0, seedId: 'r0' });
    expect([...added[0][0]].sort()).toEqual(['r0', 'r1', 'r2', 'r3']);
  });

  it('with repeat all, a single song still gets its first batch: its radio, for repeat to loop', async () => {
    const seed = track('c0', { artist: 'A0' });
    const { ap, added } = setup({ current: seed, seed, queue: [seed], repeat: 'all' });
    await ap.fill({ left: 0, seedId: 'c0' });
    expect(added[0][0]).toHaveLength(AUTOPLAY_FIRST);
  });

  it('repeat one adds as repeat off does; repeat all with more lined up and an old seed get nothing', async () => {
    const seed = track('c0');
    const one = setup({ current: seed, seed, queue: [seed, track('c1')], repeat: 'one' });
    await one.ap.fill({ left: 1, seedId: 'c0' });
    expect(one.added).toHaveLength(1);
    const { ap, added, s } = setup({ current: seed, seed, queue: [seed, track('c1')], repeat: 'all' });
    await ap.fill({ left: 1, seedId: 'c0' });
    s.value = { ...s.value, repeat: 'off' };
    await ap.fill({ left: 1, seedId: 'other' });
    expect(added).toHaveLength(0);
  });

  it("the player's low signal is answered once the app is idle, not on the tap that started the list", async () => {
    const idle: (() => void)[] = [];
    vi.stubGlobal('requestIdleCallback', (cb: () => void) => idle.push(cb));
    try {
      const seed = track('c0', { artist: 'A0' });
      const { added, signal: low } = setup({ current: seed, seed, queue: [seed], upNext: [] });
      low({ left: 0, seedId: 'c0' });
      await new Promise((r) => setTimeout(r));
      expect(added).toHaveLength(0);
      idle.forEach((cb) => cb());
      await vi.waitFor(() => expect(added).toHaveLength(1));
      // With the screen off, at once: a hidden page's idle time may be throttled.
      vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'hidden' }));
      const hidden = setup({ current: seed, seed, queue: [seed], upNext: [] });
      hidden.signal({ left: 0, seedId: 'c0' });
      await vi.waitFor(() => expect(hidden.added).toHaveLength(1));
      expect(idle).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
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
