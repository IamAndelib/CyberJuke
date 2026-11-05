import { signal } from '@preact/signals';

/**
 * The one row that glows for a moment: a song just moved with ↑ or ↓ in the queue, or put back
 * by Undo in any list (the queue, Liked, a playlist). One at a time: a new one takes it over at
 * once, and the row it lights is a row drawn anew (moved or put back), so its fade starts over.
 * `scope` names the list ("queue", "liked", "playlist:<id>"), `to` the place it went (the queue's,
 * to tell two copies of a song apart).
 */
export interface Glow {
  scope: string;
  id: string;
  to?: number;
}

export const glow = signal<Glow | null>(null);

/** As long as the CSS fade (`row-glow`). */
const GLOW_MS = 1500;
let timer: ReturnType<typeof setTimeout> | undefined;

export function glowRow(scope: string, id: string, to?: number): void {
  clearTimeout(timer);
  glow.value = to == null ? { scope, id } : { scope, id, to };
  timer = setTimeout(() => (glow.value = null), GLOW_MS);
}
