// Styles, in cascade order: tokens and themes, base, the shell, shared components, then
// each feature's own. Later files may build on earlier ones, never the other way round.
import '../styles/fonts.css';
import '../styles/tokens.css';
import '../styles/themes.css';
import '../styles/base.css';
import './shell.css';
import '../ui/ui.css';
import '../features/home/home.css';
import '../features/radio/radio.css';
import '../features/genres/genres.css';
import '../features/artists/artists.css';
import '../features/search/search.css';
import '../features/library/library.css';
import '../features/settings/settings.css';
import '../features/now-playing/now-playing.css';
// Buttons in the app's chrome act on a tap even while a list is still gliding.
import '../ui/tapThrough';
import { installPress } from '../ui/press';
import { render } from 'preact';
import { computed, effect } from '@preact/signals';
import { Capacitor } from '@capacitor/core';
import { installRenderCounter } from '../core/renderCount';
import { describeError } from '../core/errors';
import { logError } from '../core/log';
import { TEST_HOOKS } from '../core/testHooks';
import { mark } from '../core/marks';
import { loadLists, loadSettings, settings } from '../stores/library';
import { onReconnect, online, watchNetwork } from '../core/network';
import { catalog } from '../stores/catalog';
import { startFreshness } from '../stores/newTracks';
import { startAccount } from '../stores/account';
import { auth } from '../data/auth';
import { openNowPlayingWhen, openSettings } from '../ui/nav';
import { retryWatchedFeeds } from '../stores/feed';
import { JukePlayer } from '../player/native';
import { hasCurrent, setOpenLiked, startPlayerPrefs, startQueuePurge } from '../player';
import { startListeningCache } from '../player/listeningCache';
import { startUpdates } from '../stores/updates';
import { playFrom, radio } from '../ui/playAll';
import { startBlockEvents } from '../player/blockEvents';
import { source } from '../data';
import { App, Overlays } from './App';
import { BootError } from './BootError';
import { firstScreenShown, keepThemeBackground, styleSystemBars } from './windowChrome';
import { wireBack } from './back';
import { Home } from '../features/home/Home';
import { Library, openLiked } from '../features/library/Library';
import { Screen } from '../ui/components/Screen';
import { whenIdle } from '../core/idle';
import { TrackRow } from '../ui/components/TrackRow';
import { artGen } from '../ui/components/Art';
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
  // Only the theme: another setting changing mustn't restyle the page or call the status bar.
  const theme = computed(() => settings.value.theme);
  effect(() => {
    const t = theme.value;
    const root = document.documentElement;
    root.dataset.theme = t;
    const cs = getComputedStyle(root);
    const bg = cs.getPropertyValue('--color-bg').trim();
    const dark = cs.getPropertyValue('--scheme').trim() !== 'light';
    root.style.colorScheme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
    styleSystemBars(dark);
    keepThemeBackground(bg);
  });
}

/** A tap on the media notification opens Now Playing. */
function wireNotificationTap(): void {
  if (!native) return;
  JukePlayer.addListener('openNowPlaying', () => openNowPlayingWhen(hasCurrent)).catch((e) => logError('openNowPlaying', e));
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

/** Longest that background work waits for Home's first page (a slow or hung request). */
const FIRST_PAGE_WAIT_MS = 5000;

/**
 * Run `fn` once Home's first page has settled (answered or failed), or after
 * FIRST_PAGE_WAIT_MS, whichever comes first: the catalog's download and the update
 * check don't compete with the request the first screen waits for.
 */
function afterFirstPage(first: Promise<unknown>, fn: () => void): void {
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    fn();
  };
  const timer = setTimeout(go, FIRST_PAGE_WAIT_MS);
  first.then(go, go);
}

/**
 * Show the saved catalog (genre chips, Most saved, the Shuffle pool) once the first
 * screen has painted: a file read, no request. Its network refresh waits for Home's
 * first page (`firstPage`, see afterFirstPage), then follows the app back to the
 * foreground or back online. The store's own rules decide whether that means a request
 * (at most hourly) or nothing.
 */
function startCatalog(firstPage: Promise<unknown>): void {
  whenIdle(() => void catalog.restoreSaved(), 1500, 300);
  afterFirstPage(firstPage, () => {
    const kick = () => void catalog.refresh();
    whenIdle(kick, 1500, 300);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') kick();
    });
    onReconnect(kick);
  });
}

async function boot(): Promise<void> {
  mark('boot');
  // e2e: the boot-failure screen.
  if (TEST_HOOKS && localStorage.getItem('__cyberjukeFailBoot')) throw new Error('Simulated boot failure');
  installPress();
  installRenderCounter({ App, Overlays, Home, Library, Screen, TrackRow, MiniPlayer, NowPlaying, ArtistGrid, ArtistTiles, ArtistTile, ArtistPage, GenreGrid, GenreTiles, GenreTile, GenreDetail });
  // Read before the first render: the settings and favourites (small keys) and a saved
  // Cyberspace login. Liked and history, files that can be large, are read alongside
  // and may arrive just after it.
  const settingsRead = loadSettings().catch((e) => logError('loadSettings', e));
  const listsRead = loadLists().catch((e) => logError('loadLibrary', e));
  const stored = Promise.all([settingsRead, listsRead]).then(() => undefined);
  await auth.restore();
  // The listening cache hears Liked and its size once they're read (not an empty list or the
  // default size first), and before startAccount acts on them: starting signed out drops
  // members-only audio too.
  void stored.then(startListeningCache);
  setOpenLiked(openLiked);
  // Sign-ins and sign-outs are followed from here on (restore() may already be refreshing the login).
  startAccount(stored, openSettings);
  // Home's first page is asked for now, not after the first render: the login decides
  // the query, and Home's list gets this same request when it mounts (the source shares
  // a load in progress). Always from the network: nothing of Latest is kept on disk.
  const firstPage = source.latest(null);
  firstPage.catch(() => {
    /* Home's list shows the failure */
  });
  await settingsRead;
  mark('storage');
  startQueuePurge();
  startPlayerPrefs();
  applyTheme();
  watchNetwork();
  // Back online (or told again that we are), and back in the foreground: lists on screen
  // that failed to load try again, and so does art that failed.
  onReconnect(() => {
    retryWatchedFeeds();
    artGen.value++;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    retryWatchedFeeds();
    // Still offline, the art would only fail again.
    if (online.peek()) artGen.value++;
  });
  wireBack();
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
  mark('render');
  firstScreenShown();
  startCatalog(firstPage);
  afterFirstPage(firstPage, () => void startUpdates(native ? () => JukePlayer.getAppInfo() : undefined));
  startFreshness();
  maybeAutoplay().catch((e) => logError('autoplay', e));
}

catchStrays();
boot().catch((e) => {
  logError('boot', e);
  const root = document.getElementById('app');
  if (root) render(<BootError detail={describeError(e)} onRetry={() => location.reload()} />, root);
  firstScreenShown();
});
