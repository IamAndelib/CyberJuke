import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { Track } from '../../data/model';
import { deletePlaylist, moveInPlaylist, playlistShown, renamePlaylist } from '../../stores/playlists';
import { removeFromPlaylistWithUndo } from '../../stores/undo';
import { Art } from '../../ui/components/Art';
import { BackButton } from '../../ui/components/BackButton';
import { SheetCancel } from '../../ui/components/ConfirmSheet';
import { Mosaic } from '../../ui/components/Mosaic';
import { Screen } from '../../ui/components/Screen';
import { EmptyState, PlayShuffle, Tracks } from '../../ui/components/TrackList';
import { Icon } from '../../ui/icons';
import { askConfirm, askName, playlistMenuFor, popPage, useSearchContext } from '../../ui/nav';
import { list } from '../../ui/playAll';
import { useModal, useSheetContent } from '../../ui/useModal';
import { plural } from '../../core/text';

/** The playlist whose songs are being edited (↑ ↓ ✕), if any. */
const editing = signal<string | null>(null);

/** A song's row while editing: its art and names, then ↑ ↓ ✕ (Up next's buttons). */
function EditRow({ id, track, first, last }: { id: string; track: Track; first: boolean; last: boolean }) {
  return (
    <li class="row pl-edit-row" data-testid="pl-edit-row">
      <div class="row-main">
        <div class="row-art">
          <Art track={track} size="sm" />
        </div>
        <div class="row-text">
          <div class="row-title" data-testid="track-title">
            {track.title}
          </div>
          <div class="row-artist">{track.artist}</div>
        </div>
      </div>
      <div class="pl-edit-actions">
        <button class="icon-btn" disabled={first} onClick={() => moveInPlaylist(id, track.id, -1)} aria-label={`Move ${track.title} up`} data-testid="pl-up">
          <Icon name="up" size={20} />
        </button>
        <button class="icon-btn" disabled={last} onClick={() => moveInPlaylist(id, track.id, 1)} aria-label={`Move ${track.title} down`} data-testid="pl-down">
          <Icon name="down" size={20} />
        </button>
        <button class="icon-btn" onClick={() => removeFromPlaylistWithUndo(id, track.id)} aria-label={`Remove ${track.title}`} data-testid="pl-remove">
          <Icon name="close" size={20} />
        </button>
      </div>
    </li>
  );
}

/** One of your playlists: its mosaic, name and count, Play and Shuffle, the songs; ⋯ for Edit songs, Rename, Delete. */
export function PlaylistPage({ id }: { id: string }) {
  const p = playlistShown(id);
  const isEditing = editing.value === id;
  useSearchContext({ label: p?.name ?? 'Playlist', tracks: () => playlistShown(id)?.tracks ?? [] });
  // Leaving the page ends editing.
  useEffect(() => () => void (editing.value === id && (editing.value = null)), [id]);
  if (!p)
    return (
      <Screen testid="screen-playlist" title="Playlist" left={<BackButton testid="playlist-back" />}>
        <EmptyState title="This playlist is gone" />
      </Screen>
    );
  const tracks = p.tracks;
  const ctx = list(p.name);
  return (
    <Screen
      testid="screen-playlist"
      class="album-screen"
      title={p.name}
      subtitle="Playlist"
      left={<BackButton testid="playlist-back" />}
      right={
        isEditing ? (
          <button class="link-btn pl-done" onClick={() => (editing.value = null)} data-testid="pl-done">
            [Done]
          </button>
        ) : (
          <button class="icon-btn" onClick={() => (playlistMenuFor.value = id)} aria-label={`More options for ${p.name}`} aria-haspopup="dialog" data-testid="pl-more">
            <Icon name="more" />
          </button>
        )
      }
      scrollKey={`playlist:${id}`}
    >
      <div class="album-head">
        <div class="dos album-cover">
          <div class="dos-frame">
            <Mosaic tracks={tracks} size="lg" />
          </div>
          <div class="dos-shadow" aria-hidden="true" />
        </div>
        <div class="album-info">
          <h2 class="album-title" data-testid="pl-title">
            {p.name}
          </h2>
          <div class="dim small pl-count" data-testid="pl-count">
            Playlist · {plural(tracks.length, 'song')}
          </div>
        </div>
      </div>
      {tracks.length === 0 ? (
        <EmptyState title="No songs yet" testid="pl-empty">
          Add songs with <Icon name="playlistAdd" size={16} /> in the player or a song's ⋯ menu.
        </EmptyState>
      ) : isEditing ? (
        <ul class="list" data-testid="pl-edit-list">
          {tracks.map((t, i) => (
            <EditRow key={t.id} id={id} track={t} first={i === 0} last={i === tracks.length - 1} />
          ))}
        </ul>
      ) : (
        <>
          <PlayShuffle tracks={tracks} ctx={ctx} testid="pl" />
          <div data-testid="pl-list">
            <Tracks tracks={tracks} ctx={ctx} chunkKey={`playlist:${id}`} />
          </div>
          <div class="list-foot end">— end of tape —</div>
        </>
      )}
    </Screen>
  );
}

/** A playlist's ⋯: its mosaic and name, then Edit songs, Rename and Delete playlist. */
export function PlaylistMenu() {
  const id = playlistMenuFor.value;
  const p = id ? playlistShown(id) : null;
  const sheet = useRef<HTMLDivElement>(null);
  const r = useSheetContent(p, sheet);
  const close = () => (playlistMenuFor.value = null);
  useModal(p != null, sheet);
  return (
    <div class={'sheet-wrap' + (p ? ' open' : '')} aria-hidden={!p} inert={!p}>
      <div class="scrim" onClick={close} />
      <div class="sheet" ref={sheet} role="dialog" aria-modal="true" aria-label="Playlist options" data-testid="pl-menu">
        {r && (
          <>
            <div class="sheet-head">
              <Mosaic tracks={r.tracks} size="sm" />
              <div class="row-text">
                <div class="row-title">{r.name}</div>
                <div class="row-artist">{plural(r.tracks.length, 'song')}</div>
              </div>
            </div>
            {r.tracks.length > 0 && (
              <button
                class="sheet-item"
                onClick={() => {
                  close();
                  editing.value = r.id;
                }}
                data-testid="pl-edit"
              >
                <Icon name="up" size={20} /> Edit songs
              </button>
            )}
            <button
              class="sheet-item"
              onClick={() => {
                close();
                askName({ title: 'Rename playlist', initial: r.name, confirm: 'Rename', run: (n) => void renamePlaylist(r.id, n) });
              }}
              data-testid="pl-rename"
            >
              <Icon name="note" size={20} /> Rename
            </button>
            <button
              class="sheet-item"
              onClick={() => {
                close();
                askConfirm({
                  title: `Delete ${r.name}?`,
                  ...(r.tracks.length > 0 && { body: `Its ${plural(r.tracks.length, 'song')} stay wherever else they are: Liked, other playlists, the Jukebox.` }),
                  confirm: 'Delete playlist',
                  run: () => {
                    deletePlaylist(r.id);
                    popPage();
                  },
                });
              }}
              data-testid="pl-delete"
            >
              <Icon name="close" size={20} /> Delete playlist
            </button>
            <SheetCancel onClose={close} />
          </>
        )}
      </div>
    </div>
  );
}
