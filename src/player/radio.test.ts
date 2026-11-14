import { describe, expect, it } from 'vitest';
import { STATIONS, nextStation, stationById, stationFreq, stationLabel, stationOfTrackId, stationPlace, stationShown, stationTrack, stationTracks } from './radio';
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

describe('labels follow the song (D11)', () => {
  const crypt = stationById('the-crypt')!;
  const mirrorball = stationById('mirrorball')!;
  const slowOrbit = stationById('slow-orbit')!;
  const ids = (s: typeof crypt) => stationTracks(s).map((t) => ({ id: t.id }));
  const tuned = { label: stationLabel(crypt) };
  const seed = stationTracks(crypt)[0].id;

  it('while stations play, the station of the song (or of the rows under a heading), not the one tuned in', () => {
    expect(stationShown(tuned, seed, stationTracks(crypt)[5].id)).toBe(crypt);
    expect(stationShown(tuned, seed, stationTracks(mirrorball)[0].id)).toBe(mirrorball);
    // A song you queued playing: the current list's station (its first station song), else the one tuned in.
    expect(stationShown(tuned, seed, 'ytm:abcdefghijk', [{ id: 'ytm:abcdefghijk' }, ...ids(mirrorball)])).toBe(mirrorball);
    expect(stationShown(tuned, seed, 'ytm:abcdefghijk')).toBe(crypt);
  });

  it("a station's track in any other list is just a track: no station shown", () => {
    expect(stationShown({ label: 'Liked' }, seed, stationTracks(mirrorball)[0].id)).toBeNull();
    expect(stationShown({ label: 'Signal Radio' }, seed, seed)).toBeNull();
    expect(stationShown(null, seed, seed)).toBeNull();
  });

  it('"N of M": the song\'s place in its own station, however the queue was moved or trimmed', () => {
    const [c, m] = [stationTracks(crypt), stationTracks(mirrorball)];
    // Shuffle off, a tap on MIRRORBALL's 3rd song (on the way) while THE CRYPT's 5th played: THE
    // CRYPT's unheard songs come along after it (rule 2), [C1..C5, M3, C6..C32, M1, M2, M4..M40].
    const queue = [...c.slice(0, 5), m[2], ...c.slice(5), m[0], m[1], ...m.slice(3)];
    expect(stationPlace(queue[5].id, false)).toBe('3 of 40');
    expect(stationPlace(queue[6].id, false)).toBe('6 of 32');
    expect(stationPlace(queue[33].id, false)).toBe('1 of 40');
    // Previous two stations back, into MIRRORBALL's last song, its first 22 trimmed (KEEP_PLAYED).
    expect(stationPlace(m[39].id, false)).toBe('40 of 40');
    expect(stationPlace(stationTracks(slowOrbit)[0].id, false)).toBe('1 of 32');
    // A song you queued has no place, a station's included; nor has a song of no station.
    expect(stationPlace(m[4].id, true)).toBe('');
    expect(stationPlace('ytm:abcdefghijk', false)).toBe('');
    expect(stationPlace(undefined, false)).toBe('');
    expect(stationPlace('sig:mirrorball:zzzzzzzzzzz', false)).toBe('');
  });
});
