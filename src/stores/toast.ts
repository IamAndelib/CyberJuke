import { effect, signal } from '@preact/signals';

/** A button on a toast (Undo): tapping it runs `run` and dismisses the toast. */
interface ToastAction {
  label: string;
  run: () => void;
  /**
   * Read in an effect while the toast shows: once it returns true the button goes
   * (the toast stays). For an Undo that no longer makes sense (Up next changed under it).
   */
  stale?: () => boolean;
  /** Undo would bring back members-only tracks: it goes when signing out (S8). */
  membersOnly?: boolean;
}

interface Toast {
  id: number;
  text: string;
  action?: ToastAction;
}

/** How long a toast with an action stays: long enough to reach for Undo. */
const ACTION_TOAST_MS = 4000;

export const toasts = signal<Toast[]>([]);
let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
/** The `stale` watchers of toasts on screen. */
const watchers = new Map<number, () => void>();

function unwatch(id: number): void {
  watchers.get(id)?.();
  watchers.delete(id);
}

function dismissToast(id: number): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
  unwatch(id);
  if (toasts.value.some((t) => t.id === id)) toasts.value = toasts.value.filter((x) => x.id !== id);
}

/** Take the button off a toast; its text stays for the rest of its time. */
function dropToastAction(id: number): void {
  unwatch(id);
  if (toasts.peek().some((t) => t.id === id && t.action)) toasts.value = toasts.peek().map((t) => (t.id === id ? { id: t.id, text: t.text } : t));
}

/** Take the button off every toast whose action matches. */
export function dropToastActions(match: (a: ToastAction) => boolean): void {
  for (const t of toasts.peek()) if (t.action && match(t.action)) dropToastAction(t.id);
}

/**
 * Show a short message at the bottom of the screen. With an `action` (e.g. Undo) the
 * toast takes taps and stays about 4 s, unless `ms` says otherwise. Returns its id.
 */
export function toast(text: string, ms?: number, action?: ToastAction): number {
  const t: Toast = action ? { id: nextId++, text, action } : { id: nextId++, text };
  // Keep at most two on screen; newest last.
  const kept = toasts.value.slice(-1);
  for (const old of toasts.value) if (!kept.includes(old)) dismissToast(old.id);
  toasts.value = [...kept, t];
  timers.set(
    t.id,
    setTimeout(() => dismissToast(t.id), ms ?? (action ? ACTION_TOAST_MS : 3200)),
  );
  const stale = action?.stale;
  if (stale) {
    // Dropped after the effect has run (not from inside it).
    watchers.set(
      t.id,
      effect(() => {
        if (stale()) queueMicrotask(() => dropToastAction(t.id));
      }),
    );
  }
  return t.id;
}

/** The toast's button was tapped: run its action once and dismiss it. */
export function runToastAction(id: number): void {
  const t = toasts.value.find((x) => x.id === id);
  dismissToast(id);
  t?.action?.run();
}
