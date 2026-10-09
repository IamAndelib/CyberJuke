/**
 * A tap on the app's controls works even while a list is still gliding.
 *
 * Android's WebView (Chromium) takes a touch that lands during a fling as "stop the
 * fling" and suppresses the click that would follow, anywhere on the page. The finger's
 * pointerdown and pointerup still arrive, so for the app's chrome (the search button,
 * the tab bar, the mini player, top bars, toasts) a short, still press that ends
 * without its click is clicked here instead.
 *
 * Track rows and lyric lines are left alone on purpose: there, a tap that stops a fling
 * should only stop it (M6), so nothing starts playing by accident.
 */

/** Containers whose buttons act on a tap even when Chromium drops the click. */
const TAP_THROUGH = '[data-tap-through], .tabbar, .mini, .topbar, .fab, .toasts';
/** What counts as a tappable control inside them. */
const CONTROL = 'button, a[href], [role="tab"], [role="radio"]';
/** Further than this and the finger was scrolling, not tapping. */
const TAP_SLOP_PX = 10;
/** Longer than this and it was a hold, not a tap. */
const TAP_MAX_MS = 500;
/** How long to wait for the real click before supplying it. */
const CLICK_WAIT_MS = 80;
/** A real click this soon after a supplied one is the same tap arriving late: dropped. */
const LATE_CLICK_MS = 400;

interface Press {
  id: number;
  x: number;
  y: number;
  at: number;
  el: HTMLElement;
}

let press: Press | null = null;
let pendingFor: HTMLElement | null = null;
let pendingTimer = 0;
let supplied: { el: HTMLElement; at: number; x: number; y: number } | null = null;
let pendingAt = { x: 0, y: 0 };

/** The control a finger landed on, if it's one of the app's chrome controls. */
export function tapThroughControl(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest<HTMLElement>(CONTROL);
  if (!el || !el.closest(TAP_THROUGH)) return null;
  if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return null;
  return el;
}

function now(e: Event): number {
  return e.timeStamp || performance.now();
}

if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointerdown',
    (e) => {
      press = null;
      if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const el = tapThroughControl(e.target);
      if (el) press = { id: e.pointerId, x: e.clientX, y: e.clientY, at: now(e), el };
    },
    { capture: true, passive: true },
  );
  window.addEventListener(
    'pointercancel',
    (e) => {
      if (press?.id === e.pointerId) press = null;
    },
    { capture: true, passive: true },
  );
  window.addEventListener(
    'pointerup',
    (e) => {
      const p = press;
      press = null;
      if (!p || p.id !== e.pointerId) return;
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) >= TAP_SLOP_PX || now(e) - p.at > TAP_MAX_MS) return;
      if (!p.el.isConnected || !p.el.contains(e.target as Node)) return;
      clearTimeout(pendingTimer);
      pendingFor = p.el;
      pendingAt = { x: e.clientX, y: e.clientY };
      pendingTimer = window.setTimeout(() => {
        const el = pendingFor;
        pendingFor = null;
        if (!el || !el.isConnected || tapThroughControl(el) !== el) return;
        supplied = { el, at: performance.now(), ...pendingAt };
        el.click();
      }, CLICK_WAIT_MS);
    },
    { capture: true, passive: true },
  );
  window.addEventListener(
    'click',
    (e) => {
      // The real click came: nothing to supply.
      if (pendingFor && e.target instanceof Node && pendingFor.contains(e.target)) {
        clearTimeout(pendingTimer);
        pendingFor = null;
        return;
      }
      // A real click arriving after one was supplied for the same tap: drop it. Also when the
      // supplied click already removed or moved the control (Back, Undo): then the late click
      // lands where the finger was, on whatever is there now.
      const s = supplied;
      const same =
        s != null &&
        e.target instanceof Node &&
        (s.el.contains(e.target) || Math.hypot(e.clientX - s.x, e.clientY - s.y) < TAP_SLOP_PX);
      if (s && same && e.detail > 0 && performance.now() - s.at < LATE_CLICK_MS) {
        supplied = null;
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    { capture: true },
  );
}
