/** "1 track", "3 tracks": [n] and the word that fits it. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Control and bidi-override characters: in a name or title they only garble or disguise it. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
/** At most this many characters of a name or title: more than a real one needs, few enough that matching them stays quick. */
export const TEXT_MAX = 300;

/**
 * Text from outside (a post, a stored track, a file's tags) as one tidy line: control
 * characters and runs of spaces become one space, at most TEXT_MAX characters long.
 */
export function tidy(s: string): string {
  const t = s.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (t.length <= TEXT_MAX) return t;
  // Don't keep half of a character outside the BMP (an emoji).
  const end = /[\uD800-\uDBFF]/.test(t[TEXT_MAX - 1]!) ? TEXT_MAX - 1 : TEXT_MAX;
  return t.slice(0, end).trimEnd();
}
