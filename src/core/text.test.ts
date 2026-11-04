import { describe, expect, it } from 'vitest';
import { TEXT_MAX, tidy } from './text';

describe('tidy', () => {
  it('makes text from outside one line: controls and runs of spaces become one space', () => {
    expect(tidy('  Night\n\tShift  ')).toBe('Night Shift');
    expect(tidy('A\u0000B‮C⁦D')).toBe('A B C D');
  });

  it('keeps at most TEXT_MAX characters, never half an emoji', () => {
    expect(tidy('x'.repeat(TEXT_MAX + 50))).toHaveLength(TEXT_MAX);
    const t = tidy('x'.repeat(TEXT_MAX - 1) + '😀');
    expect(t).toBe('x'.repeat(TEXT_MAX - 1));
  });

  it('is quick on a very long run of spaces', () => {
    const t0 = performance.now();
    expect(tidy('a' + ' '.repeat(200_000) + 'b')).toBe('a b');
    expect(performance.now() - t0).toBeLessThan(100);
  });
});
