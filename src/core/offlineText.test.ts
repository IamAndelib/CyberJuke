import { describe, expect, it } from 'vitest';
import { OFFLINE, stillPlays } from './offlineText';

describe('what still plays offline', () => {
  it('names liked songs, local songs or both, and nothing when neither', () => {
    expect(stillPlays(true, false)).toBe('liked songs');
    expect(stillPlays(false, true)).toBe('local songs');
    expect(stillPlays(true, true)).toBe('liked and local songs');
    expect(stillPlays(false, false)).toBeNull();
    expect(OFFLINE.bannerPlays('liked and local songs')).toBe('[ offline ] no carrier · your liked and local songs still play');
  });
});
