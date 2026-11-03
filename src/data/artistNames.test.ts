import { describe, expect, it } from 'vitest';
import data from './artistNames.json';
import { normalize } from './text';

describe('artistNames.json (scripts/update-artist-names.mjs)', () => {
  const { source, names } = data;

  it('names the pinned MusicBrainz export and its artist table', () => {
    expect(source.musicbrainz).toMatch(/^fullexport\/\d{8}-\d{6} mbdump\/artist$/);
    expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(source.popularity).toBe('ListenBrainz');
    expect(source.minUsers).toBeGreaterThan(0);
  });

  it('is sorted, each name once (by its key), and stays small', () => {
    expect(names).toEqual([...names].sort());
    expect(new Set(names.map((n) => normalize(n.replace(/&/g, ' and ')))).size).toBe(names.length);
    expect(names.length).toBeGreaterThan(100);
    expect(JSON.stringify(data).length).toBeLessThan(20_000);
  });

  it('holds only visible names that a credit would split', () => {
    for (const n of names) {
      expect(n.length, n).toBeLessThanOrEqual(100);
      // eslint-disable-next-line no-control-regex -- control and bidi characters are what this refuses.
      expect(n, n).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/);
      expect(n, n).toMatch(/[,;]|\s\/|\/\s|\s(?:feat\.?|ft\.?|featuring)\s/i);
    }
  });

  it('includes the names everyone knows', () => {
    for (const n of ['Earth, Wind & Fire', 'Tyler, The Creator', 'Crosby, Stills, Nash & Young', 'Peter, Paul and Mary', 'Black Country, New Road', '10,000 Maniacs']) {
      expect(names).toContain(n);
    }
  });
});
