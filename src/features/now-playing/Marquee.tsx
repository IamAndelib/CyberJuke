/**
 * One line of text that scrolls right to left when it doesn't fit (U1): the Now Playing
 * title and artist, the mini player's title. Text that fits, reduced motion, and an
 * inactive marquee keep the usual "…".
 *
 * A ResizeObserver measures whether the text overflows. If it does, a second copy is
 * drawn after a gap (a CSS ::after of the same text, so it isn't in the DOM's text), and
 * a Web Animation moves both left by one copy and its gap, then starts over: it holds
 * still for MARQUEE_HOLD_MS at the start of every loop and moves at MARQUEE_PX_S, so
 * long and short titles go at the same pace. A transform animation runs on the
 * compositor; it pauses while the page is hidden.
 */
import { useEffect, useRef } from 'preact/hooks';
import { reducedMotion } from '../../core/motion';

const MARQUEE_PX_S = 36;
const MARQUEE_HOLD_MS = 1500;
/** Space between the end of the text and its repeat. */
const MARQUEE_GAP_PX = 48;

export function Marquee({ text, active = true }: { text: string; active?: boolean }) {
  const box = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = box.current;
    const span = inner.current;
    if (!el || !span) return;
    let anim: Animation | null = null;
    let width = 0;
    const stop = () => {
      anim?.cancel();
      anim = null;
      el.classList.remove('run');
    };
    /** The text's own width (the ::after copy excluded). */
    const textWidth = () => {
      const node = span.firstChild;
      if (!node) return 0;
      const r = document.createRange();
      r.selectNodeContents(node);
      return r.getBoundingClientRect().width;
    };
    const update = () => {
      const w = textWidth();
      const room = el.clientWidth;
      const fits = w <= room + 1;
      if (!active || fits || reducedMotion() || typeof span.animate !== 'function') return stop();
      if (anim && Math.abs(w - width) < 1) return;
      stop();
      width = w;
      const shift = w + MARQUEE_GAP_PX;
      const travel = (shift / MARQUEE_PX_S) * 1000;
      const total = MARQUEE_HOLD_MS + travel;
      el.classList.add('run');
      el.style.setProperty('--marquee-gap', `${MARQUEE_GAP_PX}px`);
      anim = span.animate(
        [
          { transform: 'translateX(0)', offset: 0 },
          { transform: 'translateX(0)', offset: MARQUEE_HOLD_MS / total },
          { transform: `translateX(${-shift}px)`, offset: 1 },
        ],
        { duration: total, iterations: Infinity, easing: 'linear' },
      );
      if (document.hidden) anim.pause();
    };
    const onVisibility = () => {
      if (!anim) return;
      if (document.hidden) anim.pause();
      else anim.play();
    };
    update();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(() => update());
      ro.observe(el);
      ro.observe(span);
    }
    document.addEventListener('visibilitychange', onVisibility);
    const motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    motion?.addEventListener('change', update);
    return () => {
      ro?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      motion?.removeEventListener('change', update);
      stop();
    };
  }, [text, active]);

  return (
    <span class="marquee" ref={box}>
      <span class="marquee-text" ref={inner} data-text={text}>
        {text}
      </span>
    </span>
  );
}
