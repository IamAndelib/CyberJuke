/** "1 track", "3 tracks": [n] and the word that fits it. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
