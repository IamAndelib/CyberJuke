/// <reference types="node" />
/** Every theme's secondary text stays readable: --color-fg-dim on --color-bg is at least 4.5:1 (WCAG AA). */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Read from disk: Vitest turns CSS imports (even ?raw) into empty strings.
const css = readFileSync(new URL('./themes.css', import.meta.url), 'utf8');

/** `name -> { token: value }` for each `[data-theme='name']` block (`:root` counts as dark). */
function themes(src: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const m of src.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const names = [...m[1].matchAll(/\[data-theme='([\w-]+)'\]/g)].map((n) => n[1]);
    if (!names.length) continue;
    const vars: Record<string, string> = {};
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[d[1]] = d[2].trim();
    for (const n of names) out.set(n, vars);
  }
  return out;
}

function rgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  expect(h, `opaque hex colour: ${hex}`).toMatch(/^[0-9a-f]{6}$/i);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('theme contrast', () => {
  const all = themes(css);

  it('finds every theme', () => {
    expect([...all.keys()].sort()).toEqual(['brutalist', 'bubblegum', 'c64', 'crypt', 'dark', 'light', 'matrix', 'vt320']);
  });

  it('checks the contrast formula', () => {
    expect(contrast('#000', '#fff')).toBeCloseTo(21, 5);
    expect(contrast('#777', '#fff')).toBeCloseTo(4.48, 2);
  });

  for (const [name, t] of all) {
    it(`${name}: dim text is at least 4.5:1 on the background`, () => {
      expect(contrast(t['--color-fg-dim'], t['--color-bg'])).toBeGreaterThanOrEqual(4.5);
    });
  }
});
