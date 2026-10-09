// Styles, in cascade order: tokens and themes, base, the shell, shared components, then
// each feature's own. Later files may build on earlier ones, never the other way round.
import '../styles/fonts.css';
import '../styles/tokens.css';
import '../styles/themes.css';
import '../styles/base.css';
import './shell.css';
import '../ui/ui.css';
import '../features/home/home.css';
import '../features/genres/genres.css';
import '../features/artists/artists.css';
import '../features/search/search.css';
import '../features/library/library.css';
import '../features/settings/settings.css';
import '../features/now-playing/now-playing.css';
// Buttons in the app's chrome act on a tap even while a list is still gliding.
import '../ui/tapThrough';
import { render } from 'preact';
import { effect } from '@preact/signals';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { StatusBar, Style } from '@capacitor/status-bar';
import { installRenderCounter } from '../core/renderCount';
import { describeError } from '../core/errors';
import { logError } from '../core/log';
import { TEST_HOOKS } from '../core/testHooks';
import { loadLibrary, settings } from '../stores/library';
import { onReconnect, watchNetwork } from '../core/network';
import { catalog } from '../stores/catalog';
import { startFreshness } from '../stores/newTracks';
import { startAccount } from '../stores/account';
import { auth } from '../data/auth';
import { goBack, openNowPlayingWhen } from '../ui/nav';
import { retryWatchedFeeds } from '../stores/feed';
import { JukePlayer } from '../player/native';
import { hasCurrent, startPlayerPrefs, startQueuePurge } from '../player';
import { startUpdates } from '../stores/updates';
import { playFrom, radio } from '../ui/playAll';
import { startBlockEvents } from '../player/blockEvents';
import { source } from '../data';
import { App, Overlays } from './App';
import { BootError } from './BootError';
import { Home } from '../features/home/Home';
import { Library } from '../features/library/Library';
import { Screen } from '../ui/components/Screen';
import { whenIdle } from '../core/idle';
import { TrackRow } from '../ui/components/TrackRow';
import { MiniPlayer, NowPlaying } from '../features/now-playing/PlayerUI';
import { ArtistGrid, ArtistTile, ArtistTiles } from '../features/artists/Artists';
import { ArtistPage } from '../features/artists/Artist';
import { GenreDetail, GenreGrid, GenreTile, GenreTiles } from '../features/genres/Genres';

const native = Capacitor.isNativePlatform();

/** Nothing fails silently: anything not handled where it happened is logged here. */
function catchStrays(): void {
  window.addEventListener('unhandledrejection', (e) => {
    logError('unhandled rejection', e.reason);
  });
  window.addEventListener('error', (e) => {
    logError('uncaught error', e.error ?? e.message);
  });
}

function applyTheme(): void {
  effect(() => {
    const theme = settings.value.theme;
    const root = document.documentElement;
    root.dataset.theme = theme;
    const cs = getComputedStyle(root);
    const bg = cs.getPropertyValue('--color-bg').trim();
    const dark = cs.getPropertyValue('--scheme').trim() !== 'light';
    root.style.colorScheme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
    if (native) {
      StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(() => {});
    }
  });
}

/** A tap on the media notification opens Now Playing. */
function wireNotificationTap(): void {
  if (!native) return;
  JukePlayer.addListener('openNowPlaying', () => openNowPlayingWhen(hasCurrent)).catch((e) => logError('openNowPlaying', e));
}

function wireBackButton(): void {
  if (!native) return;
  CapApp.addListener('backButton', () => {
    if (!goBack()) {
      // Keep music playing: background the app instead of finishing the activity.
      CapApp.minimizeApp().catch(() => CapApp.exitApp());
    }
  }).catch((e) => logError('backButton', e));
}

/**
 * CI hook: start playing the newest track on launch. Native honours the launch extra
 * only on debuggable builds; the browser's ?autoplay=latest exists in dev/test builds only.
 */
async function maybeAutoplay(): Promise<void> {
  let want: string | undefined;
  if (native) {
    want = (await JukePlayer.getLaunchOptions().catch(() => ({}) as { autoplay?: 'latest' })).autoplay;
  } else if (TEST_HOOKS) {
    want = new URLSearchParams(location.search).get('autoplay') ?? undefined;
  }
  if (want !== 'latest') return;
  const page = await source.latest();
  if (page.tracks.length) await playFrom(page.tracks, 0, radio('Home · Latest'));
}

/**
 * Load the catalog in the background once the first screen has painted, and bring it
 * up to date when the app comes back to the foreground or back online. The store's
 * own rules decide whether that means a request (at most hourly) or nothing.
 */
function startCatalog(): void {
  const kick = () => void catalog.refresh();
  whenIdle(kick, 1500, 300);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick();
  });
  onReconnect(kick);
}

async function boot(): Promise<void> {
  // e2e: the boot-failure screen.
  if (TEST_HOOKS && localStorage.getItem('__cyberjukeFailBoot')) throw new Error('Simulated boot failure');
  installRenderCounter({ App, Overlays, Home, Library, Screen, TrackRow, MiniPlayer, NowPlaying, ArtistGrid, ArtistTiles, ArtistTile, ArtistPage, GenreGrid, GenreTiles, GenreTile, GenreDetail });
  // A saved Cyberspace login decides which query the first requests use.
  await Promise.all([loadLibrary().catch((e) => logError('loadLibrary', e)), auth.restore()]);
  startAccount();
  startQueuePurge();
  startPlayerPrefs();
  applyTheme();
  watchNetwork();
  // Back online: lists on screen that failed to load try again.
  onReconnect(() => retryWatchedFeeds());
  wireBackButton();
  wireNotificationTap();
  startBlockEvents();
  const root = document.getElementById('app')!;
  render(
    <>
      <App />
      <Overlays />
    </>,
    root,
  );
  startCatalog();
  startFreshness();
  void startUpdates(native ? () => JukePlayer.getAppInfo() : undefined);
  maybeAutoplay().catch((e) => logError('autoplay', e));
}

catchStrays();
boot().catch((e) => {
  logError('boot', e);
  const root = document.getElementById('app');
  if (root) render(<BootError detail={describeError(e)} onRetry={() => location.reload()} />, root);
});
