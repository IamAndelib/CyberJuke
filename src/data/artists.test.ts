import { describe, expect, it } from 'vitest';
import { buildArtistIndex, creditsArtist, pickByArtist, splitArtists, FALLBACK_TOP } from './artists';
import type { Track } from './model';

const t = (id: string, artist: string): Track => ({
  id,
  ytId: id.padEnd(11, 'x'),
  title: 'Song ' + id,
  artist,
  genre: '',
  by: 'someone',
  postTitle: '',
  postUrl: '',
  createdAt: '2026-01-01T00:00:00Z',
  nsfw: false,
  artworkUrl: '',
});

describe('splitArtists', () => {
  it('splits on , ; / and feat./ft./featuring', () => {
    expect(splitArtists('Farhot, Samon Kawamura')).toEqual(['Farhot', 'Samon Kawamura']);
    expect(splitArtists('A; B')).toEqual(['A', 'B']);
    expect(splitArtists('A / B')).toEqual(['A', 'B']);
    expect(splitArtists('Exyz feat. SENZO')).toEqual(['Exyz', 'SENZO']);
    expect(splitArtists('Mamas Gun Ft. Brian Jackson')).toEqual(['Mamas Gun', 'Brian Jackson']);
    expect(splitArtists('glorious ft. yeule')).toEqual(['glorious', 'yeule']);
    expect(splitArtists('X featuring Y')).toEqual(['X', 'Y']);
    expect(splitArtists('Awich, 唾奇, OZworld, CHICO CARLITO')).toEqual(['Awich', '唾奇', 'OZworld', 'CHICO CARLITO']);
  });

  it('never splits on "and" or "&"', () => {
    expect(splitArtists('The Jesus and Mary Chain')).toEqual(['The Jesus and Mary Chain']);
    expect(splitArtists('Joey Valence & Brae')).toEqual(['Joey Valence & Brae']);
    expect(splitArtists('Earth, Wind & Fire')).toEqual(['Earth', 'Wind & Fire']);
    expect(splitArtists('Yungstar feat. Trey D & Solo')).toEqual(['Yungstar', 'Trey D & Solo']);
  });

  it('keeps a slash inside a name and handles bracketed features', () => {
    expect(splitArtists('AC/DC')).toEqual(['AC/DC']);
    expect(splitArtists('Barren Gates (feat. Taylor Ravenna)')).toEqual(['Barren Gates', 'Taylor Ravenna']);
    expect(splitArtists('Panda Eyes [ft. Azuria Sky]')).toEqual(['Panda Eyes', 'Azuria Sky']);
    expect(splitArtists('Jori Olkkonen (AKA Yip/Pure-Byte)')).toEqual(['Jori Olkkonen (AKA Yip/Pure-Byte)']);
  });

  it('drops empty, unknown and duplicate names', () => {
    expect(splitArtists('')).toEqual([]);
    expect(splitArtists('Unknown artist')).toEqual([]);
    expect(splitArtists('A, , a ,A')).toEqual(['A']);
  });
});

describe('buildArtistIndex', () => {
  const tracks = [
    t('1', 'Björk'),
    t('2', 'bjork, Thom Yorke'),
    t('3', 'Björk'),
    t('4', 'The Jesus and Mary Chain'),
    t('5', 'Thom Yorke'),
    t('6', 'Aphex Twin'),
    t('7', 'Unknown artist'),
  ];
  const idx = buildArtistIndex(tracks);

  it('lists each artist once, most-shared first, then by name', () => {
    expect(idx.artists.map((a) => [a.name, a.count])).toEqual([
      ['Björk', 3],
      ['Thom Yorke', 2],
      ['Aphex Twin', 1],
      ['The Jesus and Mary Chain', 1],
    ]);
  });

  it('matches spellings by normalize and shows the most common one', () => {
    expect(idx.byKey.get('bjork')!.name).toBe('Björk');
    expect(idx.tracks.get('bjork')!.map((x) => x.id)).toEqual(['1', '2', '3']);
    expect(idx.tracks.get('thom yorke')!.map((x) => x.id)).toEqual(['2', '5']);
  });
});

describe('creditsArtist', () => {
  it('matches a credited artist in a song credit', () => {
    expect(creditsArtist('Daft Punk', 'daft punk')).toBe(true);
    expect(creditsArtist('Daft Punk - Topic', 'Daft Punk')).toBe(true);
    expect(creditsArtist('Daft Punk, Pharrell Williams', 'Pharrell Williams')).toBe(true);
    expect(creditsArtist('Daft Punk & Pharrell Williams', 'Daft Punk')).toBe(true);
    expect(creditsArtist('Joey Valence & Brae', 'Joey Valence & Brae')).toBe(true);
    expect(creditsArtist('Björk', 'Bjork')).toBe(true);
  });

  it('does not match other artists or partial words', () => {
    expect(creditsArtist('Daft Punk Tribute Band', 'Punk')).toBe(true); // whole words inside a credit
    expect(creditsArtist('Punkrockers', 'Punk')).toBe(false);
    expect(creditsArtist('Someone Else', 'Daft Punk')).toBe(false);
    expect(creditsArtist('', 'Daft Punk')).toBe(false);
  });
});

describe('pickByArtist', () => {
  const credit = (s: string) => s;
  it('keeps matches when there are at least 3', () => {
    const r = pickByArtist(['A', 'B', 'A', 'A feat. C', 'D'], 'A', credit, null);
    expect(r).toEqual({ items: ['A', 'A', 'A feat. C'], all: false });
    // later pages keep filtering
    expect(pickByArtist(['A', 'B'], 'A', credit, false)).toEqual({ items: ['A'], all: false });
  });

  it('falls back to the top 20 when fewer than 3 match', () => {
    const many = Array.from({ length: 30 }, (_, i) => `X${i}`);
    const r = pickByArtist(['A', ...many], 'A', credit, null);
    expect(r.all).toBe(true);
    expect(r.items).toHaveLength(FALLBACK_TOP);
    expect(r.items[0]).toBe('A');
    expect(pickByArtist(many, 'A', credit, true).items).toHaveLength(30);
  });
});
