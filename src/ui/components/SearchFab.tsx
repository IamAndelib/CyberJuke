import { Icon } from '../icons';
import { openSearch, pageSearchContext } from '../nav';

/**
 * Square search button pinned to the bottom-right of the tab content, so it always sits
 * just above the mini player (when one is showing) or the tab bar. Same double-rule
 * frame and checkered offset shadow as the Shuffle hero. It opens Search scoped to the
 * screen it sits on ("Here") when that screen registered a context.
 */
export function SearchFab() {
  const ctx = pageSearchContext.value;
  return (
    <div class="fab">
      <button
        class="fab-btn"
        aria-label={ctx ? `Search in ${ctx.label}` : 'Search the Jukebox'}
        onClick={() => openSearch(ctx)}
        data-testid="search-fab"
      >
        <Icon name="search" size={28} />
      </button>
      <div class="fab-shadow" aria-hidden="true" />
    </div>
  );
}
