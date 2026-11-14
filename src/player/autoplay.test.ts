import { signal } from '@preact/signals';
import { describe, expect, it, vi } from 'vitest';
import type { Track } from '../data/model';
import { chainsOn, createAutoplay, shuffleLabel, type AutoplayDeps } from './autoplay';
import { STATIONS, stationById, stationLabel, stationOfTrackId, stationTracks } from './radio';
import { EMPTY_STATE, VIBE_BATCH, type Player, type PlayerState, type QueueLow } from './types';

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
  it('fills a Jukebox seed from the catalog: a batch of 25 on the way, nothing already queued; the next once that one starts', async () => {
    const seed = track('c0', { artist: 'A0' });
    const list = [seed, track('c1')];
    const { ap, added, s } = setup({ current: seed, seed, queue: list, upNext: [] });
    await ap.fill({ left: 1, seedId: 'c0' });
    expect(added[0][0]).toHaveLength(VIBE_BATCH);
    expect(added[0][1]).toBe('c0');
    expect(added[0][0]).not.toContain('c0');
    expect(added[0][0]).not.toContain('c1');
    // The player shows them on the way: nothing more, however few songs are left.
    const picked = added[0][0].map((id) => track(id));
    const queue = [...list, ...picked];
    s.value = { ...s.value, queue, index: 1, current: list[1], nextStart: 2, upNext: picked.map((t, k) => ({ track: t, index: 2 + k, auto: true })) };
    await ap.fill({ left: 25, seedId: 'c0' });
    expect(added).toHaveLength(1);
    // Moved on into it: nothing on the way, so the next batch, without repeats.
    s.value = { ...s.value, index: 2, current: picked[0], listStart: 2, nextStart: -1, upNext: s.value.upNext.slice(1) };
    await ap.fill({ left: 24, seedId: 'c0' });
    expect(added[1][0]).toHaveLength(VIBE_BATCH);
    expect(added[1][0].filter((id) => queue.some((t) => t.id === id))).toEqual([]);
  });

  it("a Home or Search tap's first batch is 24, joined to the tapped song; the next 25 then come on the way", async () => {
    const seed = track('c0', { artist: 'A0' });
    const context = { label: 'Home · Latest', mode: 'radio' as const };
    const { ap, added, s } = setup({ current: seed, seed, index: 0, queue: [seed], context });
    await ap.fill({ left: 0, seedId: 'c0' });
    expect(added[0][0]).toHaveLength(VIBE_BATCH - 1);
    // Joined: still nothing on the way.
    const picked = added[0][0].map((id) => track(id));
    s.value = { ...s.value, queue: [seed, ...picked], upNext: picked.map((t, k) => ({ track: t, index: 1 + k, auto: true })) };
    await ap.fill({ left: 24, seedId: 'c0' });
    expect(added[1][0]).toHaveLength(VIBE_BATCH);
    expect(added[1][0].filter((id) => id === 'c0' || added[0][0].includes(id))).toEqual([]);
  });

  it("a signal that came before the player's state (a reloaded page) is answered once it is there", async () => {
    const { ap, added, s } = setup({});
    await ap.fill({ left: 0, seedId: 'c0' });
    expect(added).toHaveLength(0);
    const seed = track('c0', { artist: 'A0' });
    s.value = { ...s.value, current: seed, seed, queue: [seed] };
    ap.ready();
    await vi.waitFor(() => expect(added).toHaveLength(1));
    expect(added[0][0]).toHaveLength(VIBE_BATCH);
  });

  it('going to the background adds nothing: the next batch is on the way already, from the start of the list', async () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('document', doc);
    try {
      const list = Array.from({ length: 12 }, (_, i) => track(`c${i}`, { artist: `A${i}` }));
      const { added } = setup({ current: list[0], seed: list[0], index: 0, queue: list, upNext: list.slice(1).map((t, k) => ({ track: t, index: k + 1 })) });
      doc.visibilityState = 'hidden';
      doc.dispatchEvent(new Event('visibilitychange'));
      await new Promise((r) => setTimeout(r));
      expect(added).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('never picks a track removed from Up next this session', async () => {
    const seed = track('c0', { artist: 'A0' });
    const removed = new Set(Array.from({ length: 40 }, (_, i) => `c${i + 1}`));
    const { ap, added } = setup({ current: seed, seed, queue: [seed], upNext: [] }, { removed: () => removed });
    await ap.fill({ left: 0, seedId: 'c0' });
    expect(added[0][0].length).toBeGreaterThan(0);
    expect(added[0][0].some((id) => removed.has(id))).toBe(false);
  });

  it('offline, picks only songs saved on the phone', async () => {
    const seed = track('c0', { artist: 'A0' });
    const saved = new Set(['c3', 'c7', 'c12']);
    const { ap, added } = setup({ current: seed, seed, queue: [seed], upNext: [] }, { playable: (t) => saved.has(t.id) });
    await ap.fill({ left: 0, seedId: 'c0' });
    expect([...added[0][0]].sort()).toEqual(['c12', 'c3', 'c7']);
  });

  it('a list gets its batch on the way from its start, with all of it still to go (rule 2)', async () => {
    const list = Array.from({ length: 8 }, (_, i) => track(`c${i}`, { artist: `A${i}` }));
    const { ap, added } = setup({ current: list[0], seed: list[0], index: 0, queue: list, upNext: list.slice(1).map((t, k) => ({ track: t, index: 1 + k })) });
    await ap.fill({ left: 7, seedId: 'c0' });
    expect(added[0][0]).toHaveLength(VIBE_BATCH);
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
    expect(added[0][0]).toHaveLength(VIBE_BATCH);
    // Answered once: another ready signal adds nothing more.
    ap.ready();
    await Promise.resolve();
    expect(added).toHaveLength(1);
  });

  it("a signal from before the state shows the last batch waits for it: no second batch of the same songs, and the next comes once it shows", async () => {
    const seed = track('c0', { artist: 'A0' });
    const context = { label: 'Home · Latest', mode: 'radio' as const };
    const { ap, added, s, player } = setup({ current: seed, seed, queue: [seed], upNext: [], context });
    // Natively the call resolves before the state event with the new queue.
    let release: () => void = () => {};
    vi.mocked(player.addAutoplay).mockImplementation(async (tracks: Track[], seedId: string) => {
      added.push([tracks.map((t) => t.id), seedId]);
      await new Promise<void>((r) => (release = r));
    });
    const first = ap.fill({ left: 0, seedId: 'c0' });
    void ap.fill({ left: 24, seedId: 'c0' }); // native asks again once the first batch has joined the list
    await vi.waitFor(() => expect(added).toHaveLength(1));
    release();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(added).toHaveLength(1);
    // The state shows the batch, joined: the waiting signal gets the next one, on the way, without repeats.
    const picked = added[0][0].map((id) => track(id));
    s.value = { ...s.value, queue: [seed, ...picked], upNext: picked.map((t, k) => ({ track: t, index: 1 + k, auto: true })) };
    await vi.waitFor(() => expect(added).toHaveLength(2));
    release();
    expect(added[1][0]).toHaveLength(VIBE_BATCH);
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

  it('refills reuse one similarity index: the catalog itself goes to similarTracks while every song plays', async () => {
    const seed = track('c0', { artist: 'A0' });
    const { ap, s } = setup({ current: seed, seed, queue: [seed], upNext: [] });
    const spy = await import('../data/similar');
    const calls = vi.spyOn(spy, 'similarTracks');
    await ap.fill({ left: 0, seedId: 'c0' });
    s.value = { ...s.value, queue: [seed, track('c1')] };
    await ap.fill({ left: 3, seedId: 'c0' });
    expect(calls).toHaveBeenCalledTimes(2);
    expect(calls.mock.calls[1][0]).toBe(calls.mock.calls[0][0]);
    calls.mockRestore();
  });

  it('a Global seed plays its radio, a page a batch, continuing from the last page once that one starts', async () => {
    const seed = track('ytm:gseed', { source: 'ytmusic', genre: '' });
    const { ap, added, radio, s } = setup({ current: seed, seed, queue: [seed] });
    await ap.fill({ left: 0, seedId: seed.id });
    const page = added[0][0].map((id) => track(id));
    s.value = { ...s.value, queue: [seed, ...page], index: 0, nextStart: 1 };
    await ap.fill({ left: 4, seedId: seed.id });
    expect(radio).toHaveBeenCalledTimes(1);
    s.value = { ...s.value, index: 1, current: page[0], listStart: 1, nextStart: -1 };
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

  const tracksOf = (id: string) => [...stationTracks(stationById(id)!)];
  const idsOf = (id: string) => tracksOf(id).map((t) => t.id);
  /** A station's list playing from its first song (tuned in, or moved on to in the chain); the label is the one tuned in. */
  function onStation(id: string, more: Partial<PlayerState> = {}, deps: Partial<AutoplayDeps> = {}) {
    const list = tracksOf(id);
    const a = setup({ current: list[0], seed: list[0], index: 0, queue: list, upNext: list.slice(1).map((t, i) => ({ track: t, index: 1 + i })), context: { label: stationLabel(stationById('cipher')!), mode: 'list' }, ...more }, deps);
    return { ...a, list };
  }
  /** A small Preferences double. */
  const memoryKv = () => {
    const m = new Map<string, string>();
    return { m, get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v), remove: async (k: string) => void m.delete(k) };
  };

  it('a Signal Radio station leads on to the next station, all of it in its listed order, on the way from its start, natively too, never Global radio or the catalog', async () => {
    const a = onStation('cipher');
    (a.player as { kind: string }).kind = 'native';
    await a.ap.fill({ left: a.list.length - 1, seedId: a.list[0].id });
    expect(a.added).toEqual([[idsOf('distortion-field'), a.list[0].id]]);
    expect(a.radio).not.toHaveBeenCalled();
    // Asked again before the state shows it (native lags the call): nothing more.
    await a.ap.fill({ left: a.list.length - 1, seedId: a.list[0].id });
    expect(a.added).toHaveLength(1);
  });

  it('the chain goes on from the station of the song playing, not the one tuned in (the label), and wraps after the last', async () => {
    const last = STATIONS.at(-1)!;
    // Tuned in to CIPHER (the label and the seed), the chain has moved on to the last station.
    const a = onStation('cipher');
    const now = tracksOf(last.id);
    a.s.value = { ...a.s.value, queue: [...a.list, ...now], index: a.list.length, current: now[0], listStart: a.list.length, nextStart: -1, upNext: [] };
    await a.ap.fill({ left: now.length - 1, seedId: a.list[0].id });
    expect(a.added[0][0]).toEqual(idsOf(STATIONS[0].id));
  });

  it("the chain goes on from the current list's station: back on the station before with Previous, or with a song you queued playing", async () => {
    const crypt = tracksOf('the-crypt');
    const mirror = tracksOf('mirrorball');
    const queue = [...crypt, ...mirror];
    // MIRRORBALL is the current list; Previous went back to THE CRYPT's last song (rule 7).
    const a = onStation('the-crypt');
    a.s.value = { ...a.s.value, queue, index: crypt.length - 1, current: crypt.at(-1)!, listStart: crypt.length, nextStart: -1 };
    await a.ap.fill({ left: 0, seedId: crypt[0].id });
    expect(a.added[0][0]).toEqual(idsOf('slow-orbit'));
    // A Jukebox song you queued plays: still MIRRORBALL's next, not the next after THE CRYPT.
    const mine = track('c7');
    const b = onStation('the-crypt');
    b.s.value = { ...b.s.value, queue: [...crypt, mirror[0], mine, ...mirror.slice(1)], index: crypt.length + 1, current: mine, listStart: crypt.length, nextStart: -1 };
    await b.ap.fill({ left: 0, seedId: crypt[0].id });
    expect(b.added[0][0]).toEqual(idsOf('slow-orbit'));
    // A station song you queued (from Liked) after MIRRORBALL's last: still MIRRORBALL's next.
    const liked = tracksOf('cipher')[3];
    const c = onStation('the-crypt');
    c.s.value = { ...c.s.value, queue: [...crypt, ...mirror, liked], index: queue.length - 1, current: mirror.at(-1)!, listStart: crypt.length, nextStart: -1, mine: [queue.length] };
    await c.ap.fill({ left: 1, seedId: crypt[0].id });
    expect(c.added[0][0]).toEqual(idsOf('slow-orbit'));
  });

  it("shuffled, a tap on the next station's row brings the current station's unheard songs to the new list's start: the chain still goes on from the station tapped, heard", async () => {
    const store = memoryKv();
    const crypt = tracksOf('the-crypt');
    const a = onStation('the-crypt', { shuffle: true }, { store, rng: () => 0 });
    await a.ap.fill({ left: 0, seedId: crypt[0].id });
    const next = stationOfTrackId(a.added[0][0][0])!;
    const way = tracksOf(next.id);
    // The 3rd song of the station on the way tapped while THE CRYPT's 5th played: THE CRYPT's 27
    // unheard songs came along and start the new list (rule 2), the song tapped plays.
    a.s.value = { ...a.s.value, queue: [...crypt, ...way], index: crypt.length + 2, current: way[2], listStart: 5, nextStart: -1, upNext: [] };
    await a.ap.fill({ left: 0, seedId: crypt[0].id });
    expect(stationOfTrackId(a.added[1][0][0])).not.toBe(next);
    expect(JSON.parse(store.m.get('radio.heard')!)).toEqual(['the-crypt', next.id]);
  });

  it('a station that comes round again (its songs already in the queue) is added once: a signal from before the state shows it waits', async () => {
    const before = tracksOf('distortion-field');
    const a = onStation('cipher');
    a.s.value = { ...a.s.value, queue: [...before, ...a.list], index: before.length, listStart: before.length };
    await a.ap.fill({ left: 0, seedId: a.list[0].id });
    await a.ap.fill({ left: 0, seedId: a.list[0].id });
    expect(a.added).toEqual([[before.map((t) => t.id), a.list[0].id]]);
  });

  it('with shuffle, a random station not heard yet in this chain; kept with the session, until a station is tuned in', async () => {
    const store = memoryKv();
    let r = 0;
    const rng = () => [0, 0.99][r++ % 2];
    const a = onStation('cipher', { shuffle: true }, { store, rng });
    await a.ap.fill({ left: 0, seedId: a.list[0].id });
    // The first not heard (rng 0): DISTORTION FIELD, all of it (the player mixes it on arrival).
    expect(a.added[0][0]).toEqual(idsOf('distortion-field'));
    // Moved on into it: the last not heard (rng 0.99).
    const df = tracksOf('distortion-field');
    a.s.value = { ...a.s.value, queue: [...a.list, ...df], index: a.list.length, current: df[0], listStart: a.list.length, nextStart: -1 };
    await a.ap.fill({ left: 0, seedId: a.list[0].id });
    expect(a.added[1][0]).toEqual(idsOf(STATIONS.at(-1)!.id));
    // A restart keeps what was heard: CIPHER and DISTORTION FIELD don't come again.
    const b = onStation('circuit-crush', { shuffle: true }, { store, rng: () => 0 });
    await b.ap.fill({ left: 0, seedId: b.list[0].id });
    expect(b.added[0][0]).toEqual(idsOf('cold-wave'));
    // Tuned in again: every station is new again.
    b.ap.newStationChain();
    b.s.value = { ...b.s.value, nextStart: -1, queue: [...b.list] };
    await b.ap.fill({ left: 1, seedId: b.list[0].id });
    expect(b.added[1][0]).toEqual(idsOf('cipher'));
  });

  it('with shuffle, once all 16 have been heard, a new random order of them: any but the one playing', async () => {
    const store = memoryKv();
    store.m.set('radio.heard', JSON.stringify(STATIONS.map((s) => s.id).filter((id) => id !== 'cipher')));
    const a = onStation('cipher', { shuffle: true }, { store, rng: () => 0 });
    await a.ap.fill({ left: 0, seedId: a.list[0].id });
    expect(a.added[0][0]).toEqual(idsOf('distortion-field'));
    expect(JSON.parse(store.m.get('radio.heard')!)).toEqual(['cipher']);
  });

  it('the next station dropped (Repeat all on, then off) comes back the same, shuffle or not', async () => {
    let r = 0.1;
    const a = onStation('cipher', { shuffle: true }, { rng: () => (r += 0.3) % 1 });
    await a.ap.fill({ left: 0, seedId: a.list[0].id });
    a.s.value = { ...a.s.value, queue: [...a.list] };
    await a.ap.fill({ left: 1, seedId: a.list[0].id });
    expect(a.added).toHaveLength(2);
    expect(a.added[1][0]).toEqual(a.added[0][0]);
  });

  it('offline, the next station with a saved song, all of it (Next skips the unsaved ones); none, nothing', async () => {
    const cw = idsOf('cold-wave');
    // DISTORTION FIELD has nothing saved: COLD WAVE, with its unsaved songs too.
    const a = onStation('cipher', {}, { playable: (t) => t.id === cw[3] });
    await a.ap.fill({ left: 0, seedId: a.list[0].id });
    expect(a.added[0][0]).toEqual(cw);
    const b = onStation('cipher', {}, { playable: (t) => t.id.startsWith('sig:cipher:') });
    await b.ap.fill({ left: 0, seedId: b.list[0].id });
    expect(b.added).toEqual([]);
  });

  it('with repeat all, a station loops: no next station', async () => {
    const a = onStation('cipher', { repeat: 'all' });
    await a.ap.fill({ left: 0, seedId: a.list[0].id });
    expect(a.added).toEqual([]);
  });

  it("a station's track in another list (Recently played) gets similar picks, not the next station", async () => {
    const seed = tracksOf('cold-wave')[0];
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
    await ap.fill({ left: 9, seedId: seed.id });
    // Up to a batch of 25: the 20 left.
    expect(added[0][0]).toHaveLength(20);
    expect(new Set(added[0][0])).toEqual(new Set(rock.slice(10).map((t) => t.id)));
  });

  it("Home's Jukebox shuffle goes on with random songs from the whole catalog, past the variety rules of similar picks", async () => {
    // One artist only: similar picks would hold back on playing them all in a row.
    const cat = Array.from({ length: VIBE_BATCH + 1 }, (_, i) => track(`a${i}`, { artist: 'A' }));
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

  it('with repeat all, nothing is added, not even for a single song: it loops the list you are in', async () => {
    const seed = track('c0', { artist: 'A0' });
    const { ap, added } = setup({ current: seed, seed, queue: [seed], repeat: 'all' });
    await ap.fill({ left: 0, seedId: 'c0' });
    expect(added).toHaveLength(0);
  });

  it("with repeat all, a radio's first batch still comes, with a song you queued before the tap", async () => {
    const seed = track('c0', { artist: 'A0' });
    const q = track('q0');
    const { ap, added } = setup({ current: seed, seed, queue: [seed, q], upNext: [{ track: q, index: 1, queued: true }], repeat: 'all', context: { label: 'Home · Latest', mode: 'radio' } });
    await ap.fill({ left: 1, seedId: 'c0' });
    expect(added).toHaveLength(1);
  });

  it('repeat one adds as repeat off does; an old seed gets nothing', async () => {
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

  it('one refill at a time; a signal meanwhile runs after it, once the state shows the first one', async () => {
    const seed = track('ytm:gseed', { source: 'ytmusic', genre: '' });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const radio = vi.fn(async () => {
      await gate;
      return { tracks: [track('ytm:x', { source: 'ytmusic' })] };
    });
    const { ap, s, signal: low } = setup({ current: seed, seed, queue: [seed] }, { radio });
    const first = ap.fill({ left: 0, seedId: seed.id });
    low({ left: 0, seedId: seed.id });
    low({ left: 0, seedId: seed.id });
    expect(radio).toHaveBeenCalledTimes(1);
    release();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(radio).toHaveBeenCalledTimes(1);
    // The state shows it, nothing on the way (as a radio's first batch, joined): the waiting signal asks for the next.
    s.value = { ...s.value, queue: [seed, track('ytm:x', { source: 'ytmusic' })] };
    await vi.waitFor(() => expect(radio).toHaveBeenCalledTimes(2));
  });
  it('a local song as the seed gets nothing: a local list ends like an album', async () => {
    const seed = track('loc:0123456789abcdef', { ytId: '', source: 'local' });
    const { ap, added } = setup({ current: seed, seed, queue: [seed], upNext: [] });
    await ap.fill({ left: 0, seedId: seed.id });
    expect(added).toEqual([]);
  });
});

describe('chainsOn', () => {
  it('is true for a Jukebox shuffle, whole or one genre, whatever the seed', () => {
    expect(chainsOn({ label: shuffleLabel(null) }, 'p1')).toBe(true);
    expect(chainsOn({ label: shuffleLabel('rock') }, 'p1')).toBe(true);
  });

  it('is true for a station playing, false for its track in another list or any other list', () => {
    expect(chainsOn({ label: 'Signal Radio · CIPHER' }, 'sig:cipher:abc')).toBe(true);
    // The chain moved on: the seed is another station's (a tapped row on the way), the label the one tuned in.
    expect(chainsOn({ label: 'Signal Radio · CIPHER' }, 'sig:cold-wave:abc')).toBe(true);
    expect(chainsOn({ label: 'Signal Radio · CIPHER' }, 'p1')).toBe(false);
    expect(chainsOn({ label: 'Liked' }, 'sig:cipher:abc')).toBe(false);
    expect(chainsOn({ label: 'Liked' }, 'p1')).toBe(false);
    expect(chainsOn(null, 'p1')).toBe(false);
  });
});
