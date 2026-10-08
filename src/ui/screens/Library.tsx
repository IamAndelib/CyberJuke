import { signal } from '@preact/signals';
import { player } from '../../player';
import { clearRecent, history, liked, recent } from '../../store/library';
import { groupByDay } from '../../store/history';
import { Icon } from '../icons';
import { EmptyState, Tracks, playFrom } from '../components/TrackList';
import { TrackRow } from '../components/TrackRow';
import { Screen } from '../components/Screen';
import { tab, useSearchContext } from '../nav';

const section = signal<'liked' | 'recent'>('liked');

export function Library() {
  const sel = section.value;
  const tracks = sel === 'liked' ? liked.value : recent.value;
  useSearchContext(sel === 'liked' ? { label: 'Liked', tracks: () => liked.value } : { label: 'Recently played', tracks: () => recent.value });
  return (
    <Screen testid="screen-library" title="Library" subtitle="Saved on this device" scrollKey={`library:${sel}`}>
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
          sel === 'liked' ? <Tracks tracks={tracks} /> : <HistoryDays />
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

/**
 * Recently played, grouped by day (Today, Yesterday, Mon 6 Oct). A track appears once
 * per day; tapping one plays the whole history from there.
 */
function HistoryDays() {
  const days = groupByDay(history.value, Date.now());
  const all = days.flatMap((d) => d.tracks);
  let offset = 0;
  return (
    <>
      {days.map((d) => {
        const start = offset;
        offset += d.tracks.length;
        return (
          <section key={d.key} class="day-group" data-testid="history-day" data-day={d.key}>
            <h3 class="day-head" data-testid="history-day-label">
              <span>{d.label}</span>
              <span class="day-count">{d.tracks.length}</span>
            </h3>
            <ul class="list" data-testid="track-list">
              {d.tracks.map((t, i) => (
                <TrackRow key={t.id} track={t} index={start + i} onPlay={() => playFrom(all, start + i)} />
              ))}
            </ul>
          </section>
        );
      })}
      <div class="list-foot end">— end of tape —</div>
    </>
  );
}
