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
 * `afterPress` is for a button whose action replaces the screen it is on (Settings, a
 * Back arrow, a tile that opens a page): acting at once would take the press away before
 * it painted. Like Android's View, which posts its click so the pressed state draws
 * first, the action runs once the press has painted a frame, and the screen's exit motion
 * keeps it in sight. A tap or key that comes sooner runs the waiting action first, so it
 * never lands on the screen the next tap opened.
 */
/** The shortest a press shows (Android shows a tap's for 64 ms; a little longer reads better). */
export const PRESS_MS = 100;
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
let hideTimer: ReturnType<typeof setTimeout> | undefined;

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
  const off = () => {
    if (!waiting.has(el)) el.classList.remove('pressed');
  };
  if (left <= 0) off();
  else hideTimer = setTimeout(off, left);
}

function down(e: PointerEvent): void {
  if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const el = (e.target as Element | null)?.closest?.<HTMLElement>(TARGET);
  if (pressed) lift(true);
  if (!el || (el as HTMLButtonElement).disabled) return;
  clearTimeout(hideTimer);
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

/** Buttons whose action waits on their press (usePressThen): the action lifts it. */
const waiting = new WeakSet<HTMLElement>();
/** The usePressThen action waiting on its press, if any. */
let pending: (() => void) | null = null;

/** Runs the waiting action now, before whatever comes next. */
function flush(): void {
  pending?.();
}

if (typeof document !== 'undefined') {
  // Capture phase: before the next tap's own handlers (a tab, another Back) see it.
  document.addEventListener('pointerdown', flush, { capture: true, passive: true });
  document.addEventListener('keydown', flush, true);
}

/**
 * Runs `action`, which replaces the screen `el` is on, once `el`'s press has painted a
 * frame; at once when it shows no press (keyboard, TalkBack). For a click handler:
 * `onClick={(e) => afterPress(e.currentTarget, open)}`. A second click while one waits
 * does nothing, and any later tap or key runs the waiting action first.
 */
export function afterPress(el: HTMLElement | null, action: () => void): void {
  flush();
  if (!el || (!el.classList.contains('pressed') && pressed !== el)) return action();
  if (waiting.has(el)) return;
  waiting.add(el);
  if (pressed === el) lift(false);
  const since = shownAt;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    pending = null;
    action();
    waiting.delete(el);
    // Still pressed as its screen leaves (the exit motion), then eased back as usual.
    setTimeout(() => pressed !== el && el.classList.remove('pressed'), Math.max(0, PRESS_MS - (performance.now() - since)));
  };
  // rAF runs before the next paint; a task queued from it runs after that paint.
  frame = requestAnimationFrame(() => (timer = setTimeout(run, 0)));
  pending = run;
}
