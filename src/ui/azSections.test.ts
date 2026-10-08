import { describe, expect, it } from 'vitest';
import { azLetter, groupAZ } from './azSections';

const id = (s: string) => s;
const flat = (names: string[]) => groupAZ(names, id).map((s) => [s.letter, s.items] as const);

describe('azLetter', () => {
  it('strips accents', () => {
    expect(azLetter('Ángel')).toBe('A');
    expect(azLetter('Édith Piaf')).toBe('E');
    expect(azLetter('ölü')).toBe('O');
    expect(azLetter('Øystein')).toBe('O');
  });
  it('puts digits and symbols under #', () => {
    expect(azLetter('2Pac')).toBe('#');
    expect(azLetter('!!!')).toBe('#');
    expect(azLetter('$uicideboy$')).toBe('#');
    expect(azLetter('')).toBe('#');
  });
  it('uppercases and keeps non-Latin letters', () => {
    expect(azLetter('  queen')).toBe('Q');
    expect(azLetter('Кино')).toBe('К');
  });
  it('does not strip "The"', () => {
    expect(azLetter('The Beatles')).toBe('T');
  });
});

describe('groupAZ', () => {
  it('groups by first letter, # first, then letters in order', () => {
    expect(flat(['beta', 'Alpha', '808 State', 'Ábaco', 'zed', '#hash', 'Émile'])).toEqual([
      ['#', ['#hash', '808 State']],
      ['A', ['Ábaco', 'Alpha']],
      ['B', ['beta']],
      ['E', ['Émile']],
      ['Z', ['zed']],
    ]);
  });
  it('sorts within a letter with the collator (case and accents ignored, numeric)', () => {
    expect(flat(['abc', 'Abd', 'ább', 'track 10', 'track 2'])).toEqual([
      ['A', ['ább', 'abc', 'Abd']],
      ['T', ['track 2', 'track 10']],
    ]);
  });
  it('works on objects and does not mutate the input', () => {
    const items = [{ n: 'b' }, { n: 'a' }];
    const out = groupAZ(items, (x) => x.n);
    expect(out.map((s) => s.items.map((x) => x.n))).toEqual([['a'], ['b']]);
    expect(items.map((x) => x.n)).toEqual(['b', 'a']);
  });
});
