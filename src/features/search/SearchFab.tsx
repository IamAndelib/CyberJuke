import { useEffect, useRef } from 'preact/hooks';
import { Icon } from '../../ui/icons';
import { openSearch, pageSearchContext, tab } from '../../ui/nav';
import { usePress } from '../../ui/usePress';

/** Scrolling this far in one direction hides (down) or shows (up) the button. */
const FAB_SCROLL_PX = 24;
/** Within this distance of the top the button always shows. */
const FAB_TOP_PX = 24;

/**
 * Square search button pinned to the bottom-right of the tab content, so it always sits
 * just above the mini player (when one is showing) or the tab bar. Same double-rule
 * frame and checkered offset shadow as the Shuffle hero. It opens Search scoped to the
 * screen it sits on ("Here") when that screen registered a context.
 *
 * Like Material's FABs, it tucks away while a screen scrolls down (so it never covers
 * the ⋯ buttons it passes) and comes back on the way up and at the top. Jumps of more
 * than a screen (a restored position, back-to-top) don't count as scrolling. The class
 * is set directly: scrolling re-renders nothing.
 */
export function SearchFab() {
  const ctx = pageSearchContext.value;
  const cur = tab.value;
  const dock = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  usePress(btn);

  // Another tab or page: back in view until that one scrolls down.
  useEffect(() => dock.current?.classList.remove('away'), [ctx, cur]);

  useEffect(() => {
    const last = new WeakMap<Element, { y: number; anchor: number }>();
    const show = (on: boolean) => dock.current?.classList.toggle('away', !on);
    const onScroll = (e: Event) => {
      const el = e.target;
      if (!(el instanceof HTMLElement) || !el.classList.contains('screen')) return;
      const y = el.scrollTop;
      const prev = last.get(el);
      if (!prev || Math.abs(y - prev.y) > el.clientHeight) {
        // A new screen, or a jump: show it, and count from here.
        last.set(el, { y, anchor: y });
        return show(true);
      }
      prev.y = y;
      if (y <= FAB_TOP_PX) {
        prev.anchor = y;
        return show(true);
      }
      const moved = y - prev.anchor;
      if (moved > FAB_SCROLL_PX) show(false);
      else if (moved < -FAB_SCROLL_PX) show(true);
      // The anchor follows the finger past the turning point, so a reversal counts from there.
      if (Math.abs(moved) > FAB_SCROLL_PX) prev.anchor = y;
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', onScroll, { capture: true });
  }, []);

  return (
    <div class="fab" ref={dock}>
      <button
        ref={btn}
        class="pixel-btn"
        aria-label={ctx ? `Search in ${ctx.label}` : 'Search the Jukebox'}
        onClick={() => openSearch(ctx)}
        data-testid="search-fab"
      >
        <Icon name="search" size={28} />
      </button>
      <div class="pixel-shadow" aria-hidden="true" />
    </div>
  );
}
