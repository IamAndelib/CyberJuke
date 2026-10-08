import { computed, signal } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Track } from '../../data/model';
import { buildIndex, searchGenres, searchTitles, searchTracks } from '../../data/search';
import { musicTracks, type MusicFilter, type MusicItem } from '../../data/ytmusic';
import { catalog } from '../../store/catalog';
import { genres } from '../../store/genres';
import { Icon } from '../icons';
import { openGenrePage, read, searchContext, searchOpen, searchMode, searchOverAlbum, type SearchContext, type SearchMode } from '../nav';
import { Rail, RailRow, RailSep, type RailItem } from '../components/Rail';
import { ChunkedTracks, EmptyState, ErrorState, Tracks } from '../components/TrackList';
import { SkeletonRows } from '../components/TrackRow';
import { Screen } from '../components/Screen';
import { CoverRow, GlobalError, LoadMore, MUSIC_ITEM_OPTS, MusicRow, searchLoader } from '../components/Music';
import { useFeed } from '../usePaged';

export const DEBOUNCE_MS = 120;
export const GLOBAL_DEBOUNCE_MS = 400;
/** Fewer Jukebox results than this shows the "Search globally" line. */
export const BRIDGE_BELOW = 5;

export { searchMode, type SearchMode };

/** Last query; kept so reopening search shows where you left off. */
const query = signal('');
const globalFilter = signal<MusicFilter>('songs');
/** Rebuilt only when the catalog (or the NSFW filter) changes. */
const index = computed(() => buildIndex(catalog.tracks.value));

const FILTERS: RailItem<MusicFilter>[] = (['songs', 'albums', 'artists', 'playlists'] as const).map((id) => ({
  id,
  label: id,
  testid: `filter-${id}`,
}));

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
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
function HereLoading() {
  return (
    <p class="section-note dim here-loading" role="status" data-testid="here-loading">
      <span class="spinner" aria-hidden="true" />
      Searching all songs…
    </p>
  );
}

/**
 * Here: the tracks of the place Search was opened from, filtered like Jukebox. The
 * list may still be growing (`ctx.loading`); matching releases (`ctx.albums`) show
 * as a cover row above the tracks.
 */
function HereResults({ q, ctx }: { q: string; ctx: SearchContext }) {
  const tracks = read(ctx.tracks);
  const loading = ctx.loading ? read(ctx.loading) : false;
  const albums = ctx.albums ? read(ctx.albums) : [];
  const idx = useMemo(() => buildIndex(tracks), [tracks]);
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
        <ChunkedTracks tracks={tracks} chunkKey={`search:here:${ctx.label}:`} testid="here-list" />
      </>
    );
  }
  const hits: Track[] = searchTracks(idx, q);
  const releases = searchTitles(albums, (a) => a.title, q);
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
          <Tracks tracks={hits} />
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
  if (!tracks.length) {
    if (status === 'error') {
      const err = catalog.error.value ?? { message: "Couldn't load the Jukebox.", offline: false };
      return <ErrorState {...err} onRetry={() => void catalog.refresh()} />;
    }
    return (
      <div class="state" data-testid="search-indexing" role="status">
        <span class="spinner big" aria-hidden="true" />
        <div class="state-title">Indexing the Jukebox…</div>
      </div>
    );
  }
  // Empty query: the whole Jukebox, newest first.
  if (!q.trim()) return <ChunkedTracks tracks={tracks} chunkKey="search:jukebox:" testid="search-latest" />;

  const hits = searchTracks(index.value, q);
  const gHits = searchGenres(genres.value, q);
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
          <Tracks tracks={hits} />
        </>
      )}
      {hits.length < BRIDGE_BELOW && <Bridge q={q} />}
    </div>
  );
}

function GlobalList({ q, filter }: { q: string; filter: MusicFilter }) {
  const norm = q.trim().toLowerCase();
  const { feed, snap } = useFeed<MusicItem, string>(`global:${filter}:${norm}`, searchLoader(q, filter), MUSIC_ITEM_OPTS);
  if (snap.status === 'loading') return <SkeletonRows n={6} />;
  if (snap.status === 'error' && snap.error) return <GlobalError error={snap.error} onRetry={() => feed.retry()} />;
  const items = snap.items;
  const songs = filter === 'songs' ? musicTracks(items) : [];
  const rows = filter === 'songs' ? [] : items.filter((i) => i.kind !== 'song');
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
        <Tracks tracks={songs} />
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

export function Search() {
  const input = useRef<HTMLInputElement>(null);
  const q = query.value;
  const ctx = searchContext.value;
  // Here only exists with a context.
  const mode: SearchMode = searchMode.value === 'here' && !ctx ? 'jukebox' : searchMode.value;
  const debounced = useDebounced(q, mode === 'global' ? GLOBAL_DEBOUNCE_MS : DEBOUNCE_MS);
  const label = mode === 'global' ? 'Search globally' : placeholder(mode, ctx);

  useEffect(() => {
    input.current?.focus();
    // Make sure the index is (being) built even if startup loading failed.
    void catalog.refresh();
  }, []);

  const modes: RailItem<SearchMode>[] = [
    ...(ctx ? [{ id: 'here' as const, label: 'Here', testid: 'mode-here' }] : []),
    { id: 'jukebox', label: 'Jukebox', testid: 'mode-jukebox' },
    { id: 'global', label: 'Global', testid: 'mode-global' },
  ];

  const close = () => {
    searchOpen.value = false;
    searchOverAlbum.value = false;
  };

  const bar = (
    <header class="topbar search-bar">
      <div class="search-row">
        <div class="topbar-left">
          <button class="icon-btn" aria-label="Close search" onClick={close} data-testid="search-close">
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
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
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
      {mode === 'global' ? (
        <GlobalResults q={debounced} />
      ) : mode === 'here' && ctx ? (
        <HereResults q={debounced} ctx={ctx} />
      ) : (
        <JukeboxResults q={debounced} />
      )}
    </Screen>
  );
}
