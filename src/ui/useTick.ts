/**
 * One shared ticker for everything that follows the playback position (the mini
 * player's bar, the seek bar, synced lyrics). It runs on requestAnimationFrame, at
 * most every TICK_MS, only while something subscribes, and never while the page is
 * hidden (it resumes when the page shows again).
 */
import { effect } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { livePosition, player, positionSample } from '../player';

const TICK_MS = 250;

const subs = new Set<() => void>();
let raf = 0;
let last = 0;

const hidden = () => typeof document !== 'undefined' && document.hidden;

function frame(t: number): void {
  raf = 0;
  if (!subs.size || hidden()) return;
  if (t - last >= TICK_MS) {
    last = t;
    for (const fn of [...subs]) fn();
  }
  raf = requestAnimationFrame(frame);
}

function kick(): void {
  if (!raf && subs.size && !hidden()) raf = requestAnimationFrame(frame);
}

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', kick);

/** Call `fn` every tick until the returned function is called. */
function onTick(fn: () => void): () => void {
  subs.add(fn);
  kick();
  return () => {
    subs.delete(fn);
    if (!subs.size && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}

/** Call the latest `fn` every tick while `active` (no re-render). */
function useTicker(active: boolean, fn: () => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => (active ? onTick(() => ref.current()) : undefined), [active]);
}

/**
 * `read()` now; while `active`, re-render only when what it returns changes (e.g.
 * the second shown, or the lyric line being sung).
 */
export function useTickValue<T>(active: boolean, read: () => T): T {
  const [, force] = useState(0);
  const value = read();
  const shown = useRef(value);
  shown.current = value;
  useTicker(active, () => {
    if (!Object.is(read(), shown.current)) force((n) => n + 1);
  });
  return value;
}

/** The interpolated position now, without subscribing to anything. */
export function positionNow(): number {
  return livePosition(player.state.peek());
}

/**
 * Write the live position somewhere directly (a CSS variable, a text node) on every
 * sample and every tick while playing, without re-rendering the component.
 */
export function useLiveProgress(write: (positionMs: number, durationMs: number) => void, active: boolean): void {
  const ref = useRef(write);
  ref.current = write;
  useEffect(
    () =>
      effect(() => {
        const s = positionSample.value;
        ref.current(livePosition({ ...player.state.peek(), ...s }), s.durationMs);
      }),
    [],
  );
  useTicker(active, () => {
    const s = player.state.peek();
    ref.current(livePosition(s), s.durationMs);
  });
}
