import { computed, type ReadonlySignal, type Signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { libraryLayout, localAlbumsOrder, localArtistsOrder, localSongsOrder } from '../../stores/prefs';
import { useCallback, useMemo, useRef } from 'preact/hooks';
import type { Track } from '../../data/model';
import { LOCAL_VIEWS, historyShown, likedShown, recentShown, settings, updateSettings, type LocalView } from '../../stores/library';
import { UNKNOWN_ALBUM_KEY, UNKNOWN_ARTIST, byMostSongs, type LocalAlbum, type LocalArtist } from '../../data/localGroups';
import { groupAZ } from '../../ui/azSections';
import { AZHead } from '../../ui/components/GridSort';
import { Rail } from '../../ui/components/Rail';
import { Cover } from '../../ui/components/Music';
import { addFolder, localFolderList, localLoading, localOn, localScan, localGroups, localTracks, lookAgain, newestLocal, scanningName, tracksOf, turnOn, unreachableFolders } from '../../stores/local';
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

/** A list's mark: an outlined square with its icon, a label, not a missing picture. */
const ListTile = ({ icon }: { icon: IconName }) => (
  <div class="lib-tile" aria-hidden="true">
    <Icon name={icon} size={24} />
  </div>
);

/**
 * One of Library's lists or playlists, a tap opens its page: a row (its picture, name and count,
 * a chevron) or, in the grid, a tile (the picture over the name and count).
 */
function LibItem({ art, title, sub, onOpen, testid, nameTestid }: { art: ComponentChildren; title: string; sub: ComponentChildren; onOpen: () => void; testid: string; nameTestid?: string }) {
  const open = (e: MouseEvent) => afterPress(e.currentTarget as HTMLElement, onOpen);
  if (libraryLayout.value === 'grid')
    return (
      <li>
        <button class="shelf-btn release-btn lib-cell" onClick={open} data-testid={testid}>
          {art}
          <span class="shelf-title" data-testid={nameTestid}>
            {title}
          </span>
          <span class="shelf-year">{sub}</span>
        </button>
      </li>
    );
  return (
    <li class="row lib-row">
      <button class="row-main" onClick={open} data-testid={testid}>
        <div class="row-art">{art}</div>
        <div class="row-text">
          <div class="row-title" data-testid={nameTestid}>
            {title}
          </div>
          <div class="row-artist">{sub}</div>
        </div>
        <Icon name="chevron" size={16} class="lib-chev" />
      </button>
    </li>
  );
}

/** Library's rows, or its grid of tiles. */
const libListClass = () => (libraryLayout.value === 'grid' ? 'lib-grid' : 'list lib-list');

/** Liked and Recently played, each once, for Here search on Library's list. */
const libraryTracks = computed(() => {
  const seen = new Set<string>();
  return [...likedShown.value, ...recentShown.value].filter((t) => !seen.has(t.id) && (seen.add(t.id), true));
});

/** Top right: switches Library between rows and a grid of tiles (remembered). */
function LayoutButton() {
  const grid = libraryLayout.value === 'grid';
  return (
    <button class="icon-btn" onClick={() => (libraryLayout.value = grid ? 'list' : 'grid')} aria-label={grid ? 'Show as a list' : 'Show as a grid'} data-testid="lib-layout">
      <Icon name={grid ? 'list' : 'grid'} />
    </button>
  );
}

/** The Library tab: its lists, then the playlists, each opening its own page. */
export function Library() {
  useSearchContext({ label: 'Library', tracks: () => libraryTracks.value });
  return (
    <Screen testid="screen-library" title="Library" subtitle="On this device" scrollKey="library" right={<LayoutButton />}>
      <ul class={libListClass()} aria-label="Library">
        <LibItem art={<ListTile icon="heart" />} title="Liked" sub={<Count of={likedShown} />} onOpen={() => openLibraryPage('liked')} testid="lib-liked" />
        <LibItem art={<ListTile icon="clock" />} title="Recently played" sub={<Count of={recentShown} />} onOpen={() => openLibraryPage('recent')} testid="lib-recent" />
        {localOn.value && <LibItem art={<ListTile icon="folder" />} title="Local" sub={<Count of={localTracks} after=" · on this phone" />} onOpen={() => openLibraryPage('local')} testid="lib-local" />}
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
        <ul class={libListClass()} aria-label="Playlists">
          {all.map((p) => (
            <LibItem
              key={p.id}
              art={<Mosaic tracks={p.tracks} size={libraryLayout.value === 'grid' ? 'lg' : 'sm'} />}
              title={p.name}
              sub={plural(p.tracks.length, 'song')}
              onOpen={() => openUserPlaylist(p.id)}
              testid="lib-playlist"
              nameTestid="lib-playlist-name"
            />
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

/** Album covers in a grid; a tap opens the album. */
function AlbumCards({ albums }: { albums: LocalAlbum[] }) {
  return (
    <ul class="release-grid">
      {albums.map((a) => (
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

const unknownAlbum = (a: LocalAlbum) => a.key === UNKNOWN_ALBUM_KEY;

/** Local's albums: A–Z under letters, or the most songs first; Unknown album last either way. */
function AlbumGrid() {
  const all = localGroups.value.albums;
  return (
    <div data-testid="local-albums">
      {localAlbumsOrder.value === 'az' ? (
        <AZSections items={all} name={(a) => a.title} unknown={unknownAlbum}>
          {(xs) => <AlbumCards albums={xs} />}
        </AZSections>
      ) : (
        <AlbumCards albums={byMostSongs(all, unknownAlbum)} />
      )}
    </div>
  );
}

/** "2 albums · 7 songs", or only the songs when there's no album. */
const artistCounts = (a: LocalArtist) => (a.albums.length ? `${plural(a.albums.length, 'album')} · ${plural(a.songs.length, 'song')}` : plural(a.songs.length, 'song'));

/** Artist rows; a tap opens the artist. */
function ArtistRows({ artists }: { artists: LocalArtist[] }) {
  return (
    <ul class="list lib-list">
      {artists.map((a) => (
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

const unknownArtist = (a: LocalArtist) => a.name === UNKNOWN_ARTIST;

/** Local's artists: A–Z under letters, or the most songs first; Unknown artist last either way. */
function ArtistList() {
  const all = localGroups.value.artists;
  return (
    <div data-testid="local-artists">
      {localArtistsOrder.value === 'az' ? (
        <AZSections items={all} name={(a) => a.name} unknown={unknownArtist}>
          {(xs) => <ArtistRows artists={xs} />}
        </AZSections>
      ) : (
        <ArtistRows artists={byMostSongs(all, unknownArtist)} />
      )}
    </div>
  );
}

/** [items] under A–Z letter heads, as on Genres and Artists (the fast scroller reads them); an Unknown one under "?" at the end. */
function AZSections<T>({ items, name, unknown = () => false, children }: { items: readonly T[]; name: (x: T) => string; unknown?: (x: T) => boolean; children: (xs: T[]) => ComponentChildren }) {
  const rest = items.filter(unknown);
  const sections = [...groupAZ(items.filter((x) => !unknown(x)), name), ...(rest.length ? [{ letter: '?', items: rest }] : [])];
  return (
    <>
      {sections.map((sec) => (
        <section class="az-section" key={sec.letter} data-letter={sec.letter}>
          <AZHead letter={sec.letter} />
          {children(sec.items)}
        </section>
      ))}
    </>
  );
}

/** Local's songs A–Z under letters; a tap plays them all in this order. Rendered in chunks, the rest in idle time (the scroller reaches all of them). */
function SongsAZ({ tracks }: { tracks: Track[] }) {
  const { shown, sentinel, more } = useChunks(tracks.length, 'local:az', undefined, { fill: true });
  const list = useRef(tracks);
  list.current = tracks;
  const play = useCallback((i: number) => void playFrom(list.current, i, LOCAL_CTX), []);
  let at = 0;
  return (
    <div data-testid="local-list">
      <AZSections items={tracks.slice(0, shown)} name={(t) => t.title}>
        {(xs) => {
          const from = at;
          at += xs.length;
          return (
            <ul class="list">
              {xs.map((t, i) => (
                <TrackRow key={t.id} track={t} index={from + i} inLocal onPlay={play} />
              ))}
            </ul>
          );
        }}
      </AZSections>
      {more && <div ref={sentinel} class="list-foot" aria-hidden="true" />}
    </div>
  );
}

const ORDERS = {
  songs: [
    { id: 'newest', label: 'Newest', testid: 'local-order-newest' },
    { id: 'az', label: 'A–Z', testid: 'local-order-az' },
  ],
  groups: [
    { id: 'songs', label: 'Most songs', testid: 'local-order-songs' },
    { id: 'az', label: 'A–Z', testid: 'local-order-az' },
  ],
} as const;

/** How many there are, and the view's order: Newest | A–Z for songs, Most songs | A–Z for albums and artists. */
function OrderRow({ view }: { view: LocalView }) {
  const g = localGroups.value;
  const count = view === 'albums' ? plural(g.albums.length, 'album') : view === 'artists' ? plural(g.artists.length, 'artist') : plural(localTracks.value.length, 'song');
  const order = view === 'songs' ? localSongsOrder : view === 'albums' ? localAlbumsOrder : localArtistsOrder;
  return (
    <div class="local-order">
      <span class="dim small" data-testid="local-count">
        {count}
      </span>
      <Rail<string> items={view === 'songs' ? ORDERS.songs : ORDERS.groups} value={order.value} onChange={(v) => ((order as Signal<string>).value = v)} label="Order" testid="local-order" />
    </div>
  );
}

/** The current view's order is A–Z: its letters and the fast scroller's letter show. */
const localAZ = (view: LocalView) => (view === 'songs' ? localSongsOrder : view === 'albums' ? localAlbumsOrder : localArtistsOrder).value === 'az';

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

/** Local's songs in the chosen order: A–Z (as its letters run) or the newest files first. */
const azLocal = computed(() => groupAZ(localTracks.value, (t) => t.title).flatMap((s) => s.items));
const orderedLocal = computed(() => (localSongsOrder.value === 'newest' ? newestLocal.value : azLocal.value));

/** Library → Local: the songs in the folders chosen in Settings, as songs, albums or artists; + adds a folder, pull down looks again. */
export function LocalPage() {
  const tracks = orderedLocal.value;
  const scan = localScan.value;
  const view = settings.value.localView;
  useSearchContext({ label: 'Local', tracks: () => orderedLocal.value });
  const looking = scan && <p class="local-status" role="status" data-testid="local-status">{`Looking in ${scanningName.value}… ${plural(scan.found, 'song')} so far`}</p>;
  let body;
  if (tracks.length) {
    body = (
      <>
        {looking}
        <PlayShuffle tracks={tracks} ctx={LOCAL_CTX} testid="local" />
        <ViewSwitch />
        <OrderRow view={view} />
        {view === 'albums' ? (
          <AlbumGrid />
        ) : view === 'artists' ? (
          <ArtistList />
        ) : localSongsOrder.value === 'az' ? (
          <SongsAZ tracks={tracks} />
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
      azScroller={tracks.length > 0 && localAZ(view) ? 'beside' : false}
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
