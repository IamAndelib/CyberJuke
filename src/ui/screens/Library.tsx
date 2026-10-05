import { signal } from '@preact/signals';
import { player } from '../../player';
import { clearRecent, liked, recent } from '../../store/library';
import { Icon } from '../icons';
import { EmptyState, Tracks } from '../components/TrackList';
import { Screen } from '../components/Screen';
import { tab } from '../nav';

const section = signal<'liked' | 'recent'>('liked');

export function Library() {
  const sel = section.value;
  const tracks = sel === 'liked' ? liked.value : recent.value;
  return (
    <Screen testid="screen-library" title="Library" subtitle="Saved on this device">
      <div class="segmented" role="tablist" aria-label="Library section">
        <button
          role="tab"
          aria-selected={sel === 'liked'}
          class={sel === 'liked' ? 'on' : ''}
          onClick={() => (section.value = 'liked')}
          data-testid="lib-liked"
        >
          Liked <span class="count">{liked.value.length}</span>
        </button>
        <button
          role="tab"
          aria-selected={sel === 'recent'}
          class={sel === 'recent' ? 'on' : ''}
          onClick={() => (section.value = 'recent')}
          data-testid="lib-recent"
        >
          Recently played <span class="count">{recent.value.length}</span>
        </button>
      </div>

      {tracks.length > 0 && (
        <div class="actions">
          <button class="btn primary" onClick={() => player.playList(tracks, 0)} data-testid="lib-play-all">
            <Icon name="play" size={18} /> Play all
          </button>
          <button
            class="btn"
            onClick={async () => {
              await player.playList(tracks, Math.floor(Math.random() * tracks.length));
              await player.setShuffle(true);
            }}
          >
            <Icon name="shuffle" size={18} /> Shuffle
          </button>
          {sel === 'recent' && (
            <button class="link-btn push-right" onClick={clearRecent}>
              [Clear]
            </button>
          )}
        </div>
      )}

      <div data-testid={sel === 'liked' ? 'liked-list' : 'recent-list'}>
        {tracks.length ? (
          <Tracks tracks={tracks} />
        ) : sel === 'liked' ? (
          <EmptyState title="No liked tracks yet">
            Tap <Icon name="heartOutline" size={16} /> in the player, or Like in a track's ⋯ menu, to keep it here.
            <div>
              <button class="link-btn" onClick={() => (tab.value = 'home')}>
                [Browse the Jukebox]
              </button>
            </div>
          </EmptyState>
        ) : (
          <EmptyState title="Nothing played yet">Tracks you play show up here, newest first.</EmptyState>
        )}
      </div>
    </Screen>
  );
}
