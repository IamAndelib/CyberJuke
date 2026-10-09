import { describe, expect, it } from 'vitest';
import { sharePayload } from './share';

describe('share', () => {
  it('shares the title, artist and the music.youtube.com link', () => {
    expect(sharePayload({ ytId: 'abcdefghijk', title: 'Neon Rain', artist: 'Lumen' })).toEqual({
      title: 'Neon Rain — Lumen',
      text: 'Neon Rain — Lumen',
      url: 'https://music.youtube.com/watch?v=abcdefghijk',
    });
    expect(sharePayload({ ytId: 'abcdefghijk', title: 'Untitled', artist: '' }).title).toBe('Untitled');
  });
});
