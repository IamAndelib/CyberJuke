import { useRef } from 'preact/hooks';
import type { Track } from '../../data/model';
import { playlistHas, playlists, playlistsShown } from '../../stores/playlists';
import { addToPlaylistWithUndo, createWithSongWithUndo } from '../../stores/undo';
import { Icon } from '../icons';
import { addToPlaylistFor, askName, menuTrack } from '../nav';
import { useModal, useSheetContent } from '../useModal';
import { plural } from '../../core/text';
import { SheetCancel } from './ConfirmSheet';
import { Mosaic } from './Mosaic';

/** New playlist with [track] in it: you stay where you are, and Undo takes the song out (the playlist stays). */
function newPlaylistWith(track: Track): void {
  askName({ title: 'New playlist', note: `With ${track.title}`, confirm: 'Create', run: (name) => void createWithSongWithUndo(name, track) });
}

/** Add to playlist for [track] (the song menu, Now Playing's ≡+): the sheet, or with no playlists yet, New playlist at once. */
export function addToPlaylist(track: Track): void {
  menuTrack.value = null;
  if (!playlists.peek().length) newPlaylistWith(track);
  else addToPlaylistFor.value = track;
}

/** "Add to playlist" / the song: New playlist first, then the playlists, most recently added-to first; one that has it is ticked and off. */
export function AddToPlaylistSheet() {
  const track = addToPlaylistFor.value;
  const sheet = useRef<HTMLDivElement>(null);
  const t = useSheetContent(track, sheet);
  const close = () => (addToPlaylistFor.value = null);
  useModal(track != null, sheet);
  const lists = [...playlistsShown.value].sort((a, b) => b.updated - a.updated);
  return (
    <div class={'sheet-wrap' + (track ? ' open' : '')} aria-hidden={!track} inert={!track}>
      <div class="scrim" onClick={close} />
      <div class="sheet" ref={sheet} role="dialog" aria-modal="true" aria-label="Add to playlist" data-testid="add-to-playlist">
        {t && (
          <>
            <div class="sheet-head confirm-head">
              <div class="row-text">
                <div class="row-title">Add to playlist</div>
                <div class="row-artist">
                  {t.title} · {t.artist}
                </div>
              </div>
            </div>
            <div>
              <button
                class="sheet-item"
                onClick={() => {
                  close();
                  newPlaylistWith(t);
                }}
                data-testid="pl-pick-new"
              >
                <Icon name="plus" size={20} /> New playlist
              </button>
              {lists.map((p) => {
                const has = playlistHas(p.id, t.id);
                return (
                  <button
                    key={p.id}
                    class={'sheet-item pl-pick' + (has ? ' has' : '')}
                    disabled={has}
                    onClick={() => {
                      close();
                      addToPlaylistWithUndo(p.id, t);
                    }}
                    data-testid="pl-pick"
                  >
                    <Mosaic tracks={p.tracks} size="sm" />
                    <span class="sheet-text pl-pick-text">
                      <span class="pl-pick-name">{p.name}</span>
                      <span class="pl-pick-sub">{has ? 'Already in it' : plural(p.tracks.length, 'song')}</span>
                    </span>
                    {has && <Icon name="check" size={20} />}
                  </button>
                );
              })}
            </div>
            <SheetCancel onClose={close} />
          </>
        )}
      </div>
    </div>
  );
}
