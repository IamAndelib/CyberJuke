/**
 * One shared ticker for everything that follows the playback position (the mini
 * player's bar, the seek bar, synced lyrics). A timer every TICK_MS, only while
 * something subscribes, and never while the page is hidden (it resumes when the page
 * shows again). Not requestAnimationFrame: a frame callback that mostly does nothing
 * still makes the page draw 60 frames a second while music plays.
 */
import { effect } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { livePosition, player, positionSample } from '../player';

const TICK_MS = 250;

const subs = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | 0 = 0;

const hidden = () => typeof document !== 'undefined' && document.hidden;

function tick(): void {
  timer = 0;
  if (!subs.size || hidden()) return;
  for (const fn of [...subs]) fn();
  kick();
}

function kick(): void {
  if (!timer && subs.size && !hidden()) timer = setTimeout(tick, TICK_MS);
}

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', kick);

/** Call `fn` every tick until the returned function is called. */
function onTick(fn: () => void): () => void {
  subs.add(fn);
  kick();
  return () => {
    subs.delete(fn);
    if (!subs.size && timer) {
      clearTimeout(timer);
      timer = 0;
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
 * `read()` now; re-render only when what it returns changes (e.g. the second shown, or the
 * lyric line being sung): checked every tick while `active`, and on every position sample
 * (a seek, a pause, a new track).
 */
export function useTickValue<T>(active: boolean, read: () => T): T {
  const [, force] = useState(0);
  const value = read();
  const shown = useRef(value);
  shown.current = value;
  const check = () => {
    if (!Object.is(read(), shown.current)) force((n) => n + 1);
  };
  useTicker(active, check);
  const latest = useRef(check);
  latest.current = check;
  useEffect(() => positionSample.subscribe(() => latest.current()), []);
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
