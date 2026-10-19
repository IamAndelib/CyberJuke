import { effect, signal, type ReadonlySignal } from '@preact/signals';

/**
 * `source`, once it has been true for `ms` straight: a short blip stays unseen, and false shows
 * at once. For a state that is right but flickers (the player buffering for a moment from the
 * cache, a network handover being checked), the same idea as the offline grace (network.ts).
 */
export function heldFor(source: ReadonlySignal<boolean>, ms: number): ReadonlySignal<boolean> {
  const held = signal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    if (!source.value) {
      clearTimeout(timer);
      timer = undefined;
      held.value = false;
      return;
    }
    timer ??= setTimeout(() => {
      timer = undefined;
      held.value = true;
    }, ms);
  });
  return held;
}
