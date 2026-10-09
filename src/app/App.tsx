import { effect, useComputed } from '@preact/signals';
import { memo } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { hasCurrent } from '../player';
import { online } from '../core/network';
import { BlockBanner } from '../ui/components/BlockBanner';
import { Icon, type IconName } from '../ui/icons';
import {
  PageKey,
  goBack,
  isOpeningDoubleTap,
  nowPlayingOpen,
  pageKey,
  popToRoot,
  selectTab,
  stacks,
  tab,
  topEntry,
  type Page,
  type StackEntry,
  type Tab,
} from '../ui/nav';
import { ArtistChooser, MiniPlayer, NowPlaying, TrackMenu } from '../features/now-playing/PlayerUI';
import { Toasts } from '../ui/components/Toasts';
import { ConfirmSheet } from '../ui/components/ConfirmSheet';
import { screenToTop } from '../ui/components/Screen';
import { SearchFab } from '../features/search/SearchFab';
import { scrollToTop } from '../ui/scrollToTop';
import { reducedMotion } from '../core/motion';
import { AlbumPage } from '../features/artists/Album';
import { ArtistPage } from '../features/artists/Artist';
import { ArtistGrid } from '../features/artists/Artists';
import { GenreDetail, GenreGrid } from '../features/genres/Genres';
import { Home } from '../features/home/Home';
import { Library } from '../features/library/Library';
import { ReleasesPage } from '../features/artists/Releases';
import { Search } from '../features/search/Search';
import { Settings } from '../features/settings/Settings';
import { updateAvailable } from '../stores/updates';

