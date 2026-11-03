import { computed, type ReadonlySignal } from '@preact/signals';
import { useCallback, useMemo, useRef } from 'preact/hooks';
import type { Track } from '../../data/model';
import { LOCAL_VIEWS, historyShown, likedShown, recentShown, settings, updateSettings, type LocalView } from '../../stores/library';
import type { LocalArtist } from '../../data/localGroups';
import { Cover } from '../../ui/components/Music';
import { addFolder, localFolderList, localLoading, localOn, localScan, localGroups, localTracks, lookAgain, scanningName, byTitle, tracksOf, turnOn, unreachableFolders } from '../../stores/local';
import { SkeletonRows } from '../../ui/components/TrackRow';
import { arrowChoice } from '../../ui/arrowChoice';
import { dayKey, groupByDay } from '../../stores/history';
import { useChunks } from '../../ui/useChunks';
import { clearHistoryWithUndo } from '../../stores/undo';
import { Icon, type IconName } from '../../ui/icons';
import { BackButton } from '../../ui/components/BackButton';
import { EmptyState, PlayShuffle, Tracks } from '../../ui/components/TrackList';
import { playFrom } from '../../ui/playAll';
import { TrackRow } from '../../ui/components/TrackRow';
import { Screen } from '../../ui/components/Screen';
import { PLAYLISTS_MAX, createPlaylist, playlistsShown } from '../../stores/playlists';
import { toast } from '../../stores/toast';
import { Mosaic } from '../../ui/components/Mosaic';
import { askConfirm, askName, nowPlayingOpen, openLibraryPage, openLocalPage, openUserPlaylist, openSettings, popToRoot, selectTab, useSearchContext } from '../../ui/nav';
import { list } from '../../ui/playAll';
import { afterPress } from '../../ui/press';
import { plural } from '../../core/text';

const LIKED_CTX = list('Liked');
const RECENT_CTX = list('Recently played');
const LOCAL_CTX = list('Local');

/** Library's list, from anywhere (the offline line, at the top and in Now Playing, and the offline toast's button). */
export function openLibrary(): void {
  nowPlayingOpen.value = false;
  popToRoot('library');
  selectTab('library');
}

/** M3: clearing history asks first, and can still be undone from the toast. It counts what the tab counts. */
function confirmClear(): void {
  askConfirm({
    title: 'Clear listening history?',
    body: 'Everything under Recently played goes.',
    confirm: `Clear ${plural(recentShown.peek().length, 'track')}`,
    run: clearHistoryWithUndo,
  });
}

/** A row's count: only it follows its list (a play changes Recently played's). */
function Count({ of, after }: { of: ReadonlySignal<Track[]>; after?: string }) {
  const n = of.value.length;
  return (
    <>
      <span class="count">{n}</span> {n === 1 ? 'song' : 'songs'}
      {after}
    </>
  );
}

/** One of Library's lists: an outlined tile with its icon, its name and count, a chevron; a tap opens its page. */
function LibRow({ icon, title, of, after, onOpen, testid }: { icon: IconName; title: string; of: ReadonlySignal<Track[]>; after?: string; onOpen: () => void; testid: string }) {
  return (
    <li class="row lib-row">
      <button class="row-main" onClick={(e) => afterPress(e.currentTarget, onOpen)} data-testid={testid}>
        <div class="row-art">
          <div class="lib-tile" aria-hidden="true">
            <Icon name={icon} size={24} />
          </div>
        </div>
        <div class="row-text">
          <div class="row-title">{title}</div>
          <div class="row-artist">
            <Count of={of} after={after} />
          </div>
        </div>
        <Icon name="chevron" size={16} class="lib-chev" />
      </button>
    </li>
  );
}

/** Liked and Recently played, each once, for Here search on Library's list. */
const libraryTracks = computed(() => {
  const seen = new Set<string>();
  return [...likedShown.value, ...recentShown.value].filter((t) => !seen.has(t.id) && (seen.add(t.id), true));
});

