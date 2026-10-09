import { computed, signal } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Track } from '../../data/model';
import { buildIndex, searchGenres, searchTitles, searchTracks } from '../../data/search';
import { musicTracks, type MusicFilter, type MusicItem } from '../../data/ytmusic';
import { catalog } from '../../stores/catalog';
import { genres } from '../../stores/genres';
import { addRecentSearch, clearRecentSearches, loadRecentSearches, recentSearches, removeRecentSearch, restoreRecentSearches } from '../../stores/searches';
import { toast } from '../../stores/toast';
import { isFavoriteArtist, isFavoriteGenre } from '../../stores/library';
import { useChunks } from '../../ui/useChunks';
import { Icon } from '../../ui/icons';
import {
  openArtistPage,
  openGenrePage,
  popPage,
  read,
  searchContext,
  searchMode,
  searchQuery as query,
  type AlbumRef,
  type Place,
  type SearchContext,
  type SearchMode,
} from '../../ui/nav';
import { Rail, RailRow, RailSep, type RailItem } from '../../ui/components/Rail';
import { CatalogError, ChunkedTracks, EmptyState, Tracks } from '../../ui/components/TrackList';
import { SkeletonRows } from '../../ui/components/TrackRow';
import { Screen } from '../../ui/components/Screen';
import { CoverRow, GlobalError, LoadMore, MUSIC_ITEM_OPTS, MusicRow, searchLoader } from '../../ui/components/Music';
import { useFeed } from '../../ui/usePaged';
import { globalFeeds } from '../../stores/feed';
import { list, radio } from '../../ui/playAll';

const DEBOUNCE_MS = 120;
const GLOBAL_DEBOUNCE_MS = 400;
/** Fewer Jukebox results than this shows the "Search globally" line. */
const BRIDGE_BELOW = 5;

export { searchMode, type SearchMode };

/** Results start a radio from the tapped track (C2). */
const SEARCH_CTX = radio('Search');
const GLOBAL_CTX = radio('Global');
const globalFilter = signal<MusicFilter>('songs');
/** Rebuilt only when the catalog (or the NSFW filter) changes. */
const index = computed(() => buildIndex(catalog.tracks.value));

const FILTERS: RailItem<MusicFilter>[] = (['songs', 'albums', 'artists', 'playlists'] as const).map((id) => ({
  id,
  label: id,
  testid: `filter-${id}`,
}));

/** The query after a pause in typing; clearing the field takes effect at once. */
function useDebounced(value: string, ms: number): string {
  const [v, setV] = useState(value);
  const cleared = !value.trim();
  useEffect(() => {
    if (cleared) return setV(value);
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms, cleared]);
  return cleared ? value : v;
}

/** The one place a wider scope is suggested: under few or no results. */
function Bridge({ q, to = 'global' }: { q: string; to?: 'jukebox' | 'global' }) {
  return (
    <div class="bridge">
      <button class="link-btn bridge-btn" onClick={() => (searchMode.value = to)} data-testid={to === 'global' ? 'search-bridge' : 'here-bridge'}>
        {to === 'global' ? 'Search globally' : 'Search the whole Jukebox'} for “{q.trim()}” →
      </button>
    </div>
  );
}

/** Shown while a Here list is still growing (an artist's full song list). */
function HereLoading({ text = 'Searching all songs…' }: { text?: string }) {
  return (
    <p class="section-note dim here-loading" role="status" data-testid="here-loading">
      <span class="spinner" aria-hidden="true" />
      {text}
    </p>
  );
}

/**
 * Here: the tracks of the place Search was opened from, filtered like Jukebox. The
 * list may still be growing (`ctx.loading`); matching releases (`ctx.albums`) show
 * as a cover row above the tracks.
 */
const NO_ALBUMS: AlbumRef[] = [];

/** How many name matches Here shows at most. */
const MAX_PLACES = 100;

