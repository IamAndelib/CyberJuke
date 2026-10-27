import { describe, expect, it } from 'vitest';
import { sharePayload } from './share';

describe('share', () => {
  const post = 'https://beta.cyberspace.online/tronex/beat-created-with-openbronxbox';

  it('shares the title, artist and the music.youtube.com link', () => {
    expect(sharePayload({ ytId: 'abcdefghijk', postUrl: post, title: 'Neon Rain', artist: 'Lumen' })).toEqual({
      title: 'Neon Rain — Lumen',
      text: 'Neon Rain — Lumen',
      url: 'https://music.youtube.com/watch?v=abcdefghijk',
    });
    expect(sharePayload({ ytId: 'abcdefghijk', postUrl: post, title: 'Untitled', artist: '' }).title).toBe('Untitled');
  });

  it('shares the post of a Jukebox MP3, which has no YouTube link', () => {
    expect(sharePayload({ ytId: '', postUrl: post, title: 'Träume', artist: 'Mephisztoe' }).url).toBe(post);
  });
});
