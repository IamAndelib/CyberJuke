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
/** When each toast's timer runs out (Date.now()), and what was left of it while it's held. */
const deadlines = new Map<number, number>();
const held = new Map<number, number>();
/** A toast let go after a drag stays at least this long, so it doesn't vanish on release. */
const MIN_AFTER_HOLD_MS = 1500;
/** The `stale` watchers of toasts on screen. */
const watchers = new Map<number, () => void>();

function unwatch(id: number): void {
  watchers.get(id)?.();
  watchers.delete(id);
}

export function dismissToast(id: number): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
  deadlines.delete(id);
  held.delete(id);
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
 * toast takes taps and stays about 4 s, unless `ms` says otherwise. One at a time: a new
 * toast replaces the one showing (its Undo goes with it). Returns its id.
 */
export function toast(text: string, ms?: number, action?: ToastAction): number {
  const t: Toast = action ? { id: nextId++, text, action } : { id: nextId++, text };
  for (const old of toasts.peek()) dismissToast(old.id);
  toasts.value = [t];
  startTimer(t.id, ms ?? (action ? ACTION_TOAST_MS : 3200));
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

function startTimer(id: number, ms: number): void {
  clearTimeout(timers.get(id));
  deadlines.set(id, Date.now() + ms);
  timers.set(
    id,
    setTimeout(() => dismissToast(id), ms),
  );
}

/** A finger is dragging the toast: it doesn't time out meanwhile. */
export function holdToast(id: number): void {
  if (held.has(id) || !timers.has(id)) return;
  clearTimeout(timers.get(id));
  timers.delete(id);
  held.set(id, Math.max(0, (deadlines.get(id) ?? 0) - Date.now()));
}

/** Let go without dismissing it: the rest of its time runs (a moment at least). */
export function releaseToast(id: number): void {
  const left = held.get(id);
  if (left == null) return;
  held.delete(id);
  if (toasts.peek().some((t) => t.id === id)) startTimer(id, Math.max(left, MIN_AFTER_HOLD_MS));
}

/** The toast's button was tapped: run its action once and dismiss it. */
export function runToastAction(id: number): void {
  const t = toasts.value.find((x) => x.id === id);
  dismissToast(id);
  t?.action?.run();
}