/** One genre or artist found by name; a tap opens its page. */
function PlaceRow({ place }: { place: Place }) {
  const fav = place.kind === 'genre' ? isFavoriteGenre(place.name) : isFavoriteArtist(place.name);
  return (
    <li>
      <button
        type="button"
        class="place-row"
        onClick={() => (place.kind === 'genre' ? openGenrePage(place.name) : openArtistPage(place.name))}
        data-testid="here-place"
        data-place={place.name}
      >
        <span class="place-name">
          {fav && (
            <span class="place-fav" aria-label="favourite">
              ★{' '}
            </span>
          )}
          {place.name}
        </span>
        {place.count != null && (
          <span class="dim small">
            {place.count} track{place.count === 1 ? '' : 's'}
          </span>
        )}
        <span class="place-go" aria-hidden="true">
          &gt;
        </span>
      </button>
    </li>
  );
}

/**
 * Here on the Genres and Artists tabs: the genres or artists themselves, found by name
 * (typo-tolerant, like every search). An empty query lists them all, A to Z.
 */
function PlaceResults({ q, ctx, places }: { q: string; ctx: SearchContext; places: Place[] }) {
  const all = useMemo(() => [...places].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })), [places]);
  const hits = useMemo(() => (q.trim() ? searchTitles(places, (p) => p.name, q, MAX_PLACES) : all), [places, all, q]);
  const { shown, sentinel, more } = useChunks(hits.length, q.trim() ? null : `search:places:${ctx.label}`);
  const what = ctx.label.toLowerCase();
  if (!places.length) {
    // The genres and artists come from the Jukebox: if it couldn't load, say so (and retry).
    if (catalog.status.value === 'error') {
      return <CatalogError />;
    }
    return <HereLoading text={`Loading ${what}…`} />;
  }
  if (!hits.length) {
    return (
      <>
        <EmptyState title="No matches" testid="here-empty">
          No {what} match “{q.trim()}”.
        </EmptyState>
        <Bridge q={q} to="jukebox" />
      </>
    );
  }
  return (
    <div data-testid="here-places">
      <div class="section-head">
        <h2 class="section-title">{ctx.label}</h2>
        <span class="dim small" data-testid="search-count">
          {q.trim() ? `${hits.length} match${hits.length === 1 ? '' : 'es'}` : `${hits.length} ${what}`}
        </span>
      </div>
      <ul class="place-list">
        {hits.slice(0, shown).map((p) => (
          <PlaceRow key={p.kind + ':' + p.name} place={p} />
        ))}
      </ul>
      {more && <div ref={sentinel} class="list-foot" aria-hidden="true" />}
      {q.trim() && hits.length < BRIDGE_BELOW && <Bridge q={q} to="jukebox" />}
    </div>
  );
}

function HereResults({ q, ctx }: { q: string; ctx: SearchContext }) {
  if (ctx.places) return <PlaceResults q={q} ctx={ctx} places={read(ctx.places)} />;
  return <TrackHereResults q={q} ctx={ctx} />;
}

