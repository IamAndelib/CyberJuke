/**
 * Press feedback for every button (U3), the way Android's View shows it. A CSS `:active`
 * press alone often never paints: a quick tap is over before the next frame. One listener
 * on the document marks the button under the finger `data-pressed`, an attribute Preact
 * doesn't manage, so a re-render that restyles the button (a toggle turning on) keeps it:
 * - at once, or, inside something that scrolls, after the tap timeout, so the start of a
 *   scroll never flashes the rows under it (a tap quicker than that shows as it lifts);
 * - for at least PRESS_MS once shown, then it eases back;
 * - not at all once the finger moves away or anything scrolls.
 * Reduced motion keeps it: it is a change of colour; only its movement goes (CSS).
 *
 * `afterPress` is for a button whose action swaps the screen it is on at once (Settings,
 * the Back arrows, a tile, card or result that opens a page) or takes the button itself away (in a list: [Clear all], ✕, Up next's
 * rows and arrows, Retry): acting at once would take the press away before anyone saw it.
 * The action waits until the press has shown for HOLD_MS, counted from a painted frame. A
 * tap, key or Android back that comes sooner runs the waiting action first, so it never
 * lands on the screen the next tap opened.
 */
/** The shortest a press shows (Android shows a tap's for 64 ms; a little longer reads better). */
const PRESS_MS = 100;
/** Inside a scroller, a touch waits this long to show its press (Android's TAP_TIMEOUT). */
const TAP_TIMEOUT_MS = 100;
/** How long an afterPress press shows before its screen changes: seen, yet still snappy. */
const HOLD_MS = 80;
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
  el.setAttribute('data-pressed', '');
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
    el.removeAttribute('data-pressed');
    return;
  }
  if (showTimer !== undefined) show(el);
  const left = PRESS_MS - (performance.now() - shownAt);
  // Counted from a painted frame (the tap's own work, like opening a page, may hold the
  // thread past PRESS_MS), on its own timer: a tap elsewhere meanwhile doesn't keep it down.
  requestAnimationFrame(() => setTimeout(() => el !== pressed && !waiting.has(el) && el.removeAttribute('data-pressed'), Math.max(0, left)));
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

/** Buttons whose action waits on their press (afterPress): the action lifts it. */
const waiting = new WeakSet<HTMLElement>();
/** The afterPress action waiting on its press, if any. */
let pending: (() => void) | null = null;

/** Runs the waiting action now, before whatever comes next. */
function flush(): void {
  pending?.();
}

if (typeof document !== 'undefined') {
  // Capture phase: before the next tap's own handlers (a tab, another Back) see it.
  document.addEventListener('pointerdown', flush, { capture: true, passive: true });
  document.addEventListener('keydown', flush, true);
  // Android back comes as this event (Capacitor): it closes what the waiting action opens.
  document.addEventListener('backbutton', flush, true);
}

/**
 * Runs `action`, which replaces the screen `el` is on, once `el`'s press has shown for
 * HOLD_MS; at once when it shows no press (keyboard, TalkBack). For a click handler:
 * `onClick={(e) => afterPress(e.currentTarget, open)}`. Any later tap, key or back runs the
 * waiting action first.
 */
export function afterPress(el: HTMLElement | null, action: () => void): void {
  flush();
  if (!el || (!el.hasAttribute('data-pressed') && pressed !== el)) return action();
  waiting.add(el);
  if (pressed === el) lift(false);
  const since = shownAt;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    pending = null;
    waiting.delete(el);
    action();
    setTimeout(() => pressed !== el && el.removeAttribute('data-pressed'), Math.max(0, PRESS_MS - (performance.now() - since)));
  };
  // rAF runs before the next paint; a task queued from it runs after that paint.
  frame = requestAnimationFrame(() => (timer = setTimeout(run, Math.max(0, HOLD_MS - (performance.now() - since)))));
  pending = run;
}
