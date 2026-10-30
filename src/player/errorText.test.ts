import { describe, expect, it } from 'vitest';
import { trackErrorText } from './errorText';

describe('trackErrorText', () => {
  it('a song passed over offline says it isn’t on the phone, not that it is unavailable', () => {
    expect(trackErrorText({ skipped: true, kind: 'network' }, 'Song')).toBe('No carrier. Skipped "Song": not saved on the phone.');
  });

  it('keeps the other texts', () => {
    expect(trackErrorText({ skipped: true, kind: 'track' }, 'Song')).toBe('Skipped "Song": unavailable');
    expect(trackErrorText({ kind: 'network', resumes: true }, 'Song')).toBe('Signal lost. "Song" picks up when you\'re back.');
    expect(trackErrorText({ kind: 'track' }, 'Song')).toBe('Can\'t play "Song"');
  });
});
