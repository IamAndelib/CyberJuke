import { describe, expect, it } from 'vitest';
import { UNKNOWN_ALBUM_KEY, byMostSongs, groupLocal } from './localGroups';
import type { LocalSong } from './local';

let n = 0;
const song = (title: string, artist: string, album = '', o: Partial<LocalSong> = {}): LocalSong => ({
  id: `loc:${(++n).toString(16).padStart(16, '0')}`,
  title,
  artist,
  album,
  albumArtist: '',
  track: 0,
  disc: 0,
  year: 0,
  durationMs: 1000,
  modified: 0,
  folder: 'f',
  cover: false,
  ...o,
});

describe('local albums', () => {
  it('play in track order, not by title (Cowboys from Hell is track 1)', () => {
    const { albums } = groupLocal([
      song('Cemetery Gates', 'Pantera', 'Cowboys from Hell', { track: 5 }),
      song('Domination', 'Pantera', 'Cowboys from Hell', { track: 2 }),
      song('Cowboys from Hell', 'Pantera', 'Cowboys from Hell', { track: 1 }),
    ]);
    expect(albums.map((a) => a.title)).toEqual(['Cowboys from Hell']);
    expect(albums[0]!.songs.map((s) => s.title)).toEqual(['Cowboys from Hell', 'Domination', 'Cemetery Gates']);
  });

  it('go disc by disc; unnumbered songs after the numbered ones, by title', () => {
    const { albums } = groupLocal([
      song('B2', 'A', 'Double', { disc: 2, track: 1 }),
      song('Bonus', 'A', 'Double'),
      song('A1', 'A', 'Double', { disc: 1, track: 1 }),
      song('A2', 'A', 'Double', { track: 2 }),
    ]);
    expect(albums[0]!.songs.map((s) => s.title)).toEqual(['A1', 'A2', 'Bonus', 'B2']);
  });

  it('are one album and one artist whatever the case ("TOOL" and "Tool"), shown in the spelling most use', () => {
    const { albums, artists } = groupLocal([song('Forty Six & 2', 'TOOL', 'Ænima'), song('Ænema', 'Tool', 'Ænima'), song('Stinkfist', 'TOOL', 'ænima ')]);
    expect(albums.map((a) => [a.title, a.artist, a.songs.length])).toEqual([['Ænima', 'TOOL', 3]]);
    expect(artists.map((a) => a.name)).toEqual(['TOOL']);
  });

  it('of the same name stay apart by artist; an album artist holds a compilation together', () => {
    const { albums, artists } = groupLocal([
      song('One', 'Band A', 'Greatest Hits'),
      song('Two', 'Band B', 'Greatest Hits'),
      song('Song X', 'Singer X', 'Summer Mix', { albumArtist: 'Various Artists' }),
      song('Song Y', 'Singer Y feat. Z', 'Summer Mix', { albumArtist: 'Various Artists' }),
    ]);
    expect(albums.map((a) => [a.title, a.artist, a.songs.length])).toEqual([
      ['Greatest Hits', 'Band A', 1],
      ['Greatest Hits', 'Band B', 1],
      ['Summer Mix', 'Various Artists', 2],
    ]);
    expect(artists.map((a) => a.name)).toEqual(['Band A', 'Band B', 'Various Artists']);
  });

  it('take the cover and the year of their first song that has one', () => {
    const { albums } = groupLocal([song('B', 'A', 'X', { track: 2, cover: true, year: 1990 }), song('A', 'A', 'X', { track: 1 })]);
    expect(albums[0]!.cover).toBe(`/_local/art/${albums[0]!.songs[1]!.id.slice(4)}.jpg`);
    expect(albums[0]!.year).toBe(1990);
  });
});

describe('songs without tags', () => {
  it('with no album, whoever they are by, make one Unknown album at the end, by title; it is on no artist\u2019s shelf', () => {
    const { albums, artists } = groupLocal([
      song('zebra rip', 'Unknown artist'),
      song('Battery', 'Metallica', 'Master of Puppets'),
      song('Loose single', 'TOOL'),
      song('another rip', 'Unknown artist'),
    ]);
    expect(albums.map((a) => [a.title, a.artist])).toEqual([
      ['Master of Puppets', 'Metallica'],
      ['Unknown album', ''],
    ]);
    expect(albums[1]!.songs.map((s) => s.title)).toEqual(['another rip', 'Loose single', 'zebra rip']);
    expect(artists.flatMap((a) => a.albums.map((x) => x.title))).toEqual(['Master of Puppets']);
  });
});

describe('local artists', () => {
  it('list their albums newest first (unknown year last) and every song by title; Unknown artist goes last', () => {
    const { artists } = groupLocal([
      song('memo', 'Unknown artist'),
      song('The Pot', 'TOOL', '10,000 Days', { year: 2006 }),
      song('Forty Six & 2', 'TOOL', 'Ænima', { year: 1996 }),
      song('Demo', 'TOOL', 'Demos'),
      song('Loose single', 'TOOL'),
      song('Battery', 'Metallica', 'Master of Puppets', { year: 1986 }),
    ]);
    expect(artists.map((a) => a.name)).toEqual(['Metallica', 'TOOL', 'Unknown artist']);
    const tool = artists[1]!;
    expect(tool.albums.map((a) => a.title)).toEqual(['10,000 Days', 'Ænima', 'Demos']);
    expect(tool.songs.map((s) => s.title)).toEqual(['Demo', 'Forty Six & 2', 'Loose single', 'The Pot']);
    expect(artists[2]!.albums).toEqual([]);
  });
});

describe('most songs first', () => {
  it('puts the albums with the most songs first, a tie in its order, and Unknown album last whatever its size', () => {
    const { albums } = groupLocal([
      song('a1', 'Ana', 'Attic'),
      song('b1', 'Zed', 'Basement'),
      song('b2', 'Zed', 'Basement'),
      song('c1', 'Ana', 'Cellar'),
      song('m1', 'Ana'),
      song('m2', 'Zed'),
      song('m3', 'Ana'),
    ]);
    expect(byMostSongs(albums, (a) => a.key === UNKNOWN_ALBUM_KEY).map((a) => a.title)).toEqual(['Basement', 'Attic', 'Cellar', 'Unknown album']);
  });
});


describe('a big folder', () => {
  it('groups 20,000 songs of one artist, half on 50 albums, in well under a second', () => {
    const many = Array.from({ length: 20_000 }, (_, i) => song(`Voice note ${i}`, 'Unknown artist', i % 2 ? '' : `Album ${(i / 2) % 50}`, { id: `loc:${i.toString(16).padStart(16, '0')}` }));
    const t0 = performance.now();
    const { albums, artists } = groupLocal(many);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(artists[0]!.songs).toHaveLength(20_000);
    expect(artists[0]!.albums).toHaveLength(50);
    expect(albums).toHaveLength(51);
  });
});