const TAB_ITEMS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'genres', label: 'Genres', icon: 'genres' },
  { id: 'artists', label: 'Artists', icon: 'artists' },
  { id: 'library', label: 'Library', icon: 'library' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

/** SM7: a pushed page slides in over this long; the page under it hides once it has. */
const PAGE_ENTER_MS = 180;
/** P5: a second tap on the active tab within this long pops to its root. */
const RETAP_MS = 700;

/** The scroller of the page showing on a tab. */
function topScroller(t: Tab): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-pane="${t}"] > .page.top .screen`);
}

let lastRetap = 0;

/**
 * P5: tapping the tab you're on scrolls its page to the top; a second tap (or a tap
 * when it's at the top already) goes back to the tab's root.
 */
function retapTab(t: Tab): void {
  const now = performance.now();
  const quick = now - lastRetap < RETAP_MS;
  lastRetap = now;
  const el = topScroller(t);
  if (el && el.scrollTop > 2 && !quick) {
    toTopOf(el);
    return;
  }
  if (stacks.value[t].length) popToRoot(t);
  else if (el && el.scrollTop > 2) toTopOf(el);
}

/** The screen's own back-to-top: the click guard knows it runs (M6), and a touch stops it. */
function toTopOf(el: HTMLElement): void {
  if (!screenToTop(el)) scrollToTop(el, { reduced: reducedMotion() });
}

function TabBar() {
  const cur = tab.value;
  return (
    <nav class="tabbar" aria-label="Main">
      {TAB_ITEMS.map((t) => (
        <button
          key={t.id}
          class={'tab' + (cur === t.id ? ' on' : '')}
          aria-current={cur === t.id ? 'page' : undefined}
          onClick={() => (cur === t.id ? retapTab(t.id) : selectTab(t.id))}
          data-testid={`tab-${t.id}`}
          aria-label={t.id === 'settings' && updateAvailable.value ? 'Settings (update available)' : undefined}
        >
          <Icon name={t.icon} size={24} />
          <span class="tab-label">{t.label}</span>
          {t.id === 'settings' && updateAvailable.value && <span class="tab-dot" aria-hidden="true" data-testid="settings-update-dot" />}
        </button>
      ))}
    </nav>
  );
}

function TabRoot({ t }: { t: Tab }) {
  switch (t) {
    case 'home':
      return <Home />;
    case 'genres':
      return <GenreGrid />;
    case 'artists':
      return <ArtistGrid />;
    case 'library':
      return <Library />;
    case 'settings':
      return <Settings />;
  }
}

function PageView({ page }: { page: Page }) {
  switch (page.kind) {
    case 'genre':
      return <GenreDetail genre={page.name} />;
    case 'artist':
      return <ArtistPage name={page.name} />;
    case 'album':
      return <AlbumPage album={page.album} />;
    case 'releases':
      return <ReleasesPage key={page.release.token + '|' + page.release.kind} release={page.release} />;
    case 'search':
      return <Search />;
  }
}

/** A page's content; never re-rendered by its frame (only by its own signals and state). */
const PageContent = memo(function PageContent({ t, entry }: { t: Tab; entry: StackEntry | null }) {
  return entry ? <PageView page={entry.page} /> : <TabRoot t={t} />;
});

/**
 * One page of a tab: the root or a pushed page. Only the top page shows; a page that
 * gets covered stays mounted (scroll, artwork, loaded lists) and, once the page over
 * it has slid in, is hidden with content-visibility and made inert. Uncovered again,
 * it shows at once, before the page over it goes.
 */
const PageFrame = memo(function PageFrame({ t, entry, top }: { t: Tab; entry: StackEntry | null; top: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const k = pageKey(t, entry);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cover = (on: boolean) => {
      el.classList.toggle('covered', on);
      el.inert = on;
      if (on) el.setAttribute('aria-hidden', 'true');
      else el.removeAttribute('aria-hidden');
    };
    if (top) return cover(false);
    if (reducedMotion()) return cover(true);
    const id = setTimeout(() => cover(true), PAGE_ENTER_MS);
    return () => clearTimeout(id);
  }, [top]);
  return (
    <div
      ref={ref}
      class={'page' + (top ? ' top' : '') + (entry ? ' pushed' : '')}
      data-page={k}
      data-kind={entry ? entry.page.kind : 'root'}
      onClickCapture={(e) => {
        // M9: the second tap of a double tap on a tile doesn't land on the new page.
        if (entry && isOpeningDoubleTap(entry, e)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      <PageKey.Provider value={k}>
        <PageContent t={t} entry={entry} />
      </PageKey.Provider>
    </div>
  );
});

/** One tab: its root and its pages. Kept mounted once visited (SM7), hidden when not showing. */
const TabPane = memo(function TabPane({ t, active }: { t: Tab; active: boolean }) {
  // Only this tab's stack: a push on another tab doesn't re-render this one.
  const entries = useComputed(() => stacks.value[t]).value;
  return (
    <div class={'tab-pane' + (active ? ' on' : '')} data-pane={t} inert={active ? undefined : true} aria-hidden={active ? undefined : true}>
      <PageFrame key="root" t={t} entry={null} top={!entries.length} />
      {entries.map((e, i) => (
        <PageFrame key={e.id} t={t} entry={e} top={i === entries.length - 1} />
      ))}
    </div>
  );
});

/**
 * SM5: the app behind Now Playing becomes inert once the sheet has finished opening, and
 * stops being inert once it has finished closing: either change is a style pass over the
 * whole app, which would cost the sheet's first frame (a visible hitch as it starts to move).
 * The sheet covers the app until then anyway.
 */
function useInertUnderNowPlaying(app: { current: HTMLElement | null }): void {
  useEffect(() => {
    let cancel: (() => void) | null = null;
    const dispose = effect(() => {
      const open = nowPlayingOpen.value;
      cancel?.();
      cancel = null;
      const el = app.current;
      if (!el || el.inert === open) return;
      const np = document.querySelector<HTMLElement>('[data-testid="now-playing"]');
      let timer = 0;
      let frame = 0;
      const settle = () => {
        cancel?.();
        cancel = null;
        if (nowPlayingOpen.peek() === open) el.inert = open;
      };
      const onEnd = (e: TransitionEvent) => {
        if (e.target === np) settle();
      };
      np?.addEventListener('transitionend', onEnd);
      if (reducedMotion()) frame = requestAnimationFrame(settle);
      else timer = window.setTimeout(settle, open ? 450 : 300);
      cancel = () => {
        np?.removeEventListener('transitionend', onEnd);
        clearTimeout(timer);
        cancelAnimationFrame(frame);
      };
    });
    return () => {
      cancel?.();
      dispose();
    };
    // `app` is a stable ref object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function App() {
  const cur = tab.value;
  // Only whether something is loaded: playback itself never re-renders the app.
  const hasPlayer = hasCurrent.value;
  const topKind = useComputed(() => topEntry.value?.page.kind ?? null).value;
  // The search button shows over every page but Search itself and the Settings root.
  const showFab = topKind !== 'search' && (topKind != null || cur !== 'settings');
  const visited = useRef(new Set<Tab>());
  visited.current.add(cur);
  const app = useRef<HTMLDivElement>(null);
  useInertUnderNowPlaying(app);

  // Escape closes overlays on the web (Android back is wired in main.tsx).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') goBack(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div ref={app} class={'app' + (hasPlayer ? ' has-player' : '') + (showFab ? ' has-fab' : '')}>
      {!online.value && (
        <div class="offline-banner" role="status" data-testid="offline-banner">
          [ offline ] showing what's already loaded
        </div>
      )}
      <main class="main">
        {TAB_ITEMS.filter((t) => visited.current.has(t.id)).map((t) => (
          <TabPane key={t.id} t={t.id} active={t.id === cur} />
        ))}
        {showFab && <SearchFab />}
      </main>
      <BlockBanner />
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
      <ConfirmSheet />
      <Toasts />
    </>
  );
}
