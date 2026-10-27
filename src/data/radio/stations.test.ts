import { describe, expect, it } from 'vitest';
import data from './stations.json';
import { YT_ID_RE } from '../../core/guards';

describe('stations.json (scripts/update-stations.mjs)', () => {
  const { source, stations } = data;

  it('names the pinned upstream commit', () => {
    expect(source.repo).toBe('hyphen8d/signal');
    expect(source.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('holds the 16 public stations, both bands, sorted by band then frequency', () => {
    expect(stations).toHaveLength(16);
    expect(stations.filter((s) => s.band === 'ym')).toHaveLength(8);
    expect(stations.filter((s) => s.band === 'zm')).toHaveLength(8);
    const sorted = [...stations].sort((a, b) => a.band.localeCompare(b.band) || a.freq - b.freq);
    expect(stations.map((s) => s.id)).toEqual(sorted.map((s) => s.id));
  });

  it('gives every station a unique slug, its text and at least one track', () => {
    expect(new Set(stations.map((s) => s.id)).size).toBe(stations.length);
    expect(new Set(stations.map((s) => s.callsign)).size).toBe(stations.length);
    for (const s of stations) {
      expect(s.id).toMatch(/^[a-z0-9-]+$/);
      expect(Number.isFinite(s.freq)).toBe(true);
      expect(s.callsign && s.tagline && s.desc).toBeTruthy();
      expect(s.tracks.length).toBeGreaterThan(0);
    }
  });

  it('has each video once per station (a track id is sig:<station>:<video id>)', () => {
    for (const s of stations) expect(new Set(s.tracks.map((t) => t.ytId)).size, s.id).toBe(s.tracks.length);
  });

  it('has a valid video id, a title and an artist on every track (688 in all)', () => {
    const all = stations.flatMap((s) => s.tracks);
    expect(all).toHaveLength(688);
    for (const t of all) {
      expect(t.ytId).toMatch(YT_ID_RE);
      expect(t.title.trim()).toBe(t.title);
      expect(t.title && t.artist).toBeTruthy();
    }
  });

  it('has no control, zero-width or bidi characters, and no field over 300 characters (the script checks it too)', () => {
    // eslint-disable-next-line no-control-regex -- control characters are exactly what this looks for.
    const hidden = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
    const texts = stations.flatMap((s) => [s.callsign, s.tagline, s.desc, ...s.tracks.flatMap((t) => [t.title, t.artist])]);
    for (const t of texts) {
      expect(hidden.test(t), t).toBe(false);
      expect(t.length, t).toBeLessThanOrEqual(300);
    }
  });

  it('keeps titles as written: quotes, ampersands and accents decoded', () => {
    const titles = stations.flatMap((s) => s.tracks.map((t) => `${t.title} -- ${t.artist}`));
    expect(titles).toContain("(Can't You) Trip Like I Do -- Filter & The Crystal Method");
    expect(titles).toContain('Nuthin\' But A "G" Thang -- Dr. Dre');
    expect(titles).toContain('Vinterväldet -- Trollslottet');
    expect(titles.some((t) => /&(amp|#\d+|quot);|\\/.test(t))).toBe(false);
  });
});
