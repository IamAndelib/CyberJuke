import { useEffect } from 'preact/hooks';
import { player } from '../player';
import { online } from '../store/network';
import { Icon, type IconName } from './icons';
import { menuTrack, nowPlayingOpen, openGenre, searchOpen, tab, type Tab } from './nav';
import { MiniPlayer, NowPlaying, Toasts, TrackMenu } from './components/PlayerUI';
import { SearchFab } from './components/SearchFab';
import { Genres } from './screens/Genres';
import { Home } from './screens/Home';
import { Library } from './screens/Library';
import { Search } from './screens/Search';
import { Settings } from './screens/Settings';

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'genres', label: 'Genres', icon: 'genres' },
  { id: 'library', label: 'Library', icon: 'library' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

function TabBar() {
  const cur = tab.value;
  return (
    <nav class="tabbar" aria-label="Main">
      {TABS.map((t) => (
        <button
          key={t.id}
          class={'tab' + (cur === t.id ? ' on' : '')}
          aria-current={cur === t.id ? 'page' : undefined}
          onClick={() => {
            // Re-tapping Genres goes back to the grid.
            if (t.id === 'genres' && cur === 'genres' && !searchOpen.value) openGenre.value = null;
            searchOpen.value = false;
            tab.value = t.id;
          }}
          data-testid={`tab-${t.id}`}
        >
          <Icon name={t.icon} size={24} />
          <span class="tab-label">{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

export function App() {
  const cur = tab.value;
  const hasPlayer = !!player.state.value.current;
  const searching = searchOpen.value;
  const showFab = cur !== 'settings' && !searching;

  // Escape closes overlays on the web (Android back is wired in main.tsx).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (menuTrack.value) menuTrack.value = null;
      else if (nowPlayingOpen.value) nowPlayingOpen.value = false;
      else if (searchOpen.value) searchOpen.value = false;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div class={'app' + (hasPlayer ? ' has-player' : '') + (showFab ? ' has-fab' : '')} inert={nowPlayingOpen.value ? true : undefined}>
      {!online.value && (
        <div class="offline-banner" role="status" data-testid="offline-banner">
          [ offline ] showing what's already loaded
        </div>
      )}
      <main class="main">
        <div class="tab-content" inert={searching ? true : undefined} aria-hidden={searching ? true : undefined}>
          {cur === 'home' && <Home />}
          {cur === 'genres' && <Genres />}
          {cur === 'library' && <Library />}
          {cur === 'settings' && <Settings />}
        </div>
        {showFab && <SearchFab />}
        {searching && <Search />}
      </main>
      <MiniPlayer />
      <TabBar />
    </div>
  );
}

export function Overlays() {
  return (
    <>
      <NowPlaying />
      <TrackMenu />
      <Toasts />
    </>
  );
}
