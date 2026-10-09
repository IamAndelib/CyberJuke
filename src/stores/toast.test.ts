import { signal } from '@preact/signals';
import { describe, expect, it, vi } from 'vitest';
import { dismissToast, dropToastActions, holdToast, releaseToast, runToastAction, toast, toasts } from './toast';

describe('toast actions', () => {
  it('an Undo goes (the text stays) once it is stale', async () => {
    const ctx = signal('a');
    let ran = 0;
    const id = toast('Removed from queue', 4000, { label: 'Undo', run: () => ran++, stale: () => ctx.value !== 'a' });
    expect(toasts.value.find((t) => t.id === id)?.action).toBeDefined();
    ctx.value = 'b';
    await Promise.resolve();
    const t = toasts.value.find((x) => x.id === id);
    expect(t?.text).toBe('Removed from queue');
    expect(t?.action).toBeUndefined();
    runToastAction(id);
    expect(ran).toBe(0);
  });

  it('signing out drops the Undo of members-only items', () => {
    const a = toast('Removed from Liked', undefined, { label: 'Undo', run: () => {}, membersOnly: true });
    const b = toast('Removed from Liked', undefined, { label: 'Undo', run: () => {} });
    dropToastActions((x) => x.membersOnly === true);
    expect(toasts.value.find((t) => t.id === a)?.action).toBeUndefined();
    expect(toasts.value.find((t) => t.id === b)?.action).toBeDefined();
  });
});

describe('one toast at a time', () => {
  it('a new toast replaces the one showing, whatever it was about (and its Undo)', () => {
    for (const t of toasts.peek()) dismissToast(t.id);
    toast('Added to Liked songs', 1800);
    toast('Removed from Liked', undefined, { label: 'Undo', run: () => {} });
    expect(toasts.value.map((t) => t.text)).toEqual(['Removed from Liked']);
    const last = toast('Shoegaze added to Favourites', 1800);
    expect(toasts.value.map((t) => t.id)).toEqual([last]);
  });
});

describe('a held toast', () => {
  it("doesn't time out while held; let go, the rest of its time runs (1.5 s at least)", () => {
    vi.useFakeTimers();
    try {
      for (const t of toasts.peek()) dismissToast(t.id);
      const id = toast('Removed from Liked', 4000, { label: 'Undo', run: () => {} });
      vi.advanceTimersByTime(3000);
      holdToast(id);
      vi.advanceTimersByTime(10_000);
      expect(toasts.value.some((t) => t.id === id)).toBe(true);
      releaseToast(id);
      vi.advanceTimersByTime(1400);
      expect(toasts.value.some((t) => t.id === id)).toBe(true);
      vi.advanceTimersByTime(200);
      expect(toasts.value.some((t) => t.id === id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
