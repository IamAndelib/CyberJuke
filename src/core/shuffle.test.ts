import { describe, expect, it } from 'vitest';
import { shuffled } from './shuffle';

describe('shuffled', () => {
  it('is a permutation, and leaves the original alone', () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8];
    const s = shuffled(a);
    expect(s.slice().sort()).toEqual(a);
    expect(a).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
