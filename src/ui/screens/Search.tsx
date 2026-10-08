import { computed, signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { buildIndex, searchGenres, searchTracks } from '../../data/search';
import { catalog } from '../../store/catalog';
import { genres } from '../../store/genres';
import { Icon } from '../icons';
import { openGenre, searchOpen, tab } from '../nav';
import { EmptyState, ErrorState, Tracks } from '../components/TrackList';

export const DEBOUNCE_MS = 120;

/** Last query; kept so reopening search shows where you left off. */
const query = signal('');
/** Rebuilt only when the catalog (or the NSFW filter) changes. */
const index = computed(() => buildIndex(catalog.tracks.value));

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

function openGenrePage(name: string) {
  searchOpen.value = false;
  tab.value = 'genres';
  openGenre.value = name;
}

function Results({ q }: { q: string }) {
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
  if (!q.trim()) {
    return (
      <div class="search-hint" data-testid="search-hint">
        <p>
          Search all <b>{tracks.length}</b> tracks by title, artist, genre or @poster.
        </p>
        <p class="dim small">Typos are fine: “uematsy” finds Nobuo Uematsu.</p>
      </div>
    );
  }
  const hits = searchTracks(index.value, q);
  const gHits = searchGenres(genres.value, q);
  if (!hits.length && !gHits.length) {
    return (
      <EmptyState title="No matches" testid="search-empty">
        Nothing on the Jukebox matches “{q.trim()}”.
      </EmptyState>
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
    </div>
  );
}

export function Search() {
  const input = useRef<HTMLInputElement>(null);
  const q = query.value;
  const debounced = useDebounced(q, DEBOUNCE_MS);

  useEffect(() => {
    input.current?.focus();
    // Make sure the index is (being) built even if startup loading failed.
    void catalog.refresh();
  }, []);

  return (
    <div class="search screen" role="dialog" aria-label="Search" data-testid="search">
      <header class="topbar search-bar">
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
            placeholder="Search the Jukebox"
            aria-label="Search the Jukebox"
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
      </header>
      <div class="screen-body">
        <Results q={debounced} />
      </div>
    </div>
  );
}
