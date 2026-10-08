import { signal } from '@preact/signals';

/** A button on a toast (Undo): tapping it runs `run` and dismisses the toast. */
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  text: string;
  action?: ToastAction;
}

/** How long a toast with an action stays: long enough to reach for Undo. */
export const ACTION_TOAST_MS = 4000;

export const toasts = signal<Toast[]>([]);
let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export function dismissToast(id: number): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
  if (toasts.value.some((t) => t.id === id)) toasts.value = toasts.value.filter((x) => x.id !== id);
}

/**
 * Show a short message at the bottom of the screen. With an `action` (e.g. Undo) the
 * toast takes taps and stays about 4 s, unless `ms` says otherwise.
 */
export function toast(text: string, ms?: number, action?: ToastAction): void {
  const t: Toast = action ? { id: nextId++, text, action } : { id: nextId++, text };
  // Keep at most two on screen; newest last.
  const kept = toasts.value.slice(-1);
  for (const old of toasts.value) if (!kept.includes(old)) dismissToast(old.id);
  toasts.value = [...kept, t];
  timers.set(
    t.id,
    setTimeout(() => dismissToast(t.id), ms ?? (action ? ACTION_TOAST_MS : 3200)),
  );
}

/** The toast's button was tapped: run its action once and dismiss it. */
export function runToastAction(id: number): void {
  const t = toasts.value.find((x) => x.id === id);
  dismissToast(id);
  t?.action?.run();
}
