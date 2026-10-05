import { signal } from '@preact/signals';

export interface Toast {
  id: number;
  text: string;
}

export const toasts = signal<Toast[]>([]);
let nextId = 1;

/** Show a short message at the bottom of the screen. */
export function toast(text: string, ms = 3200): void {
  const t = { id: nextId++, text };
  // Keep at most two on screen; newest last.
  toasts.value = [...toasts.value.slice(-1), t];
  setTimeout(() => {
    toasts.value = toasts.value.filter((x) => x.id !== t.id);
  }, ms);
}
