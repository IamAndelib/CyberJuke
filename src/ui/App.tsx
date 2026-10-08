import { useEffect } from 'preact/hooks';
import { player } from '../player';
import { online } from '../store/network';
import { Icon, type IconName } from './icons';
import { goBack, nowPlayingOpen, openAlbum, openArtist, openGenre, openReleases, searchOpen, searchOverAlbum, tab, type Tab } from './nav';
import { ArtistChooser, MiniPlayer, NowPlaying, Toasts, TrackMenu } from './components/PlayerUI';
import { SearchFab } from './components/SearchFab';
import { AlbumPage } from './screens/Album';
import { Artists } from './screens/Artists';
import { Genres } from './screens/Genres';
import { Home } from './screens/Home';
import { Library } from './screens/Library';
import { Search } from './screens/Search';
import { Settings } from './screens/Settings';

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'genres', label: 'Genres', icon: 'genres' },
  { id: 'artists', label: 'Artists', icon: 'artists' },
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
            // Re-tapping Genres/Artists goes back to the grid.
            const onTop = searchOpen.value || openAlbum.value;
            if (t.id === 'genres' && cur === 'genres' && !onTop) openGenre.value = null;
            if (t.id === 'artists' && cur === 'artists' && !onTop) {
              openArtist.value = null;
              openReleases.value = null;
            }
            searchOpen.value = false;
            searchOverAlbum.value = false;
            openAlbum.value = null;
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
  const album = openAlbum.value;
  const covered = searching || !!album;
  // Search over an album page sits on top of it; otherwise an album sits over search.
  const searchTop = searching && searchOverAlbum.value;
  // The search button also shows on an album page (searching it is "Here").
  const showFab = !searching && (!!album || cur !== 'settings');

  // Escape closes overlays on the web (Android back is wired in main.tsx).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') goBack(false);
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
        <div class="tab-content" inert={covered ? true : undefined} aria-hidden={covered ? true : undefined}>
          {cur === 'home' && <Home />}
          {cur === 'genres' && <Genres />}
          {cur === 'artists' && <Artists />}
          {cur === 'library' && <Library />}
          {cur === 'settings' && <Settings />}
        </div>
        {searching && (
          <div
            class={'layer' + (searchTop ? ' search-top' : '')}
            inert={album && !searchTop ? true : undefined}
            aria-hidden={album && !searchTop ? true : undefined}
          >
            <Search />
          </div>
        )}
        {album && (
          <div class="layer album-layer" inert={searchTop ? true : undefined} aria-hidden={searchTop ? true : undefined}>
            <AlbumPage key={album.url} album={album} />
          </div>
        )}
        {showFab && <SearchFab />}
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
      <ArtistChooser />
      <Toasts />
    </>
  );
}
