import type { ComponentChildren } from 'preact';
import { Icon } from '../icons';

/** What a tile is: its test ids (`genre-cell`, `artist-fav`…), data attribute and name style. */
export type TileKind = 'genre' | 'artist';

/**
 * A star tap moves its tile out (into ★ Favourites, or back to the grid), and the next tile
 * slides into its place: a tap at the same spot this soon after (a double tap, or a tap before
 * the move was seen) is ignored rather than landing on that tile.
 */
const SETTLE_MS = 650;
const SAME_SPOT_PX = 32;
let moved: { x: number; y: number; t: number } | null = null;

function tooSoon(e: MouseEvent): boolean {
  // A keyboard press (detail 0) has no spot.
  if (!moved || e.detail === 0) return false;
  return performance.now() - moved.t < SETTLE_MS && Math.abs(e.clientX - moved.x) < SAME_SPOT_PX && Math.abs(e.clientY - moved.y) < SAME_SPOT_PX;
}

/** Focus was on the star that moved: it goes to the same star in its new place. */
function refocus(screen: Element | null, kind: TileKind, name: string): void {
  requestAnimationFrame(() => {
    const sel = `[data-testid="${kind}-fav"][data-${kind}="${CSS.escape(name)}"]`;
    (screen ?? document).querySelector<HTMLElement>(sel)?.focus({ preventScroll: true });
  });
}

/**
 * A genre or artist tile with its star. In the main grid (`inGrid`) a favourite isn't shown:
 * it sits in ★ Favourites above instead, and comes back to its place here when unstarred.
 */
export function FavTile({
  kind,
  name,
  fav,
  inGrid,
  onOpen,
  onToggle,
}: {
  kind: TileKind;
  name: string;
  fav: boolean;
  inGrid?: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) {
  if (inGrid && fav) return null;
  const data = { [`data-${kind}`]: name };
  return (
    <div class={'genre-cell' + (fav ? ' fav' : '')} data-testid={`${kind}-cell`} {...data}>
      <button class="genre-tile" onClick={(e) => !tooSoon(e) && onOpen()} data-testid={`${kind}-tile`} {...data}>
        <span class={`${kind}-name`}>{name}</span>
      </button>
      <button
        class={'genre-fav' + (fav ? ' on' : '')}
        aria-pressed={fav}
        aria-label={fav ? `Remove ${name} from favourites` : `Add ${name} to favourites`}
        onClick={(e) => {
          if (tooSoon(e)) return;
          const star = e.currentTarget;
          const focused = document.activeElement === star;
          moved = { x: e.clientX, y: e.clientY, t: performance.now() };
          onToggle();
          if (focused) refocus(star.closest('.screen'), kind, name);
        }}
        data-testid={`${kind}-fav`}
        {...data}
      >
        <Icon name={fav ? 'star' : 'starOutline'} size={20} />
      </button>
    </div>
  );
}

/** ★ Favourites above a grid (its tiles, in the order added), then the grid's own heading. */
export function FavSection({ testid, allTitle, children }: { testid: string; allTitle: string; children: ComponentChildren }) {
  return (
    <>
      <section data-testid={testid}>
        <div class="section-head">
          <h2 class="section-title">★ Favourites</h2>
        </div>
        <div class="genre-grid">{children}</div>
      </section>
      <div class="section-head">
        <h2 class="section-title">{allTitle}</h2>
      </div>
    </>
  );
}

/** The star in a genre or artist page's top bar (it follows a star given anywhere else). */
export function PageStar({ name, fav, onToggle, testid }: { name: string; fav: boolean; onToggle: () => void; testid: string }) {
  return (
    <button
      class={'icon-btn like' + (fav ? ' on' : '')}
      aria-pressed={fav}
      aria-label={fav ? `Remove ${name} from favourites` : `Add ${name} to favourites`}
      onClick={onToggle}
      data-testid={testid}
    >
      <Icon name={fav ? 'star' : 'starOutline'} size={26} />
    </button>
  );
}