function TrackHereResults({ q, ctx }: { q: string; ctx: SearchContext }) {
  const tracks = read(ctx.tracks);
  const loading = ctx.loading ? read(ctx.loading) : false;
  const albums = ctx.albums ? read(ctx.albums) : NO_ALBUMS;
  const idx = useMemo(() => buildIndex(tracks), [tracks]);
  const hits: Track[] = useMemo(() => (q.trim() ? searchTracks(idx, q) : []), [idx, q]);
  const releases = useMemo(() => (q.trim() ? searchTitles(albums, (a) => a.title, q) : []), [albums, q]);
  useEffect(() => {
    ctx.load?.();
  }, [ctx]);
  if (!q.trim()) {
    if (!tracks.length) {
      if (loading) return <HereLoading />;
      return (
        <EmptyState title="Nothing here yet" testid="here-empty">
          No tracks in {ctx.label} to search.
        </EmptyState>
      );
    }
    return (
      <>
        {loading && <HereLoading />}
        <ChunkedTracks tracks={tracks} ctx={list(ctx.label)} chunkKey={`search:here:${ctx.label}:`} testid="here-list" />
      </>
    );
  }
  if (!hits.length && !releases.length) {
    if (loading) return <HereLoading />;
    return (
      <>
        <EmptyState title="No matches" testid="here-empty">
          Nothing in {ctx.label} matches “{q.trim()}”.
        </EmptyState>
        <Bridge q={q} to="jukebox" />
      </>
    );
  }
  return (
    <div data-testid="here-results">
      {releases.length > 0 && (
        <>
          <div class="section-head">
            <h2 class="section-title">Releases</h2>
          </div>
          <CoverRow items={releases} />
        </>
      )}
      {hits.length > 0 && (
        <>
          <div class="section-head">
            <h2 class="section-title">In {ctx.label}</h2>
            <span class="dim small" data-testid="search-count">
              {hits.length === 100 ? 'top 100' : `${hits.length} match${hits.length === 1 ? '' : 'es'}`}
            </span>
          </div>
          {loading && <HereLoading />}
          <Tracks tracks={hits} ctx={SEARCH_CTX} />
        </>
      )}
      {!hits.length && loading && <HereLoading />}
      {!loading && hits.length < BRIDGE_BELOW && <Bridge q={q} to="jukebox" />}
    </div>
  );
}

function JukeboxResults({ q }: { q: string }) {
  const tracks = catalog.tracks.value;
  const status = catalog.status.value;
  const idx = index.value;
  const genreList = genres.value;
  // Recomputed only when the query or the catalog changes (not on every render).
  const hits = useMemo(() => (q.trim() ? searchTracks(idx, q) : []), [idx, q]);
  const gHits = useMemo(() => (q.trim() ? searchGenres(genreList, q) : []), [genreList, q]);
  if (!tracks.length) {
    if (status === 'error') {
      return <CatalogError />;
    }
    return (
      <div class="state" data-testid="search-indexing" role="status">
        <span class="spinner big" aria-hidden="true" />
        <div class="state-title">Indexing the Jukebox…</div>
      </div>
    );
  }
  // Empty query: the whole Jukebox, newest first.
  if (!q.trim()) return <ChunkedTracks tracks={tracks} ctx={SEARCH_CTX} chunkKey="search:jukebox:" testid="search-latest" />;

  if (!hits.length && !gHits.length) {
    return (
      <>
        <EmptyState title="No matches" testid="search-empty">
          Nothing on the Jukebox matches “{q.trim()}”.
        </EmptyState>
        <Bridge q={q} />
      </>
    );
  }
  return (
    <div data-testid="search-results">
      {gHits.length > 0 && (
        <>
          <div class="section-head">
            <h2 class="section-title">Genres</h2>
          </div>
          <div class="chips wrap" data-testid="search-genres">
            {gHits.map((name) => (
              <button key={name} class="chip" onClick={() => openGenrePage(name)} data-testid="search-genre" data-genre={name}>
                {name}
              </button>
            ))}
          </div>
        </>
      )}
      {hits.length > 0 && (
        <>
          <div class="section-head">
            <h2 class="section-title">Tracks</h2>
            <span class="dim small" data-testid="search-count">
              {hits.length === 100 ? 'top 100' : `${hits.length} match${hits.length === 1 ? '' : 'es'}`}
            </span>
          </div>
          <Tracks tracks={hits} ctx={SEARCH_CTX} />
        </>
      )}
      {hits.length < BRIDGE_BELOW && <Bridge q={q} />}
    </div>
  );
}

/** Global result rows (songs as tracks, the rest as album/artist/playlist rows). */
function GlobalItems({ items, filter }: { items: MusicItem[]; filter: MusicFilter }) {
  return filter === 'songs' ? (
    <Tracks tracks={musicTracks(items)} ctx={GLOBAL_CTX} />
  ) : (
    <ul class="list" data-testid="music-list">
      {items
        .filter((i) => i.kind !== 'song')
        .map((it) => (
          <MusicRow key={it.kind + it.url} item={it} />
        ))}
    </ul>
  );
}

