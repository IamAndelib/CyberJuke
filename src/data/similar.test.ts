import { describe, expect, it } from 'vitest';
import type { Track } from './model';
import { genreFamilies, MAX_PER_ARTIST, similarIndex, similarTracks, VARIETY_WINDOW, type SimilarOptions } from './similar';

let n = 0;
function track(p: Partial<Track> & { artist: string }): Track {
  n++;
  const id = p.id ?? `t${n}`;
  return {
    id,
    ytId: p.ytId ?? (`yt${String(n).padStart(9, '0')}`).slice(0, 11),
    title: p.title ?? `Song ${n}`,
    artist: p.artist,
    genre: p.genre ?? '',
    by: p.by ?? 'someone',
    postTitle: '',
    postUrl: '',
    createdAt: p.createdAt ?? '2026-09-01T00:00:00Z',
    nsfw: p.nsfw ?? false,
    artworkUrl: '',
    ...(p.saves !== undefined && { saves: p.saves }),
    ...(p.membersOnly && { membersOnly: true }),
    ...(p.source && { source: p.source }),
  };
}

/** Deterministic PRNG. */
function seeded(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x80000000;
  };
}

const opts = (seed: Track, more: Partial<SimilarOptions> = {}): SimilarOptions => ({
  seed,
  count: 10,
  showNsfw: false,
  signedIn: false,
  rng: seeded(),
  now: Date.parse('2026-10-08T00:00:00Z'),
  ...more,
});

/** A catalog with a clear structure: shoegaze (Slowdive-ish), techno, and a long tail. */
function catalog() {
  n = 0;
  const seed = track({ id: 'seed', artist: 'Glass Owls', genre: 'shoegaze', by: 'moth' });
  const tracks: Track[] = [seed];
  for (let i = 0; i < 4; i++) tracks.push(track({ id: `owls${i}`, artist: 'Glass Owls', genre: 'shoegaze', by: 'moth' }));
  for (let i = 0; i < 6; i++) tracks.push(track({ id: `gaze${i}`, artist: `Gaze Band ${i}`, genre: i % 2 ? 'shoegaze' : 'dream pop', by: i % 3 ? 'moth' : 'fern' }));
  for (let i = 0; i < 6; i++) tracks.push(track({ id: `tech${i}`, artist: `Techno Act ${i}`, genre: 'techno', by: 'raver' }));
  for (let i = 0; i < 6; i++) tracks.push(track({ id: `jazz${i}`, artist: `Jazz Trio ${i}`, genre: 'jazz', by: 'cat', saves: i * 10 }));
  return { seed, tracks };
}

describe('genre families', () => {
  it('groups related genres by whole words', () => {
    expect(genreFamilies('Indie Rock')).toEqual(new Set(['rock', 'indie']));
    expect(genreFamilies('r&b')).toEqual(new Set(['r&b']));
    expect(genreFamilies('hip hop')).toContain('hip hop');
    expect(genreFamilies('trip hop')).toEqual(new Set(['electronic']));
    expect(genreFamilies('K-Pop')).toContain('pop');
    expect(genreFamilies('drum and bass')).toContain('electronic');
    expect(genreFamilies('')).toEqual(new Set());
    expect(genreFamilies('rockabilly')).toEqual(new Set()); // not "rock" as a word
  });
});

describe('similarTracks: ranking', () => {
  it('same artist and same genre rank first; other genres come after', () => {
    const { seed, tracks } = catalog();
    const ids = similarTracks(tracks, opts(seed, { count: 12 })).map((t) => t.id);
    expect(ids).toHaveLength(12);
    // Shoegaze-ish first: the same genre (dream pop too) and the same artist, but the seed
    // counts toward "2 per artist in any 10", so only one more Glass Owls track until then.
    expect(ids.slice(0, 7).every((id) => /^(owls|gaze)/.test(id))).toBe(true);
    expect(ids.slice(0, 9).filter((id) => id.startsWith('owls'))).toHaveLength(1);
    expect(ids.slice(7, 9).every((id) => /^(tech|jazz)/.test(id))).toBe(true);
    expect(ids).not.toContain('seed');
  });

  it('artists shared by the same posters are close ("same vibe")', () => {
    n = 0;
    const seed = track({ id: 'seed', artist: 'Alpha', genre: 'noise', by: 'p1' });
    const tracks = [seed];
    // Posters p1..p4 all share Alpha and Beta; Gamma is only shared by an unrelated poster.
    for (const p of ['p1', 'p2', 'p3', 'p4']) {
      tracks.push(track({ artist: 'Alpha', genre: 'noise', by: p }));
      tracks.push(track({ id: `beta-${p}`, artist: 'Beta', genre: 'ambient', by: p }));
    }
    tracks.push(track({ id: 'gamma', artist: 'Gamma', genre: 'ambient', by: 'q9' }));
    const picks = similarTracks(tracks, opts(seed, { count: 3, exclude: tracks.filter((t) => t.artist === 'Alpha').map((t) => t.id) }));
    expect(picks[0].id).toMatch(/^beta-/);
    expect(picks.map((t) => t.id).indexOf('gamma')).toBeGreaterThan(0);
  });

  it('drifts toward the last played tracks', () => {
    const { seed, tracks } = catalog();
    // The last three played were techno: techno now beats jazz, though neither matches the seed.
    const recent = tracks.filter((t) => t.id.startsWith('tech')).slice(0, 3);
    const picks = similarTracks(tracks, opts(seed, { count: 16, recent }));
    const ids = picks.map((t) => t.id);
    const firstTech = ids.findIndex((id) => id.startsWith('tech'));
    const firstJazz = ids.findIndex((id) => id.startsWith('jazz'));
    expect(firstTech).toBeGreaterThanOrEqual(0);
    expect(firstJazz === -1 || firstTech < firstJazz).toBe(true);
  });

  it('when matches run out it widens to popular tracks, never Global ones', () => {
    n = 0;
    const seed = track({ id: 'seed', artist: 'Lonely', genre: 'polka', by: 'x' });
    const tracks = [
      seed,
      track({ id: 'pop1', artist: 'A', genre: 'zydeco', saves: 50 }),
      track({ id: 'pop2', artist: 'B', genre: 'zydeco', saves: 1 }),
      track({ id: 'glob', artist: 'C', genre: '', source: 'ytmusic' }),
    ];
    const picks = similarTracks(tracks, opts(seed, { count: 5 }));
    expect(picks.map((t) => t.id).sort()).toEqual(['pop1', 'pop2']);
  });
});

