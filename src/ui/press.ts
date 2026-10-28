/**
 * Press feedback for every button (U3), the way Android's View shows it. A CSS `:active`
 * press alone often never paints: a quick tap is over before the next frame. One listener
 * on the document gives the button under the finger `.pressed`:
 * - at once, or, inside something that scrolls, after the tap timeout, so the start of a
 *   scroll never flashes the rows under it (a tap quicker than that shows as it lifts);
 * - for at least PRESS_MS once shown, then it eases back;
 * - not at all once the finger moves away or anything scrolls.
 * Reduced motion keeps it: it is a change of colour; only its movement goes (CSS).
 *
 * A button that takes its screen away keeps its press in sight as that screen leaves: in
 * the view transition's snapshot (Back, Settings, tabs), under a new page fading in over
 * it, or on Now Playing sliding away.
 */
/** The shortest a press shows (Android shows a tap's for 64 ms; a little longer reads better). */
const PRESS_MS = 100;
/** Inside a scroller, a touch waits this long to show its press (Android's TAP_TIMEOUT). */
const TAP_TIMEOUT_MS = 100;
/** Further than this and the finger is scrolling, not pressing. */
const SLOP_PX = 10;
/** What shows a press. */
const TARGET = 'button, a[href]';
/** What scrolls under a finger (CSS overflow auto). */
const SCROLLER = '.screen, .chips, .shelf, .rail-row, .np-scroll, .lyr-scroll, .sheet';

let pressed: HTMLElement | null = null;
let shownAt = 0;
let downX = 0;
let downY = 0;
let showTimer: ReturnType<typeof setTimeout> | undefined;

function show(el: HTMLElement): void {
  clearTimeout(showTimer);
  showTimer = undefined;
  el.classList.add('pressed');
  shownAt = performance.now();
}

/** Lifts the press now (moved away, scrolled) or once it has shown for PRESS_MS. */
function lift(now: boolean): void {
  const el = pressed;
  if (!el) return;
  pressed = null;
  if (now) {
    clearTimeout(showTimer);
    showTimer = undefined;
    el.classList.remove('pressed');
    return;
  }
  if (showTimer !== undefined) show(el);
  const left = PRESS_MS - (performance.now() - shownAt);
  // Counted from a painted frame (the tap's own work, like opening a page, may hold the
  // thread past PRESS_MS), on its own timer: a tap elsewhere meanwhile doesn't keep it down.
  requestAnimationFrame(() => setTimeout(() => el !== pressed && el.classList.remove('pressed'), Math.max(0, left)));
}

function down(e: PointerEvent): void {
  if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const el = (e.target as Element | null)?.closest?.<HTMLElement>(TARGET);
  if (pressed) lift(true);
  if (!el || (el as HTMLButtonElement).disabled) return;
  pressed = el;
  downX = e.clientX;
  downY = e.clientY;
  if (e.pointerType === 'touch' && el.closest(SCROLLER)) showTimer = setTimeout(() => show(el), TAP_TIMEOUT_MS);
  else show(el);
}

function moved(x: number, y: number): boolean {
  return Math.hypot(x - downX, y - downY) > SLOP_PX;
}

/** Installs the one press listener (main.tsx). */
export function installPress(): void {
  const opts = { capture: true, passive: true } as const;
  document.addEventListener('pointerdown', down, opts);
  document.addEventListener('pointerup', () => lift(false), opts);
  document.addEventListener('pointercancel', () => lift(true), opts);
  document.addEventListener('pointermove', (e) => pressed && moved(e.clientX, e.clientY) && lift(true), opts);
  // During a pan Chrome may send only touch events.
  document.addEventListener(
    'touchmove',
    (e) => {
      const t = e.touches[0];
      if (pressed && (!t || e.touches.length > 1 || moved(t.clientX, t.clientY))) lift(true);
    },
    opts,
  );
  document.addEventListener('scroll', () => lift(true), opts);
}