function GlobalList({ q, filter }: { q: string; filter: MusicFilter }) {
  const norm = q.trim().toLowerCase();
  const { feed, snap } = useFeed<MusicItem, string>(`global:${filter}:${norm}`, searchLoader(q, filter), MUSIC_ITEM_OPTS, globalFeeds);
  /** The last results shown, for the same filter: kept on screen while the next query loads (P7). */
  const shown = useRef<{ filter: MusicFilter; items: MusicItem[] } | null>(null);
  if (snap.status === 'loading') {
    const prev = shown.current;
    if (prev && prev.filter === filter && prev.items.length) {
      return (
        <div class="global-stale" aria-busy="true" data-testid="global-stale">
          <div class="progress-line" role="progressbar" aria-label="Searching" data-testid="global-loading" />
          <GlobalItems items={prev.items} filter={filter} />
        </div>
      );
    }
    return <SkeletonRows n={6} />;
  }
  if (snap.status === 'error' && snap.error) return <GlobalError error={snap.error} onRetry={() => feed.retry()} />;
  const items = snap.items;
  const songs = filter === 'songs' ? musicTracks(items) : [];
  const rows = filter === 'songs' ? [] : items.filter((i) => i.kind !== 'song');
  shown.current = songs.length || rows.length ? { filter, items } : null;
  if (!songs.length && !rows.length) {
    return (
      <EmptyState title="No matches" testid="global-empty">
        Nothing found for “{q.trim()}”.
      </EmptyState>
    );
  }
  return (
    <div data-testid="global-results" data-filter={filter}>
      {filter === 'songs' ? (
        <Tracks tracks={songs} ctx={GLOBAL_CTX} />
      ) : (
        <ul class="list" data-testid="music-list">
          {rows.map((it) => (
            <MusicRow key={it.kind + it.url} item={it} />
          ))}
        </ul>
      )}
      {snap.hasMore ? (
        <LoadMore busy={snap.loadingMore} error={!!snap.error} onClick={() => feed.loadMore()} />
      ) : (
        <div class="list-foot end">— end of tape —</div>
      )}
    </div>
  );
}

function GlobalResults({ q }: { q: string }) {
  // From the first letter: the debounce already waits for a pause in typing, each query
  // has its own feed (so a late answer to an older query never shows), and results are
  // cached for 10 minutes.
  if (q.trim()) return <GlobalList q={q} filter={globalFilter.value} />;
  return (
    <div class="state" data-testid="global-idle">
      <div class="state-glyph" aria-hidden="true">
        [ GLOBAL ]
      </div>
      <div class="state-title">Search beyond the Jukebox</div>
      <div class="state-body">Any song, album, artist or playlist.</div>
    </div>
  );
}

function placeholder(mode: SearchMode, ctx: SearchContext | null): string {
  if (mode === 'here' && ctx) return `Search in ${ctx.label}`;
  return mode === 'global' ? 'Songs, albums, artists…' : 'Search the Jukebox';
}

