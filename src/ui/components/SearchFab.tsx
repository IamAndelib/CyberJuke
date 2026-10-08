import { Icon } from '../icons';
import { searchOpen } from '../nav';
import { searchMode } from '../screens/Search';

/**
 * Square search button pinned to the bottom-right of the tab content, so it always sits
 * just above the mini player (when one is showing) or the tab bar. Same double-rule
 * frame and checkered offset shadow as the Shuffle hero.
 */
export function SearchFab() {
  return (
    <div class="fab">
      <button class="fab-btn" aria-label="Search the Jukebox" onClick={() => {
          searchMode.value = 'jukebox';
          searchOpen.value = true;
        }} data-testid="search-fab">
        <Icon name="search" size={28} />
      </button>
      <div class="fab-shadow" aria-hidden="true" />
    </div>
  );
}
