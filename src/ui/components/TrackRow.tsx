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

/** A members-only post (seen only when signed in with Cyberspace). */
export function MembersTag({ class: cls }: { class?: string }) {
  return (
    <span class={'mtag' + (cls ? ' ' + cls : '')} title="Members-only post" aria-label="Members-only post" data-testid="members-tag">
      [members]
    </span>
  );
}

export function TrackRow({
  track,
  onPlay,
  index,
  hideGenre,
  showSaves,
}: {
  track: Track;
  onPlay: () => void;
  index?: number;
  hideGenre?: boolean;
  /** Show the post's save count (Most saved). */
  showSaves?: boolean;
}) {
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
            {showSaves && (
              <span class="saves" data-testid="track-saves" data-saves={track.saves ?? 0} aria-label={`${track.saves ?? 0} saves`}>
                <Icon name="heart" size={12} />
                {track.saves ?? 0}
              </span>
            )}
            {track.membersOnly && <MembersTag />}
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
