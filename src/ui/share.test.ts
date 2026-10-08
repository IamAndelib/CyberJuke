import { describe, expect, it } from 'vitest';
import type { Track } from '../data/model';
import { canSharePost, sharePayload, sharePostPayload } from './share';

const jukebox: Track = {
  id: 'p1',
  ytId: 'abcdefghijk',
  title: 'Neon Rain',
  artist: 'Lumen',
  genre: 'synthwave',
  by: 'nightowl',
  postTitle: 'late drive',
  postUrl: 'https://beta.cyberspace.online/nightowl/late-drive',
  createdAt: '2026-01-01T00:00:00Z',
  nsfw: false,
  artworkUrl: '',
};

describe('share (P14)', () => {
  it('a Jukebox track can share its post, through the same payload shape', () => {
    expect(canSharePost(jukebox)).toBe(true);
    expect(sharePostPayload(jukebox)).toEqual({
      title: 'late drive',
      text: 'Neon Rain — Lumen, shared by @nightowl on the Cyberspace Jukebox',
      url: 'https://beta.cyberspace.online/nightowl/late-drive',
    });
    expect(sharePayload(jukebox).url).toBe('https://music.youtube.com/watch?v=abcdefghijk');
  });

  it('a Global track, or a post link off Cyberspace, shares only the track', () => {
    expect(canSharePost({ ...jukebox, source: 'ytmusic' })).toBe(false);
    expect(canSharePost({ ...jukebox, postUrl: '' })).toBe(false);
    expect(canSharePost({ ...jukebox, postUrl: 'https://evil.example/x' })).toBe(false);
  });
});