/** P9: the last few searches, while the field is empty; each with its own clear button. */
function RecentSearches({ onPick }: { onPick: (q: string) => void }) {
  const items = recentSearches.value;
  if (!items.length) return null;
  return (
    <section class="recent-searches" data-testid="recent-searches">
      <div class="section-head">
        <h2 class="section-title">Recent searches</h2>
        <button
          type="button"
          class="link-btn recent-clear"
          onClick={() => {
            const old = clearRecentSearches();
            toast('Recent searches cleared', 4000, { label: 'Undo', run: () => restoreRecentSearches(old) });
          }}
          data-testid="recent-clear"
        >
          [Clear all]
        </button>
      </div>
      <ul class="recent-list">
        {items.map((q) => (
          <li key={q} class="recent-item">
            <button type="button" class="recent-q" onClick={() => onPick(q)} data-testid="recent-search">
              <span class="search-prompt" aria-hidden="true">
                &gt;
              </span>
              <span class="recent-text">{q}</span>
            </button>
            <button
              type="button"
              class="icon-btn recent-x"
              aria-label={`Remove “${q}” from recent searches`}
              onClick={() => removeRecentSearch(q)}
              data-testid="recent-search-remove"
            >
              <Icon name="close" size={18} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Search() {
  const input = useRef<HTMLInputElement>(null);
  const q = query.value;
  const ctx = searchContext.value;
  // Here only exists with a context.
  const mode: SearchMode = searchMode.value === 'here' && !ctx ? 'jukebox' : searchMode.value;
  const debounced = useDebounced(q, mode === 'global' ? GLOBAL_DEBOUNCE_MS : DEBOUNCE_MS);
  const label = mode === 'global' ? 'Search globally' : placeholder(mode, ctx);

  useEffect(() => {
    const el = input.current;
    el?.focus();
    // P9: the last query is selected, so typing replaces it.
    el?.select();
    void loadRecentSearches();
    // Make sure the index is (being) built even if startup loading failed.
    void catalog.refresh();
  }, []);

  const modes: RailItem<SearchMode>[] = [
    ...(ctx ? [{ id: 'here' as const, label: 'Here', testid: 'mode-here' }] : []),
    { id: 'jukebox', label: 'Jukebox', testid: 'mode-jukebox' },
    { id: 'global', label: 'Global', testid: 'mode-global' },
  ];

  const pick = (v: string) => {
    query.value = v;
    input.current?.focus();
  };

  const bar = (
    <header class="topbar search-bar">
      <div class="search-row">
        <div class="topbar-left">
          <button class="icon-btn" aria-label="Close search" onClick={popPage} data-testid="search-close">
            <Icon name="back" />
          </button>
        </div>
        <label class="search-field">
          <span class="search-prompt" aria-hidden="true">
            &gt;
          </span>
          <input
            ref={input}
            type="search"
            class="search-input"
            placeholder={placeholder(mode, ctx)}
            aria-label={label}
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            enterKeyHint="search"
            value={q}
            onInput={(e) => (query.value = (e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              addRecentSearch(query.value);
              (e.target as HTMLInputElement).blur();
            }}
            data-testid="search-input"
          />
          {q && (
            <button
              type="button"
              class="search-clear"
              aria-label="Clear search"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => {
                query.value = '';
                input.current?.focus();
              }}
              data-testid="search-clear"
            >
              <Icon name="close" size={20} />
            </button>
          )}
        </label>
      </div>
      <RailRow class="search-rail" testid="search-rail">
        <Rail
          items={modes}
          value={mode}
          onChange={(m) => (searchMode.value = m)}
          label="Search in"
          testid="search-modes"
          keepFocus
        />
        {mode === 'global' && (
          <>
            <RailSep />
            <Rail
              items={FILTERS}
              value={globalFilter.value}
              onChange={(f) => (globalFilter.value = f)}
              kind="radio"
              variant="filter"
              label="Global search filter"
              testid="global-filters"
              keepFocus
            />
          </>
        )}
      </RailRow>
    </header>
  );

  const key =
    mode === 'global'
      ? `search:global:${globalFilter.value}:${debounced.trim().toLowerCase()}`
      : mode === 'here'
        ? `search:here:${ctx?.label}:${debounced.trim()}`
        : `search:jukebox:${debounced.trim()}`;
  return (
    <Screen class="search" role="dialog" label="Search" testid="search" bar={bar} scrollKey={key}>
      {!q.trim() && <RecentSearches onPick={pick} />}
      <div
        // A tap on a result means the query found something: remember it (P9).
        onClickCapture={(e) => {
          if ((e.target as Element | null)?.closest?.('button') && query.value.trim()) addRecentSearch(query.value);
        }}
      >
        {mode === 'global' ? (
          <GlobalResults q={debounced} />
        ) : mode === 'here' && ctx ? (
          <HereResults q={debounced} ctx={ctx} />
        ) : (
          <JukeboxResults q={debounced} />
        )}
      </div>
    </Screen>
  );
}
