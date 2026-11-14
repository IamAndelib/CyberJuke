import { describe, expect, it } from 'vitest';
import { STATIONS, nextStation, stationById, stationFreq, stationLabel, stationOfTrackId, stationQueue, stationTrack, stationTracks } from './radio';
import { asTrack, isTrackFull } from '../core/guards';

/** A seeded generator, so a run can be repeated. */
function rng(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

const cipher = stationById('cipher')!;

describe('Signal Radio stations', () => {
  it('finds a station by its slug, and by any of its track ids', () => {
    expect(cipher.callsign).toBe('CIPHER');
    expect(stationById('nope')).toBeNull();
    const t = stationTracks(cipher)[3];
    expect(stationOfTrackId(t.id)).toBe(cipher);
    expect(stationTrack(t.id)).toBe(t);
    expect(stationOfTrackId('ytm:abcdefghijk')).toBeNull();
    expect(stationOfTrackId('sig:nope:abcdefghijk')).toBeNull();
    expect(stationOfTrackId(null)).toBeNull();
    expect(stationTrack('sig:cipher:zzzzzzzzzzz')).toBeNull();
  });

  it('makes each track a stored-safe Track: sig: id, the callsign as genre, no post', () => {
    for (const s of STATIONS) {
      const tracks = stationTracks(s);
      expect(tracks).toHaveLength(s.tracks.length);
      expect(stationTracks(s)).toBe(tracks);
      for (const t of tracks) {
        expect(t.id).toBe(`sig:${s.id}:${t.ytId}`);
        expect(t).toMatchObject({ genre: s.callsign, source: 'signal', by: '', postUrl: '', artworkUrl: `https://i.ytimg.com/vi/${t.ytId}/hqdefault.jpg` });
        expect(isTrackFull(t)).toBe(true);
        expect(asTrack(JSON.parse(JSON.stringify(t)))).toEqual(t);
      }
    }
  });

  it('labels and tunes as the site does', () => {
    expect(stationLabel(cipher)).toBe('Signal Radio · CIPHER');
    expect(stationFreq(cipher)).toBe('133.7');
    expect(stationFreq(stationById('cold-wave')!)).toBe('273.0');
  });
});

describe('nextStation', () => {
  const ids = STATIONS.map((s) => s.id);

  it('shuffle off: the next in the Radio tab order (YM, then ZM, by frequency), the first again after the last', () => {
    expect(nextStation(cipher, false, [])).toBe(stationById('distortion-field'));
    expect(nextStation(stationById('hackback')!, false, [])).toBe(stationById('the-crypt'));
    expect(nextStation(STATIONS.at(-1)!, false, [])).toBe(STATIONS[0]);
    // What has been heard doesn't matter without shuffle.
    expect(nextStation(cipher, false, ids)).toBe(stationById('distortion-field'));
  });

  it('shuffle on: a random station not heard yet in this chain, never the one playing', () => {
    const r = rng(3);
    const heard = ['cipher', 'cold-wave', 'the-crypt'];
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const s = nextStation(cipher, true, heard, undefined, r)!;
      expect(heard).not.toContain(s.id);
      seen.add(s.id);
    }
    expect(seen.size).toBe(STATIONS.length - heard.length);
    // One left: that one.
    expect(nextStation(cipher, true, ids.filter((id) => id !== 'mirrorball'))).toBe(stationById('mirrorball'));
  });

  it('shuffle on, all 16 heard: a new random order of them, starting with any but the one playing', () => {
    const r = rng(5);
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) seen.add(nextStation(cipher, true, ids, undefined, r)!.id);
    expect(seen).toEqual(new Set(ids.filter((id) => id !== 'cipher')));
  });

  it('offline: skips stations with no saved song, in the same order; none, nothing', () => {
    const saved = new Set(['cold-wave', 'the-crypt']);
    const ok = (s: { id: string }) => saved.has(s.id);
    expect(nextStation(cipher, false, [], ok)).toBe(stationById('cold-wave'));
    expect(nextStation(stationById('cold-wave')!, false, [], ok)).toBe(stationById('the-crypt'));
    expect(nextStation(stationById('the-crypt')!, false, [], ok)).toBe(stationById('cold-wave'));
    // Shuffled, the unheard one with saved songs; once both are heard, either.
    expect(nextStation(cipher, true, ['cold-wave'], ok, () => 0.9)).toBe(stationById('the-crypt'));
    expect(nextStation(stationById('the-crypt')!, true, ['cold-wave', 'the-crypt'], ok)).toBe(stationById('cold-wave'));
    // Only the one playing has saved songs, or none has: nothing follows.
    expect(nextStation(stationById('cold-wave')!, false, [], (s) => s.id === 'cold-wave')).toBeNull();
    expect(nextStation(cipher, true, [], () => false)).toBeNull();
  });
});

describe('stationQueue', () => {
  it('plays every track of the station exactly once per round, shuffled', () => {
    const r = rng(7);
    const ids = stationTracks(cipher).map((t) => t.id);
    const round = stationQueue(cipher, null, r);
    expect([...round.map((t) => t.id)].sort()).toEqual([...ids].sort());
    expect(round.map((t) => t.id)).not.toEqual(ids);
    expect(round.every((t) => t.id.startsWith('sig:cipher:'))).toBe(true);
  });

  it('never starts a round with the track the last one ended on', () => {
    const r = rng(11);
    let last: string | undefined;
    for (let i = 0; i < 200; i++) {
      const round = stationQueue(cipher, last, r);
      expect(round).toHaveLength(cipher.tracks.length);
      if (last) expect(round[0].ytId).not.toBe(last);
      last = round.at(-1)!.ytId;
    }
    // A generator that keeps everything in place would start with it: it goes to the end instead.
    const first = stationTracks(cipher)[0];
    const kept = stationQueue(cipher, first.ytId, () => 0.999999);
    expect(kept[0].ytId).not.toBe(first.ytId);
    expect(kept.at(-1)).toBe(first);
  });

  it('a station of one track plays it again', () => {
    const one = { ...cipher, id: 'one', tracks: cipher.tracks.slice(0, 1) };
    expect(stationQueue(one, one.tracks[0].ytId).map((t) => t.ytId)).toEqual([one.tracks[0].ytId]);
  });
});
