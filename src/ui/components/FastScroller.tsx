import type { RefObject } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

/** The thumb fades this long after scrolling stops. */
export const SCROLLBAR_HIDE_MS = 1200;
/** The A–Z letter popup fades this long after a drag of the thumb ends. */
export const LETTER_HIDE_MS = 600;
/** Lists longer than this many screens get a draggable thumb. */
export const DRAG_SCREENS = 3;
const MIN_THUMB = 48;

/**
 * Overlay scrollbar for a `Screen` (the native one is hidden): a thin thumb on the right
 * edge that shows while scrolling and fades after. On long lists the thumb can be
 * dragged (44px-wide touch area). With `az`, the letter of the `.az-head` section at
 * the top of the list shows in a centred box only while the thumb is dragged (never on
 * ordinary scrolling), fading LETTER_HIDE_MS after the drag ends.
 *
 * Lives in a zero-height sticky dock at the top of the scroller, so it stays put while
 * the content scrolls; everything is updated directly in a requestAnimationFrame.
 */
export function FastScroller({
  scroller,
  az,
  onDragStart,
}: {
  scroller: RefObject<HTMLDivElement | null>;
  az: boolean;
  /** A drag of the thumb begins (the Screen cancels a pending scroll-memory restore). */
  onDragStart?: () => void;
}) {
  const dragStart = useRef(onDragStart);
  dragStart.current = onDragStart;
  const box = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const azRef = useRef(az);
  azRef.current = az;
  const st = useRef({
    frame: 0,
    hideT: 0 as ReturnType<typeof setTimeout> | 0,
    popT: 0 as ReturnType<typeof setTimeout> | 0,
    dragging: false,
    grab: 0,
    letter: '',
    heads: [] as { top: number; letter: string }[],
    headsFor: -1,
    /** Sizes, measured when the scroller or its content resizes (never per scroll frame). */
    size: null as { head: number; client: number; scroll: number; trackH: number; thumbH: number } | null,
  });

  const headerHeight = (el: HTMLElement) => (el.querySelector(':scope > .topbar') as HTMLElement | null)?.offsetHeight ?? 0;

  /** Section letter at the top of the visible list. */
  const currentLetter = (el: HTMLElement, head: number, scroll: number): string => {
    const s = st.current;
    if (s.headsFor !== scroll) {
      const base = el.getBoundingClientRect().top - el.scrollTop;
      s.heads = Array.from(el.querySelectorAll<HTMLElement>('.az-head')).map((h) => ({
        top: h.getBoundingClientRect().top - base,
        letter: h.dataset.letter ?? '',
      }));
      s.headsFor = scroll;
    }
    const line = el.scrollTop + head + 8;
    let cur = s.heads[0]?.letter ?? '';
    for (const h of s.heads) {
      if (h.top <= line) cur = h.letter;
      else break;
    }
    return cur;
  };

  /** Read every size and lay out the dock, track and thumb height (on resize only). */
  const measure = () => {
    const s = st.current;
    const el = scroller.current;
    const b = box.current;
    const tr = track.current;
    const th = thumb.current;
    if (!el || !b || !tr || !th) return;
    const head = headerHeight(el);
    const client = el.clientHeight;
    const scroll = el.scrollHeight;
    b.style.top = `${head}px`;
    b.style.height = `${Math.max(0, client - head)}px`;
    if (popup.current) popup.current.style.top = `${head + (client - head) / 2}px`;
    const scrollable = scroll - client > 1;
    b.classList.toggle('none', !scrollable);
    b.classList.toggle('draggable', scroll > client * DRAG_SCREENS);
    const trackH = scrollable ? tr.clientHeight : 0;
    const thumbH = Math.min(trackH, Math.max(MIN_THUMB, (trackH * client) / scroll));
    th.style.height = `${thumbH}px`;
    s.size = { head, client, scroll, trackH, thumbH };
  };

  /** Move the thumb (and the A–Z letter) for the current scrollTop, from the cached sizes. */
  const layout = () => {
    const s = st.current;
    s.frame = 0;
    const el = scroller.current;
    const th = thumb.current;
    if (!s.size) measure();
    const z = s.size;
    if (!el || !th || !z) return;
    const max = z.scroll - z.client;
    if (max <= 1) return;
    const y = (Math.min(max, Math.max(0, el.scrollTop)) / max) * (z.trackH - z.thumbH);
    th.style.transform = `translateY(${y}px)`;
    if (azRef.current) {
      const l = currentLetter(el, z.head, z.scroll);
      if (l !== s.letter) {
        s.letter = l;
        if (popup.current) popup.current.firstElementChild!.textContent = l;
      }
    }
  };

  const schedule = () => {
    if (!st.current.frame) st.current.frame = requestAnimationFrame(layout);
  };

  /** Show the thumb, then fade it after a pause. */
  const wake = () => {
    const s = st.current;
    box.current?.classList.add('on');
    clearTimeout(s.hideT);
    s.hideT = setTimeout(() => {
      if (!s.dragging) box.current?.classList.remove('on');
    }, SCROLLBAR_HIDE_MS);
  };

  /** The A–Z letter popup: on for the whole drag, fading LETTER_HIDE_MS after it ends. */
  const showLetter = (on: boolean) => {
    const s = st.current;
    clearTimeout(s.popT);
    if (on) {
      if (azRef.current) popup.current?.classList.add('on');
      return;
    }
    s.popT = setTimeout(() => popup.current?.classList.remove('on'), LETTER_HIDE_MS);
  };

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      schedule();
      wake();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(() => {
        st.current.headsFor = -1;
        st.current.size = null;
        schedule();
      });
      ro.observe(el);
      for (const part of el.querySelectorAll(':scope > .screen-body, :scope > .topbar')) ro.observe(part);
    }
    schedule();
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro?.disconnect();
      // st holds plain timer state (not a DOM node); its latest values are what to clear.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const s = st.current;
      cancelAnimationFrame(s.frame);
      s.frame = 0;
      clearTimeout(s.hideT);
      clearTimeout(s.popT);
    };
    // Mount-only: `scroller` is a stable ref and `schedule` reads only refs (UX rework pending).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    st.current.headsFor = -1;
    st.current.letter = '';
    if (!az) popup.current?.classList.remove('on');
    schedule();
    // `schedule` reads only refs; the effect is about `az` (UX rework pending).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [az]);

  const scrollToPointer = (clientY: number) => {
    const el = scroller.current;
    const tr = track.current;
    const th = thumb.current;
    if (!el || !tr || !th) return;
    const r = tr.getBoundingClientRect();
    const span = r.height - th.offsetHeight;
    if (span <= 0) return;
    const frac = Math.min(1, Math.max(0, (clientY - r.top - st.current.grab) / span));
    el.scrollTop = frac * (el.scrollHeight - el.clientHeight);
    schedule();
    wake();
  };

  const onPointerDown = (e: PointerEvent) => {
    const b = box.current;
    const th = thumb.current;
    if (!b?.classList.contains('draggable') || !th) return;
    e.preventDefault();
    e.stopPropagation();
    const s = st.current;
    const tr = th.getBoundingClientRect();
    const inThumb = e.clientY >= tr.top && e.clientY <= tr.bottom;
    s.grab = inThumb ? e.clientY - tr.top : th.offsetHeight / 2;
    s.dragging = true;
    b.classList.add('dragging');
    showLetter(true);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    // A pending scroll-memory restore must not fight the drag.
    dragStart.current?.();
    scrollToPointer(e.clientY);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!st.current.dragging) return;
    e.preventDefault();
    scrollToPointer(e.clientY);
  };
  const onPointerUp = (e: PointerEvent) => {
    const s = st.current;
    if (!s.dragging) return;
    s.dragging = false;
    box.current?.classList.remove('dragging');
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    wake();
    showLetter(false);
  };
  // Keep pull-to-refresh (touch handlers on the scroller) out of a drag.
  const stop = (e: Event) => {
    if (box.current?.classList.contains('draggable')) e.stopPropagation();
  };

  return (
    <div class="sb-dock" aria-hidden="true">
      <div class="sb none" ref={box} data-testid="scrollbar">
        <div class="sb-track" ref={track}>
          <div
            class="sb-thumb"
            ref={thumb}
            data-testid="scroll-thumb"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onTouchStart={stop}
            onTouchMove={stop}
            onTouchEnd={stop}
          >
            <span class="sb-bar" />
          </div>
        </div>
      </div>
      {az && (
        <div class="az-pop" ref={popup} data-testid="az-popup">
          <span class="az-pop-letter" />
          <span class="az-pop-shadow" />
        </div>
      )}
    </div>
  );
}
