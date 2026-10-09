import { useEffect } from 'preact/hooks';

/** What sits behind a sheet: the app and, when it is up, Now Playing. */
const BEHIND = '.app, [data-testid="now-playing"]';

/**
 * A sheet that is modal for real while [open]:
 * - what's behind it is inert (no taps, no focus, no scrolling it from under the sheet);
 * - focus moves to its first control, and back to whatever had it when it closes (or, if
 *   that has gone, to the first control on its page);
 * - it only takes pan gestures itself when its content is taller than it (`scrolls`), so
 *   a drag on a short sheet can't hand the scroll to the page behind (Android WebView).
 */
export function useModal(open: boolean, sheet: { current: HTMLElement | null }, opts: { inertBehind?: boolean } = {}): void {
  const inertBehind = opts.inertBehind ?? true;
  useEffect(() => {
    if (!open) return;
    const el = sheet.current;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Its page, in case the sheet's action removes it (Library → Clear history).
    const page = before?.closest<HTMLElement>('.screen') ?? null;
    // Only what isn't inert already (the app is, behind Now Playing): give back just those.
    const made = inertBehind
      ? [...document.querySelectorAll<HTMLElement>(BEHIND)].filter((b) => !b.inert && !b.contains(el))
      : [];
    for (const b of made) b.inert = true;
    const frame = requestAnimationFrame(() => {
      if (!el) return;
      if (el.classList.contains('sheet')) el.classList.toggle('scrolls', el.scrollHeight > el.clientHeight + 1);
      el.querySelector<HTMLElement>('button:not([disabled]), [href]')?.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(frame);
      for (const b of made) b.inert = false;
      if (before?.isConnected) {
        if (!before.closest('[inert]')) before.focus({ preventScroll: true });
      } else if (page?.isConnected && !page.closest('[inert]')) {
        page.querySelector<HTMLElement>('button:not([disabled]), [href]')?.focus({ preventScroll: true });
      }
    };
    // `sheet` is a stable ref; only opening and closing matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
