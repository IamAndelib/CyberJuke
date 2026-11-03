import { describe, expect, it } from 'vitest';
import { buildArtistIndex, splitArtists } from './artists';
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
    expect(splitArtists('Yungstar feat. Trey D & Solo')).toEqual(['Yungstar', 'Trey D & Solo']);
  });

  it('keeps a Jr./Sr./II/III/Inc. after a comma with the name', () => {
    expect(splitArtists('Grover Washington, Jr.')).toEqual(['Grover Washington, Jr.']);
    expect(splitArtists('Sammy Davis, Jr.')).toEqual(['Sammy Davis, Jr.']);
    expect(splitArtists('Hank Williams, Jr')).toEqual(['Hank Williams, Jr']);
    expect(splitArtists('Ken Griffey, Sr.')).toEqual(['Ken Griffey, Sr.']);
    expect(splitArtists('Loudon Wainwright, III')).toEqual(['Loudon Wainwright, III']);
    expect(splitArtists('Murder, Inc.')).toEqual(['Murder, Inc.']);
    expect(splitArtists('Grover Washington, Jr. feat. Bill Withers')).toEqual(['Grover Washington, Jr.', 'Bill Withers']);
    expect(splitArtists('Bill Withers, Grover Washington, Jr.')).toEqual(['Bill Withers', 'Grover Washington, Jr.']);
    expect(splitArtists('Harry Connick, Jr.; Wynton Marsalis')).toEqual(['Harry Connick, Jr.', 'Wynton Marsalis']);
    expect(splitArtists('Grover Washington, Jr. (feat. Bill Withers)')).toEqual(['Grover Washington, Jr.', 'Bill Withers']);
    // Only a suffix on its own: a name that merely starts with one still splits off.
    expect(splitArtists('Marvin Gaye, Jr. Walker & The All Stars')).toEqual(['Marvin Gaye', 'Jr. Walker & The All Stars']);
    expect(splitArtists('Ray Parker Jr., Jrue')).toEqual(['Ray Parker Jr.', 'Jrue']);
  });

  it('keeps a well-known name with a comma whole, also inside a longer credit', () => {
    expect(splitArtists('Earth, Wind & Fire')).toEqual(['Earth, Wind & Fire']);
    expect(splitArtists('Earth, Wind and Fire')).toEqual(['Earth, Wind and Fire']);
    expect(splitArtists('Tyler, The Creator')).toEqual(['Tyler, The Creator']);
    expect(splitArtists('Crosby, Stills, Nash & Young')).toEqual(['Crosby, Stills, Nash & Young']);
    expect(splitArtists('10,000 Maniacs')).toEqual(['10,000 Maniacs']);
    expect(splitArtists('Earth, Wind & Fire, The Emotions')).toEqual(['Earth, Wind & Fire', 'The Emotions']);
    expect(splitArtists('Earth, Wind & Fire feat. The Emotions')).toEqual(['Earth, Wind & Fire', 'The Emotions']);
    expect(splitArtists('Kendrick Lamar, Tyler, The Creator')).toEqual(['Kendrick Lamar', 'Tyler, The Creator']);
  });

  it('still splits collaborations', () => {
    expect(splitArtists('Swedish House Mafia, The Weeknd')).toEqual(['Swedish House Mafia', 'The Weeknd']);
    expect(splitArtists('Daft Punk, Pharrell Williams & Nile Rodgers')).toEqual(['Daft Punk', 'Pharrell Williams & Nile Rodgers']);
    expect(splitArtists('Mumford & Sons, Hozier')).toEqual(['Mumford & Sons', 'Hozier']);
    expect(splitArtists('Earth, Wind')).toEqual(['Earth', 'Wind']);
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
  it('indexes a well-known comma name as one artist', () => {
    const idx = buildArtistIndex([t('e1', 'Earth, Wind & Fire'), t('e2', 'Earth, Wind & Fire')]);
    expect(idx.artists.map((a) => [a.name, a.count])).toEqual([['Earth, Wind & Fire', 2]]);
  });

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

