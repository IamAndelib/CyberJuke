/**
 * A–Z sections for the Genres and Artists grids.
 *
 * - The section letter is the first letter of the name with accents removed
 *   (Á → A, É → E); names that start with a digit or symbol go under `#`.
 *   Non-Latin letters (Ж, あ) keep their own letter.
 * - `#` comes first, then letters in locale order.
 * - Within a section, names sort with `localeCompare` at base sensitivity
 *   (case and accents ignored), ties broken by the raw name for stability.
 * - Leading "The" is not stripped.
 */

export interface AZSection<T> {
  letter: string;
  items: T[];
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Section letter for a name: an unaccented uppercase letter, or '#'. */
export function azLetter(name: string): string {
  const first = [...name.trim().normalize('NFKD').replace(/\p{M}+/gu, '')][0] ?? '';
  if (!/\p{L}/u.test(first)) return '#';
  const special: Record<string, string> = { ß: 'S', Æ: 'A', æ: 'A', Œ: 'O', œ: 'O', Ø: 'O', ø: 'O', Ł: 'L', ł: 'L', Đ: 'D', đ: 'D', Þ: 'T', þ: 'T' };
  return (special[first] ?? first).toLocaleUpperCase();
}

export function compareNames(a: string, b: string): number {
  return collator.compare(a.trim(), b.trim()) || (a < b ? -1 : a > b ? 1 : 0);
}

export function groupAZ<T>(items: readonly T[], name: (t: T) => string): AZSection<T>[] {
  const by = new Map<string, T[]>();
  for (const it of items) {
    const l = azLetter(name(it));
    const list = by.get(l);
    if (list) list.push(it);
    else by.set(l, [it]);
  }
  const letters = [...by.keys()].sort((a, b) => (a === '#' ? -1 : b === '#' ? 1 : collator.compare(a, b)));
  return letters.map((letter) => ({
    letter,
    items: by.get(letter)!.sort((a, b) => compareNames(name(a), name(b))),
  }));
}