/** The Library tab: a list of its lists, each opening its own page. */
export function Library() {
  useSearchContext({ label: 'Library', tracks: () => libraryTracks.value });
  return (
    <Screen testid="screen-library" title="Library" subtitle="On this device" scrollKey="library">
      <ul class="list lib-list" aria-label="Library">
        <LibRow icon="heart" title="Liked" of={likedShown} onOpen={() => openLibraryPage('liked')} testid="lib-liked" />
        <LibRow icon="clock" title="Recently played" of={recentShown} onOpen={() => openLibraryPage('recent')} testid="lib-recent" />
        {localOn.value && <LibRow icon="folder" title="Local" of={localTracks} after=" · on this phone" onOpen={() => openLibraryPage('local')} testid="lib-local" />}
      </ul>
      <Playlists />
    </Screen>
  );
}

/** New playlist from Library: its name, then its (empty) page. */
function newPlaylist(): void {
  askName({
    title: 'New playlist',
    confirm: 'Create',
    run: (name) => {
      const r = createPlaylist(name);
      if (r.result === 'created') openUserPlaylist(r.id);
      else if (r.result === 'full') toast(`You have ${PLAYLISTS_MAX} playlists, the most there can be`);
    },
  });
}

/** Library's playlists, newest first, under its lists; with none, a way to make one. */
function Playlists() {
  const all = playlistsShown.value;
  return (
    <section data-testid="lib-playlists">
      <div class="section-head">
        <h2 class="section-title">Playlists</h2>
        {all.length > 0 && (
          <button class="link-btn lib-new" onClick={(e) => afterPress(e.currentTarget, newPlaylist)} data-testid="lib-new-playlist">
            [New playlist]
          </button>
        )}
      </div>
      {all.length ? (
        <ul class="list lib-list" aria-label="Playlists">
          {all.map((p) => (
            <li key={p.id} class="row lib-row">
              <button class="row-main" onClick={(e) => afterPress(e.currentTarget, () => openUserPlaylist(p.id))} data-testid="lib-playlist">
                <div class="row-art">
                  <Mosaic tracks={p.tracks} size="sm" />
                </div>
                <div class="row-text">
                  <div class="row-title" data-testid="lib-playlist-name">
                    {p.name}
                  </div>
                  <div class="row-artist">{plural(p.tracks.length, 'song')}</div>
                </div>
                <Icon name="chevron" size={16} class="lib-chev" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No playlists yet" testid="lib-playlists-empty">
          Make one here, or with <Icon name="playlistAdd" size={16} /> in the player.
          <div>
            <button class="btn primary local-add" onClick={(e) => afterPress(e.currentTarget, newPlaylist)} data-testid="lib-make-playlist">
              New playlist
            </button>
          </div>
        </EmptyState>
      )}
    </section>
  );
}

/** Liked, its own page: Play and Shuffle, the songs. */
export function LikedPage() {
  const tracks = likedShown.value;
  useSearchContext({ label: 'Liked', tracks: () => likedShown.value });
  return (
    <Screen testid="screen-liked" title="Liked" subtitle="Library" left={<BackButton testid="liked-back" />} scrollKey="library:liked">
      {tracks.length > 0 && <PlayShuffle tracks={tracks} ctx={LIKED_CTX} testid="lib" playTestid="lib-play-all" />}
      <div data-testid="liked-list">
        {tracks.length ? (
          <Tracks tracks={tracks} ctx={LIKED_CTX} />
        ) : (
          <EmptyState title="No liked songs yet">
            Tap <Icon name="heartOutline" size={16} /> in the player, or Like in a track's ⋯ menu, to keep it here.
            <div>
              <button class="link-btn" onClick={(e) => afterPress(e.currentTarget, () => selectTab('home'))}>
                [Browse the Jukebox]
              </button>
            </div>
          </EmptyState>
        )}
      </div>
    </Screen>
  );
}

/** Recently played, its own page: by day, newest first; [Clear] in its top bar. */
export function RecentPage() {
  const tracks = recentShown.value;
  useSearchContext({ label: 'Recently played', tracks: () => recentShown.value });
  return (
    <Screen
      testid="screen-recent"
      title="Recently played"
      subtitle="Library"
      left={<BackButton testid="recent-back" />}
      scrollKey="library:recent"
      right={
        tracks.length > 0 ? (
          // Away from Play / Shuffle, so it can't be hit by accident.
          <button class="link-btn lib-clear" onClick={confirmClear} data-testid="lib-clear">
            [Clear]
          </button>
        ) : undefined
      }
    >
      {tracks.length > 0 && <PlayShuffle tracks={tracks} ctx={RECENT_CTX} testid="lib" playTestid="lib-play-all" />}
      <div data-testid="recent-list">{tracks.length ? <HistoryDays /> : <EmptyState title="Nothing played yet">Tracks you play show up here, newest first.</EmptyState>}</div>
    </Screen>
  );
}

/**
 * Recently played, grouped by day (Today, Yesterday, Mon 6 Oct), rendered in chunks as you
 * scroll. A track appears once per day; tapping one plays the whole history from there.
 */
function HistoryDays() {
  const entries = historyShown.value;
  const today = dayKey(Date.now());
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `today`: the labels change at midnight
  const days = useMemo(() => groupByDay(entries, Date.now()), [entries, today]);
  const all = useMemo(() => days.flatMap((d) => d.tracks), [days]);
  const { shown, sentinel, more } = useChunks(all.length, 'history');
  // Each play goes on top, so rows are numbered from the bottom: a new play leaves the
  // numbers (and so the memoised rows) of those already there alone, and onPlay is one
  // function for good (it reads the rows through a ref).
  const rows = useRef(all);
  rows.current = all;
  // The rows list a track once per day; what plays is the history with each track once (as
  // Play does), from the tapped one.
  const onPlay = useCallback((fromEnd: number) => {
    const list = recentShown.peek();
    const id = rows.current[rows.current.length - 1 - fromEnd]?.id;
    void playFrom(list, Math.max(0, list.findIndex((t) => t.id === id)), RECENT_CTX);
  }, []);
  let offset = 0;
  return (
    <>
      {days.map((d) => {
        const start = offset;
        offset += d.tracks.length;
        if (start >= shown) return null;
        return (
          <section key={d.key} class="day-group" data-testid="history-day" data-day={d.key}>
            <h3 class="day-head" data-testid="history-day-label">
              <span>{d.label}</span>
              <span class="day-count">{d.tracks.length}</span>
            </h3>
            <ul class="list" data-testid="track-list">
              {d.tracks.slice(0, shown - start).map((t, i) => (
                <TrackRow key={t.id} track={t} index={all.length - 1 - (start + i)} onPlay={onPlay} />
              ))}
            </ul>
          </section>
        );
      })}
      {more ? <div ref={sentinel} class="list-foot" aria-hidden="true" /> : <div class="list-foot end">— end of tape —</div>}
    </>
  );
}

const VIEW_LABELS: Record<LocalView, string> = { songs: 'Songs', albums: 'Albums', artists: 'Artists' };

/** Local as its songs, albums or artists, remembered. */
function ViewSwitch() {
  const cur = settings.value.localView;
  const choose = (v: LocalView) => updateSettings({ localView: v });
  return (
    <div class="segmented local-sort" role="radiogroup" aria-label="Show" onKeyDown={arrowChoice(LOCAL_VIEWS, cur, choose)} data-testid="local-view">
      {LOCAL_VIEWS.map((v) => (
        <button key={v} role="radio" aria-checked={cur === v} tabIndex={cur === v ? 0 : -1} class={cur === v ? 'on' : ''} onClick={() => choose(v)} data-value={v} data-testid={`local-view-${v}`}>
          {VIEW_LABELS[v]}
        </button>
      ))}
    </div>
  );
}

/** Local's albums: a grid of covers, A–Z; a tap opens the album. */
function AlbumGrid() {
  return (
    <ul class="release-grid" data-testid="local-albums">
      {localGroups.value.albums.map((a) => (
        <li key={a.key}>
          <button
            class="shelf-btn release-btn"
            onClick={(e) => afterPress(e.currentTarget, () => openLocalPage('localAlbum', a.key))}
            aria-label={`Open album ${a.title} by ${a.artist}`}
            data-testid="local-album"
          >
            <Cover url={a.cover} size="md" />
            <span class="shelf-title" data-testid="local-album-title">
              {a.title}
            </span>
            <span class="shelf-year">{!a.artist ? plural(a.songs.length, 'song') : a.year ? `${a.artist} · ${a.year}` : a.artist}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** "2 albums · 7 songs", or only the songs when there's no album. */
const artistCounts = (a: LocalArtist) => (a.albums.length ? `${plural(a.albums.length, 'album')} · ${plural(a.songs.length, 'song')}` : plural(a.songs.length, 'song'));

/** Local's artists, A–Z (Unknown artist last); a tap opens the artist. */
function ArtistList() {
  return (
    <ul class="list lib-list" data-testid="local-artists">
      {localGroups.value.artists.map((a) => (
        <li key={a.key} class="row lib-row">
          <button class="row-main" onClick={(e) => afterPress(e.currentTarget, () => openLocalPage('localArtist', a.key))} data-testid="local-artist">
            <div class="row-art">
              <Cover url={a.albums.find((x) => x.cover)?.cover} size="sm" round />
            </div>
            <div class="row-text">
              <div class="row-title" data-testid="local-artist-name">
                {a.name}
              </div>
              <div class="row-artist">{artistCounts(a)}</div>
            </div>
            <Icon name="chevron" size={16} class="lib-chev" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A folder that can't be read right now: its songs are hidden until it's chosen again. */
function Unreachable() {
  return (
    <>
      {unreachableFolders.value.map((f) => (
        <div key={f.id} class="local-gone" role="status" data-testid="local-gone">
          <span>
            Can’t reach “{f.name}”.{f.songs > 0 && (f.songs === 1 ? ' Its 1 song is hidden.' : ` Its ${f.songs} songs are hidden.`)}
          </span>
          <button class="link-btn" onClick={() => void addFolder(f.id)} data-testid="local-gone-again">
            [Choose it again]
          </button>
        </div>
      ))}
    </>
  );
}

const sortedLocal = computed(() => byTitle(localTracks.value));

/** Library → Local: the songs in the folders chosen in Settings, as songs, albums or artists; + adds a folder, pull down looks again. */
export function LocalPage() {
  const tracks = sortedLocal.value;
  const scan = localScan.value;
  const view = settings.value.localView;
  useSearchContext({ label: 'Local', tracks: () => sortedLocal.value });
  const looking = scan && <p class="local-status" role="status" data-testid="local-status">{`Looking in ${scanningName.value}… ${plural(scan.found, 'song')} so far`}</p>;
  let body;
  if (tracks.length) {
    body = (
      <>
        {looking}
        <PlayShuffle tracks={tracks} ctx={LOCAL_CTX} testid="local" />
        <ViewSwitch />
        {view === 'albums' ? (
          <AlbumGrid />
        ) : view === 'artists' ? (
          <ArtistList />
        ) : (
          <div data-testid="local-list">
            <Tracks tracks={tracks} ctx={LOCAL_CTX} inLocal chunkKey="local" />
          </div>
        )}
      </>
    );
  } else if (scan || localLoading.value) {
    body = (
      <div data-testid="local-looking">
        {looking}
        <SkeletonRows n={6} />
      </div>
    );
  } else if (!settings.value.localMusic || !localFolderList.value.length) {
    body = (
      <EmptyState title="No folders yet" testid="local-empty">
        Choose the folders CyberJuke may play music from. It looks nowhere else.
        <div>
          <button class="btn primary local-add" onClick={() => void turnOn()} data-testid="local-add">
            Add folder
          </button>
        </div>
      </EmptyState>
    );
  } else if (!unreachableFolders.value.length) {
    body = (
      <EmptyState title="No music in these folders" testid="local-none">
        CyberJuke plays MP3, FLAC, Ogg, Opus, M4A and WAV files.
        <div>
          <button class="link-btn" onClick={() => void addFolder()} data-testid="local-none-add">
            [Add folder]
          </button>{' '}
          <button class="link-btn" onClick={(e) => afterPress(e.currentTarget, openSettings)} data-testid="local-none-folders">
            [Folders]
          </button>
        </div>
      </EmptyState>
    );
  }
  return (
    <Screen
      testid="screen-local"
      title="Local"
      subtitle="On this phone"
      left={<BackButton testid="local-back" />}
      right={
        <button class="icon-btn" onClick={(e) => afterPress(e.currentTarget, () => void turnOn())} aria-label="Add folder" data-testid="local-add-top">
          <Icon name="plus" />
        </button>
      }
      scrollKey={`library:local:${view}`}
      onRefresh={lookAgain}
      refreshOffline
    >
      <Unreachable />
      {body}
    </Screen>
  );
}

/** What a local album or artist page shows once its folder has gone (removed, out of reach, local music off). */
function GonePage({ testid }: { testid: string }) {
  return (
    <Screen testid={testid} title="Local" subtitle="On this phone" left={<BackButton testid="local-back" />}>
      <EmptyState title="Not on the phone any more">Its songs aren’t in your chosen folders now.</EmptyState>
    </Screen>
  );
}

/** A local album: its cover, title, artist (opens the artist), year and songs in track order. */
export function LocalAlbumPage({ albumKey }: { albumKey: string }) {
  const a = localGroups.value.albums.find((x) => x.key === albumKey);
  const tracks = a ? tracksOf(a.songs) : [];
  useSearchContext({ label: a?.title ?? 'Local', tracks: () => tracks });
  if (!a) return <GonePage testid="screen-local-album" />;
  const ctx = list(a.title);
  return (
    <Screen testid="screen-local-album" class="album-screen" title={a.title} subtitle="Album · on this phone" left={<BackButton testid="local-album-back" />} scrollKey={`local-album:${a.key}`}>
      <div class="album-head">
        <div class="dos album-cover">
          <div class="dos-frame">
            <Cover url={a.cover} size="lg" />
          </div>
          <div class="dos-shadow" aria-hidden="true" />
        </div>
        <div class="album-info">
          <h2 class="album-title" data-testid="album-title">
            {a.title}
          </h2>
          {a.artist ? (
            <button class="np-link album-artist" onClick={(e) => afterPress(e.currentTarget, () => openLocalPage('localArtist', a.artistKey))} data-testid="album-artist">
              {a.artist}
            </button>
          ) : (
            <div class="album-artist dim">Songs with no album tag</div>
          )}
          <div class="dim small">{a.year ? `${a.year} · ${plural(tracks.length, 'song')}` : plural(tracks.length, 'song')}</div>
        </div>
      </div>
      <PlayShuffle tracks={tracks} ctx={ctx} testid="album" />
      <div data-testid="local-album-list">
        <Tracks tracks={tracks} ctx={ctx} inLocal />
      </div>
      <div class="list-foot end">— end of tape —</div>
    </Screen>
  );
}

/** A local artist: Play and Shuffle, their albums newest first, then every song of theirs. */
export function LocalArtistPage({ artistKey }: { artistKey: string }) {
  const a = localGroups.value.artists.find((x) => x.key === artistKey);
  const tracks = a ? tracksOf(a.songs) : [];
  useSearchContext({ label: a?.name ?? 'Local', tracks: () => tracks });
  if (!a) return <GonePage testid="screen-local-artist" />;
  const ctx = list(a.name);
  return (
    <Screen testid="screen-local-artist" title={a.name} subtitle="Artist · on this phone" left={<BackButton testid="local-artist-back" />} scrollKey={`local-artist:${a.key}`}>
      <PlayShuffle tracks={tracks} ctx={ctx} testid="artist" />
      {a.albums.length > 0 && (
        <section data-kind="album" data-testid="local-artist-albums">
          <div class="section-head">
            <h2 class="section-title">Albums</h2>
          </div>
          <ul class="shelf">
            {a.albums.map((al) => (
              <li key={al.key} class="shelf-item">
                <button
                  class="shelf-btn release-btn"
                  onClick={(e) => afterPress(e.currentTarget, () => openLocalPage('localAlbum', al.key))}
                  aria-label={`Open album ${al.title}${al.year ? `, ${al.year}` : ''}`}
                  data-testid="local-album"
                >
                  <Cover url={al.cover} size="md" />
                  <span class="shelf-title" data-testid="local-album-title">
                    {al.title}
                  </span>
                  {al.year > 0 && <span class="shelf-year">{al.year}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div class="section-head">
        <h2 class="section-title">Songs</h2>
      </div>
      <div data-testid="local-artist-songs">
        <Tracks tracks={tracks} ctx={ctx} inLocal />
      </div>
    </Screen>
  );
}