describe('similarTracks: variety', () => {
  it('never the same artist twice in a row, at most 2 per artist in any 10', () => {
    n = 0;
    const seed = track({ id: 'seed', artist: 'Hub', genre: 'house' });
    const tracks = [seed];
    for (let i = 0; i < 20; i++) tracks.push(track({ artist: 'Hub', genre: 'house' }));
    for (let i = 0; i < 40; i++) tracks.push(track({ artist: `Other ${i % 8}`, genre: 'house' }));
    const before = [track({ artist: 'Other 1', genre: 'house' })];
    const picks = similarTracks(tracks, opts(seed, { count: 30, before }));
    const seq = [...before, ...picks].map((t) => t.artist);
    for (let i = 1; i < seq.length; i++) expect(seq[i], `pick ${i}`).not.toBe(seq[i - 1]);
    for (let i = 0; i + VARIETY_WINDOW <= seq.length; i++) {
      const w = seq.slice(i, i + VARIETY_WINDOW);
      for (const a of new Set(w)) expect(w.filter((x) => x === a).length, `${a} in window ${i}`).toBeLessThanOrEqual(MAX_PER_ARTIST);
    }
  });

  it('counts featured artists too (split credits)', () => {
    n = 0;
    const seed = track({ id: 'seed', artist: 'Mono', genre: 'techno' });
    const tracks = [seed, track({ id: 'feat', artist: 'Other feat. Mono', genre: 'techno' }), track({ id: 'x', artist: 'Third', genre: 'techno' })];
    // The seed (Mono) plays right before: the track featuring Mono can't come first.
    const picks = similarTracks(tracks, opts(seed, { count: 2 }));
    expect(picks[0].id).toBe('x');
  });
});

describe('similarTracks: exclusions and filters', () => {
  it('leaves out the queue, the last 50 played, the seed and duplicates of one video', () => {
    const { seed, tracks } = catalog();
    const dup = { ...tracks[1], id: 'dup-post' };
    const all = [...tracks, dup];
    const recent = [tracks[2], tracks[3]];
    const picks = similarTracks(all, opts(seed, { count: 50, exclude: [tracks[4].id, tracks[5].ytId], recent }));
    const ids = picks.map((t) => t.id);
    expect(ids).not.toContain('seed');
    for (const t of [tracks[2], tracks[3], tracks[4], tracks[5]]) expect(ids).not.toContain(t.id);
    expect(ids.filter((id) => id === tracks[1].id || id === 'dup-post')).toHaveLength(1);
  });

  it('hides NSFW tracks unless shown, members-only tracks unless signed in', () => {
    n = 0;
    const seed = track({ id: 'seed', artist: 'S', genre: 'jazz' });
    const tracks = [seed, track({ id: 'nsfw', artist: 'A', genre: 'jazz', nsfw: true }), track({ id: 'mem', artist: 'B', genre: 'jazz', membersOnly: true }), track({ id: 'ok', artist: 'C', genre: 'jazz' })];
    expect(similarTracks(tracks, opts(seed)).map((t) => t.id)).toEqual(['ok']);
    expect(similarTracks(tracks, opts(seed, { showNsfw: true, signedIn: true })).map((t) => t.id).sort()).toEqual(['mem', 'nsfw', 'ok']);
  });
});

describe('similarTracks: randomness', () => {
  it('is deterministic for a seeded random source, and varies with it', () => {
    const { seed, tracks } = catalog();
    const a = similarTracks(tracks, opts(seed, { rng: seeded(1) })).map((t) => t.id);
    const b = similarTracks(tracks, opts(seed, { rng: seeded(1) })).map((t) => t.id);
    const c = similarTracks(tracks, opts(seed, { rng: seeded(99) })).map((t) => t.id);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('builds the index once per catalog array', () => {
    const { tracks } = catalog();
    expect(similarIndex(tracks)).toBe(similarIndex(tracks));
    expect(similarIndex(tracks.slice())).not.toBe(similarIndex(tracks));
  });
});
