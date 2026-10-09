import { useRef } from 'preact/hooks';
import { reducedMotion } from '../../core/motion';
import { dismissToast, holdToast, releaseToast, runToastAction, toasts } from '../../stores/toast';

/** A drag shorter than this, or more vertical than sideways, isn't a swipe. */
const SWIPE_SLOP_PX = 8;
/** Let go past this share of its width, or flicked faster than this, and it goes. */
const SWIPE_AWAY_FRACTION = 0.35;
const SWIPE_FLICK_PX_PER_MS = 0.5;
/** The fly-out (and spring-back), in the app's stepped motion. */
const SWIPE_ANIM_MS = 150;

export function Toasts() {
  return (
    <div class="toasts" aria-live="polite" data-testid="toasts">
      {toasts.value.map((t) => (
        <ToastItem key={t.id} id={t.id} text={t.text} action={t.action?.label} />
      ))}
    </div>
  );
}

interface Drag {
  pointer: number;
  x0: number;
  y0: number;
  dx: number;
  /** Past the slop and sideways: the toast follows the finger. */
  on: boolean;
  /** Horizontal speed at the last move (px/ms). */
  vx: number;
  lastX: number;
  lastT: number;
}

/** A toast that a sideways swipe (either way) dismisses; a short drag springs back. */
function ToastItem({ id, text, action }: { id: number; text: string; action?: string }) {
  const el = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  // A swipe that began on the button must not also press it.
  const swiped = useRef(false);

  const place = (dx: number, animate: boolean) => {
    const node = el.current;
    if (!node) return;
    node.style.transition = animate ? `transform ${SWIPE_ANIM_MS}ms steps(3), opacity ${SWIPE_ANIM_MS}ms steps(3)` : 'none';
    node.style.transform = dx ? `translateX(${dx}px)` : '';
    node.style.opacity = dx ? String(Math.max(0.2, 1 - Math.abs(dx) / node.offsetWidth)) : '';
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    swiped.current = false;
    drag.current = { pointer: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, on: false, vx: 0, lastX: e.clientX, lastT: e.timeStamp };
  };

  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (!d.on) {
      if (Math.abs(dy) > SWIPE_SLOP_PX && Math.abs(dy) > Math.abs(dx)) {
        drag.current = null; // a vertical move: not ours
        return;
      }
      if (Math.abs(dx) < SWIPE_SLOP_PX) return;
      d.on = true;
      holdToast(id);
      el.current?.setPointerCapture(e.pointerId);
    }
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.vx = (e.clientX - d.lastX) / dt;
    d.lastX = e.clientX;
    d.lastT = e.timeStamp;
    d.dx = dx;
    place(dx, false);
  };

  const onPointerEnd = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    drag.current = null;
    if (!d.on) return;
    swiped.current = true;
    const width = el.current?.offsetWidth ?? 1;
    const flick = Math.abs(d.vx) > SWIPE_FLICK_PX_PER_MS && Math.sign(d.vx) === Math.sign(d.dx);
    if (e.type === 'pointerup' && (Math.abs(d.dx) > width * SWIPE_AWAY_FRACTION || flick)) {
      if (reducedMotion()) {
        dismissToast(id);
        return;
      }
      place(Math.sign(d.dx) * (width + 48), true);
      setTimeout(() => dismissToast(id), SWIPE_ANIM_MS);
      return;
    }
    place(0, !reducedMotion());
    releaseToast(id);
  };

  return (
    <div
      ref={el}
      class={'toast' + (action ? ' has-action' : '')}
      data-testid="toast"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <span class="toast-text">{text}</span>
      {action && (
        <button
          type="button"
          class="toast-action"
          onClick={() => {
            // The click that ends a swipe begun on the button isn't a press.
            if (swiped.current) return;
            runToastAction(id);
          }}
          data-testid="toast-action"
        >
          [{action}]
        </button>
      )}
    </div>
  );
}
