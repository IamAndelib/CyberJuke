import type { Track } from '../../data/model';
import { player } from '../../player';
import { Icon } from '../icons';
import { menuTrack } from '../nav';
import { Art } from './Art';

export function Bars() {
  return (
    <span class="bars" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

export function TrackRow({ track, onPlay, index, hideGenre }: { track: Track; onPlay: () => void; index?: number; hideGenre?: boolean }) {
  const st = player.state.value;
  const isCurrent = st.current?.id === track.id;
  return (
    <li class={'row' + (isCurrent ? ' is-current' : '')} data-testid="track-row" data-track-id={track.id}>
      <button
        class="row-main"
        onClick={onPlay}
        aria-label={`Play ${track.title} by ${track.artist}`}
        data-testid="track-play"
        data-index={index}
      >
        <div class="row-art">
          <Art track={track} size="sm" />
          {isCurrent && (
            <div class="row-art-badge">{st.isPlaying ? <Bars /> : <Icon name="pause" size={18} />}</div>
          )}
        </div>
        <div class="row-text">
          <div class="row-title" data-testid="track-title">
            {track.title}
          </div>
          <div class="row-artist">{track.artist}</div>
          <div class="row-meta">
            {track.genre && !hideGenre && <span class="tag">{track.genre}</span>}
            {track.by && <span class="by">by @{track.by}</span>}
          </div>
        </div>
      </button>
      <button
        class="icon-btn row-more"
        aria-label={`More options for ${track.title}`}
        aria-haspopup="dialog"
        data-testid="track-more"
        onClick={() => (menuTrack.value = track)}
      >
        <Icon name="more" />
      </button>
    </li>
  );
}

export function SkeletonRows({ n = 8 }: { n?: number }) {
  return (
    <ul class="list" aria-hidden="true" data-testid="skeleton">
      {Array.from({ length: n }, (_, i) => (
        <li class="row skel" key={i}>
          <div class="row-main">
            <div class="row-art">
              <div class="art art-sm skel-block" />
            </div>
            <div class="row-text">
              <div class="skel-line" style={{ width: `${55 + ((i * 37) % 35)}%` }} />
              <div class="skel-line dim" style={{ width: `${30 + ((i * 23) % 30)}%` }} />
              <div class="skel-line dim short" />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
