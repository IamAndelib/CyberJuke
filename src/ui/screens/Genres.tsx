import { useEffect, useState } from 'preact/hooks';
import { source } from '../../data';
import type { Cursor } from '../../data/source';
import { player } from '../../player';
import { genres, recordTracks } from '../../store/genres';
import { settings } from '../../store/library';
import { Icon } from '../icons';
import { openGenre } from '../nav';
import { ErrorState, PagedTracks } from '../components/TrackList';
import { Screen } from '../components/Screen';
import { usePaged } from '../usePaged';

/** Latest pages used to seed the genre grid (cached by the source, so cheap). */
const SEED_PAGES = 3;

async function seedGenres(): Promise<void> {
  let cursor: Cursor | null = null;
  for (let i = 0; i < SEED_PAGES; i++) {
    const p = await source.latest(cursor);
    recordTracks(p.tracks);
    cursor = p.cursor;
    if (!cursor) break;
  }
}

export function Genres() {
  if (openGenre.value) return <GenreDetail genre={openGenre.value} />;
  return <GenreGrid />;
}

function GenreGrid() {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [offline, setOffline] = useState(false);
  const load = () => {
    setState('loading');
    seedGenres()
      .then(() => setState('ready'))
      .catch((e) => {
        setOffline(!!e?.offline);
        setState('error');
      });
  };
  useEffect(load, []);
  const list = genres.value;

  return (
    <Screen
      testid="screen-genres"
      title="Genres"
      subtitle={list.length ? `${list.length} seen in recent posts` : 'Browse by genre'}
      onRefresh={async () => {
        source.invalidate?.();
        await seedGenres().catch(() => {});
      }}
    >
      {state === 'error' && !list.length ? (
        <ErrorState offline={offline} message="Couldn't load genres." onRetry={load} />
      ) : state === 'loading' && !list.length ? (
        <div class="genre-grid" aria-hidden="true">
          {Array.from({ length: 10 }, (_, i) => (
            <div class="genre-tile skel-block" key={i} />
          ))}
        </div>
      ) : (
        <div class="genre-grid" data-testid="genre-grid">
          {list.map((g) => (
            <button
              key={g.name}
              class="genre-tile"
              onClick={() => (openGenre.value = g.name)}
              data-testid="genre-tile"
              data-genre={g.name}
            >
              <span class="genre-name">{g.name}</span>
              <span class="genre-count">
                {g.count} track{g.count === 1 ? '' : 's'}
              </span>
            </button>
          ))}
        </div>
      )}
      <p class="fineprint">Genres are free text chosen by each poster. The grid grows as you browse.</p>
    </Screen>
  );
}

function GenreDetail({ genre }: { genre: string }) {
  const nsfw = settings.value.showNsfw;
  const paged = usePaged(`genre:${genre}:${nsfw}`, (c) => source.byGenre(genre, c));
  const has = paged.tracks.length > 0;
  return (
    <Screen
      testid="screen-genre"
      title={genre}
      subtitle={has ? `${paged.tracks.length}${paged.hasMore ? '+' : ''} tracks` : 'Genre'}
      left={
        <button class="icon-btn" aria-label="Back to genres" onClick={() => (openGenre.value = null)} data-testid="genre-back">
          <Icon name="back" />
        </button>
      }
      onRefresh={paged.refresh}
    >
      <div class="actions">
        <button class="btn primary" disabled={!has} onClick={() => player.playList(paged.tracks, 0)} data-testid="genre-play-all">
          <Icon name="play" size={18} /> Play all
        </button>
        <button
          class="btn"
          disabled={!has}
          onClick={async () => {
            const n = paged.tracks.length;
            await player.playList(paged.tracks, Math.floor(Math.random() * n));
            await player.setShuffle(true);
          }}
          data-testid="genre-shuffle"
        >
          <Icon name="shuffle" size={18} /> Shuffle
        </button>
      </div>
      <PagedTracks paged={paged} hideGenre />
    </Screen>
  );
}
