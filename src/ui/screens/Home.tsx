import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import { source } from '../../data';
import { player } from '../../player';
import { genres } from '../../store/genres';
import { settings } from '../../store/library';
import { toast } from '../../store/toast';
import { Icon } from '../icons';
import { PagedTracks } from '../components/TrackList';
import { Screen } from '../components/Screen';
import { usePaged } from '../usePaged';

/** Selected genre chip on Home (null = Latest). Survives tab switches. */
export const homeGenre = signal<string | null>(null);

export async function shuffleJukebox(): Promise<void> {
  const tracks = await source.shuffle(50);
  if (!tracks.length) throw new Error('No tracks found');
  await player.setShuffle(false);
  await player.playList(tracks, 0);
}

export function ShuffleHero() {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await shuffleJukebox();
    } catch (e) {
      toast((e as { offline?: boolean }).offline ? "You're offline" : "Couldn't shuffle right now");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="dos">
      <button class="hero dos-frame" onClick={go} data-testid="shuffle-all" aria-busy={busy}>
        <span class="hero-text">
          <span class="hero-kicker">Feeling lucky?</span>
          <span class="hero-title">Shuffle the Jukebox</span>
          <span class="hero-sub">{busy ? 'Spinning the reels…' : 'Random picks from recent posts'}</span>
        </span>
        <span class="hero-btn" aria-hidden="true">
          {busy ? <span class="spinner big" /> : <Icon name="shuffle" size={32} />}
        </span>
      </button>
      <div class="dos-shadow" aria-hidden="true" />
    </div>
  );
}

export function GenreChips() {
  const list = genres.value.slice(0, 24);
  const sel = homeGenre.value;
  // Keep a selected genre visible even if it's not in the top slice.
  const names = list.map((g) => g.name);
  if (sel && !names.includes(sel)) names.unshift(sel);
  return (
    <div class="chips" role="tablist" aria-label="Filter by genre" data-testid="genre-chips">
      <button
        class={'chip' + (sel == null ? ' on' : '')}
        role="tab"
        aria-selected={sel == null}
        onClick={() => (homeGenre.value = null)}
        data-testid="chip-all"
      >
        All
      </button>
      {names.map((name) => (
        <button
          key={name}
          class={'chip' + (sel === name ? ' on' : '')}
          role="tab"
          aria-selected={sel === name}
          onClick={() => (homeGenre.value = sel === name ? null : name)}
          data-testid="genre-chip"
          data-genre={name}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

export function Home() {
  const g = homeGenre.value;
  const nsfw = settings.value.showNsfw;
  const paged = usePaged(`home:${g ?? ''}:${nsfw}`, (c) => (g == null ? source.latest(c) : source.byGenre(g, c)));
  return (
    <Screen
      testid="screen-home"
      title={<span class="brand">CYBERJUKE</span>}
      subtitle="The Cyberspace Jukebox"
      onRefresh={paged.refresh}
    >
      <ShuffleHero />
      <GenreChips />
      <div class="section-head">
        <h2 class="section-title" data-testid="home-section-title">
          {g == null ? 'Latest' : g}
        </h2>
        {paged.tracks.length > 0 && (
          <button class="link-btn" onClick={() => player.playList(paged.tracks, 0)} data-testid="home-play-all">
            [Play all]
          </button>
        )}
      </div>
      <PagedTracks paged={paged} />
    </Screen>
  );
}
