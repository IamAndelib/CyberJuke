import { describe, expect, it } from 'vitest';
import { STATIONS, stationById, stationFreq, stationLabel, stationOfTrackId, stationQueue, stationTrack, stationTracks } from './radio';
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
