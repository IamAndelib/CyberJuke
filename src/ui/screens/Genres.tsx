import { source } from '../../data';
import { player } from '../../player';
import { catalog } from '../../store/catalog';
import { genres, genresComplete } from '../../store/genres';
import { favoriteGenres, settings, toggleFavoriteGenre } from '../../store/library';
import { Icon } from '../icons';
import { openGenre } from '../nav';
import { ErrorState, PagedTracks } from '../components/TrackList';
import { Screen } from '../components/Screen';
import { usePaged } from '../usePaged';

export function Genres() {
  if (openGenre.value) return <GenreDetail genre={openGenre.value} />;
  return <GenreGrid />;
}

function GenreTile({ name, fav }: { name: string; fav: boolean }) {
  return (
    <div class={'genre-cell' + (fav ? ' fav' : '')} data-testid="genre-cell" data-genre={name}>
      <button class="genre-tile" onClick={() => (openGenre.value = name)} data-testid="genre-tile" data-genre={name}>
        <span class="genre-name">{name}</span>
      </button>
      <button
        class={'genre-fav' + (fav ? ' on' : '')}
        aria-pressed={fav}
        aria-label={fav ? `Remove ${name} from favorite genres` : `Add ${name} to favorite genres`}
        onClick={() => toggleFavoriteGenre(name)}
        data-testid="genre-fav"
      >
        <Icon name={fav ? 'heart' : 'heartOutline'} size={20} />
      </button>
    </div>
  );
}

function GenreGrid() {
  const list = genres.value;
  const favs = favoriteGenres.value;
  const status = catalog.status.value;
  const complete = genresComplete.value;

  return (
    <Screen
      testid="screen-genres"
      title="Genres"
      subtitle={complete ? `${list.length} genres on the Jukebox` : 'Browse by genre'}
      onRefresh={() => catalog.refresh({ force: true })}
      scrollKey="genres"
    >
      {favs.length > 0 && (
        <section data-testid="fav-genres">
          <div class="section-head">
            <h2 class="section-title">Favorite genres</h2>
          </div>
          <div class="genre-grid">
            {favs.map((name) => (
              <GenreTile key={name} name={name} fav />
            ))}
          </div>
        </section>
      )}
      {favs.length > 0 && (
        <div class="section-head">
          <h2 class="section-title">All genres</h2>
        </div>
      )}
      {status === 'error' && !list.length ? (
        <ErrorState
          offline={!!catalog.error.value?.offline}
          message="Couldn't load genres."
          onRetry={() => void catalog.refresh()}
        />
      ) : !list.length ? (
        <div class="genre-grid" aria-hidden="true" data-testid="genre-skeleton">
          {Array.from({ length: 10 }, (_, i) => (
            <div class="genre-tile skel-block" key={i} />
          ))}
        </div>
      ) : (
        <div class="genre-grid" data-testid="genre-grid">
          {list.map((g) => (
            <GenreTile key={g.name} name={g.name} fav={favs.includes(g.name)} />
          ))}
        </div>
      )}
      <p class="fineprint">Genres are free text chosen by each poster. Tap the heart to pin a genre to the top.</p>
    </Screen>
  );
}

function GenreDetail({ genre }: { genre: string }) {
  const nsfw = settings.value.showNsfw;
  const paged = usePaged(`genre:${genre}:${nsfw}`, async (c) => {
    const p = await source.byGenre(genre, c);
    // Some posts only carry the genre on the attachment, which the query can't see:
    // fall back to the local catalog rather than showing an empty genre.
    if (!c && !p.tracks.length) return { tracks: catalog.tracks.value.filter((t) => t.genre === genre), cursor: null };
    return p;
  });
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
      scrollKey={`genre:${genre}`}
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
