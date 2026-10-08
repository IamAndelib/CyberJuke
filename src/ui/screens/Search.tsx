import { computed, signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { buildIndex, searchGenres, searchTracks } from '../../data/search';
import { musicTracks, type MusicFilter, type MusicItem } from '../../data/ytmusic';
import { catalog } from '../../store/catalog';
import { genres } from '../../store/genres';
import { Icon } from '../icons';
import { openGenrePage, searchOpen } from '../nav';
import { ChunkedTracks, EmptyState, ErrorState, Tracks } from '../components/TrackList';
import { SkeletonRows } from '../components/TrackRow';
import { Screen } from '../components/Screen';
import { GlobalError, LoadMore, MUSIC_ITEM_OPTS, MusicRow, searchLoader } from '../components/Music';
import { useFeed } from '../usePaged';

export const DEBOUNCE_MS = 120;
export const GLOBAL_DEBOUNCE_MS = 400;
export const GLOBAL_MIN_CHARS = 2;
/** Fewer Jukebox results than this shows the "Search globally" line. */
export const BRIDGE_BELOW = 5;

export type SearchMode = 'jukebox' | 'global';

/** Last query; kept so reopening search shows where you left off. */
const query = signal('');
/** Search always opens on Jukebox (reset on every open). */
export const searchMode = signal<SearchMode>('jukebox');
const globalFilter = signal<MusicFilter>('songs');
/** Rebuilt only when the catalog (or the NSFW filter) changes. */
const index = computed(() => buildIndex(catalog.tracks.value));

const FILTERS: { id: MusicFilter; label: string }[] = [
  { id: 'songs', label: 'Songs' },
  { id: 'albums', label: 'Albums' },
  { id: 'artists', label: 'Artists' },
  { id: 'playlists', label: 'Playlists' },
];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** The one place Global is suggested: under few or no Jukebox results. */
function Bridge({ q }: { q: string }) {
  return (
    <div class="bridge">
      <button class="link-btn bridge-btn" onClick={() => (searchMode.value = 'global')} data-testid="search-bridge">
        Search globally for “{q.trim()}” →
      </button>
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

function FilterChips() {
  const cur = globalFilter.value;
  return (
    <div class="chips" role="radiogroup" aria-label="Global search filter" data-testid="global-filters">
      {FILTERS.map((f) => (
        <button
          key={f.id}
          role="radio"
          aria-checked={cur === f.id}
          class={'chip' + (cur === f.id ? ' on' : '')}
          onClick={() => (globalFilter.value = f.id)}
          data-testid={`filter-${f.id}`}
        >
          {f.label}
        </button>
      ))}
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
  const filter = globalFilter.value;
  const ready = q.trim().length >= GLOBAL_MIN_CHARS;
  return (
    <>
      <FilterChips />
      {ready ? (
        <GlobalList q={q} filter={filter} />
      ) : (
        <div class="state" data-testid="global-idle">
          <div class="state-glyph" aria-hidden="true">
            [ GLOBAL ]
          </div>
          <div class="state-title">Search beyond the Jukebox</div>
          <div class="state-body">Any song, album, artist or playlist. Type at least {GLOBAL_MIN_CHARS} letters.</div>
        </div>
      )}
    </>
  );
}

function ModeTabs() {
  const cur = searchMode.value;
  const modes = [
    { id: 'jukebox', label: 'Jukebox' },
    { id: 'global', label: 'Global' },
  ] as const;
  return (
    <div class="sort-tabs search-modes" role="tablist" aria-label="Search in" data-testid="search-modes">
      {modes.map((m) => (
        <button
          key={m.id}
          role="tab"
          class={'sort-tab' + (cur === m.id ? ' on' : '')}
          aria-selected={cur === m.id}
          onClick={() => (searchMode.value = m.id)}
          data-testid={`mode-${m.id}`}
        >
          [{m.label}]
        </button>
      ))}
    </div>
  );
}

export function Search() {
  const input = useRef<HTMLInputElement>(null);
  const q = query.value;
  const mode = searchMode.value;
  const debounced = useDebounced(q, mode === 'global' ? GLOBAL_DEBOUNCE_MS : DEBOUNCE_MS);
  const label = mode === 'global' ? 'Search globally' : 'Search the Jukebox';

  useEffect(() => {
    searchMode.value = 'jukebox';
    input.current?.focus();
    // Make sure the index is (being) built even if startup loading failed.
    void catalog.refresh();
  }, []);

  const bar = (
    <header class="topbar search-bar">
      <div class="search-row">
        <div class="topbar-left">
          <button class="icon-btn" aria-label="Close search" onClick={() => (searchOpen.value = false)} data-testid="search-close">
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
            placeholder={mode === 'global' ? 'Songs, albums, artists…' : 'Search the Jukebox'}
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
      <ModeTabs />
    </header>
  );

  const key = mode === 'global' ? `search:global:${globalFilter.value}:${debounced.trim().toLowerCase()}` : `search:jukebox:${debounced.trim()}`;
  return (
    <Screen class="search" role="dialog" label="Search" testid="search" bar={bar} scrollKey={key}>
      {mode === 'global' ? <GlobalResults q={debounced} /> : <JukeboxResults q={debounced} />}
    </Screen>
  );
}
