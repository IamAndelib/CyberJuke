import { describe, expect, it } from 'vitest';
import { TO_TOP_MS, easeOut, scrollToTop } from './scrollToTop';

/** A fake clock and frame queue: `frame(ms)` advances time and runs the queued frame. */
function frames() {
  let t = 1000;
  let next = 1;
  const queue = new Map<number, FrameRequestCallback>();
  return {
    now: () => t,
    raf: (cb: FrameRequestCallback) => {
      const id = next++;
      queue.set(id, cb);
      return id;
    },
    caf: (id: number) => void queue.delete(id),
    pending: () => queue.size,
    frame(ms = 16) {
      t += ms;
      const due = [...queue.values()];
      queue.clear();
      for (const cb of due) cb(t);
    },
  };
}

describe('easeOut', () => {
  it('starts at 0, ends at 1, and is past halfway at the midpoint', () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
    expect(easeOut(-1)).toBe(0);
    expect(easeOut(2)).toBe(1);
  });
});

describe('scrollToTop', () => {
  it('writes scrollTop at once and on every frame, reaching 0 after the duration', () => {
    const f = frames();
    const el = { scrollTop: 3000 };
    let done = 0;
    scrollToTop(el, { ...f, onDone: () => done++ });
    // The first write is synchronous (stops momentum before the next frame).
    expect(el.scrollTop).toBe(3000);
    const seen: number[] = [];
    while (f.pending()) {
      f.frame();
      seen.push(el.scrollTop);
    }
    expect(el.scrollTop).toBe(0);
    expect(done).toBe(1);
    // Never back down, ease-out: the first frame moves the most.
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeLessThanOrEqual(seen[i - 1]);
    expect(3000 - seen[0]).toBeGreaterThan(seen[seen.length - 2] - seen[seen.length - 1]);
    expect(seen.length).toBeGreaterThanOrEqual(Math.floor(TO_TOP_MS / 16));
    expect(seen.length).toBeLessThanOrEqual(Math.ceil(TO_TOP_MS / 16) + 1);
  });

  it('overrides scrolling that happens meanwhile (fling momentum)', () => {
    const f = frames();
    const el = { scrollTop: 2000 };
    scrollToTop(el, f);
    f.frame();
    const a = el.scrollTop;
    el.scrollTop += 500; // momentum pushes it down again
    f.frame();
    expect(el.scrollTop).toBeLessThan(a);
    while (f.pending()) f.frame();
    expect(el.scrollTop).toBe(0);
  });

  it('jumps instantly with reduced motion, scheduling no frames', () => {
    const f = frames();
    const el = { scrollTop: 2000 };
    let done = 0;
    scrollToTop(el, { ...f, reduced: true, onDone: () => done++ });
    expect(el.scrollTop).toBe(0);
    expect(f.pending()).toBe(0);
    expect(done).toBe(1);
  });

  it('stops where it is when cancelled (a new touch on the list)', () => {
    const f = frames();
    const el = { scrollTop: 2000 };
    let done = 0;
    const cancel = scrollToTop(el, { ...f, onDone: () => done++ });
    f.frame();
    f.frame();
    const at = el.scrollTop;
    expect(at).toBeGreaterThan(0);
    cancel();
    expect(f.pending()).toBe(0);
    f.frame(500);
    expect(el.scrollTop).toBe(at);
    expect(done).toBe(0);
    cancel(); // idempotent
  });

  it('does nothing but finish when already at the top', () => {
    const f = frames();
    const el = { scrollTop: 0 };
    let done = 0;
    scrollToTop(el, { ...f, onDone: () => done++ });
    expect(f.pending()).toBe(0);
    expect(done).toBe(1);
  });
});
