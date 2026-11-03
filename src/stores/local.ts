/**
 * Local music (Settings → Local music, Library → Local): the chosen folders, their songs and the
 * look through them, as the JukeLocal plugin reports them (data/local). Native owns the files and
 * the grants; this keeps what the screens show, and turns the person's taps into plugin calls.
 */
import { computed, signal } from '@preact/signals';
import { isLocal, type Track } from '../data/model';
import {
  addLocalFolder,
  disableLocal,
  localAvailable,
  localFolders as readFolders,
  localSongs as readSongs,
  onLocalChanged,
  removeLocalFolder,
  scanLocal,
  songToTrack,
  type LocalFolder,
  type LocalSong,
} from '../data/local';
import { logError } from '../core/log';
import { stillPlays } from '../core/offlineText';
import { savedLiked } from './savedOffline';
import { localHere, settings, updateSettings } from './library';
import { byName, groupLocal } from '../data/localGroups';
import { toast } from './toast';

const folders = signal<LocalFolder[]>([]);
const songs = signal<LocalSong[]>([]);
/** Folders removed while their Undo shows: hidden now, given back once the toast goes. */
const removing = signal<ReadonlySet<string>>(new Set());
/** The folder being looked through, and the songs found in it so far. */
export const localScan = signal<{ folder: string; found: number } | null>(null);
/** The first read of the list (after start-up or turning on) hasn't come back yet. */
export const localLoading = signal(false);

/** Local music is on, in a build that has it. */
export const localOn = computed(() => settings.value.localMusic && localAvailable());
/** The folders Settings shows. */
export const localFolderList = computed(() => folders.value.filter((f) => !removing.value.has(f.id)));
/** The folders that can't be read right now (no access any more, card out). */
export const unreachableFolders = computed(() => localFolderList.value.filter((f) => f.state === 'gone'));

/** The songs Local shows: those of folders still chosen and in reach. */
const shownSongs = computed(() => {
  const ok = new Set(localFolderList.value.filter((f) => f.state !== 'gone').map((f) => f.id));
  return songs.value.filter((s) => ok.has(s.folder));
});
export const localTracks = computed<Track[]>(() => shownSongs.value.map(songToTrack));
/** What still plays offline, as the offline line and toast name it: Jukebox liked songs saved on the phone, local songs, both, or null. */
export const offlinePlays = computed(() => stillPlays(savedLiked.value.some((t) => !isLocal(t)), localTracks.value.length > 0));
/** Which folder each local song is in, by name, for Now Playing ("On this phone · Music"). */
const folderNames = computed(() => {
  const names = new Map(folders.value.map((f) => [f.id, f.name]));
  return new Map(songs.value.map((s) => [s.id, names.get(s.folder) ?? '']));
});
export const localFolderOf = (id: string): string => folderNames.value.get(id) ?? '';
/** The name of the folder being looked through. */
export const scanningName = computed(() => {
  const s = localScan.value;
  return s ? (folders.value.find((f) => f.id === s.folder)?.name ?? '') : '';
});

/** Local's songs, the newest files first (then by title). */
export const newestLocal = computed(() => tracksOf([...shownSongs.value].sort((a, b) => b.modified - a.modified || byName(a.title, b.title))));

/** Local's albums and artists (data/localGroups). */
export const localGroups = computed(() => groupLocal(shownSongs.value));

/** The local songs as tracks, by id (for an album's or an artist's list). */
const trackById = computed(() => new Map(localTracks.value.map((t) => [t.id, t])));
export const tracksOf = (songs: readonly LocalSong[]): Track[] => songs.map((s) => trackById.value.get(s.id)).filter((t): t is Track => !!t);

/** Reads the folders and songs again from the plugin. */
async function refresh(): Promise<void> {
  try {
    const [f, s] = await Promise.all([readFolders(), readSongs()]);
    if (!settings.peek().localMusic) return;
    folders.value = f;
    songs.value = s;
  } catch (e) {
    logError('localRefresh', e);
  } finally {
    localLoading.value = false;
  }
}

/** Looks through every folder again (Local's pull down, start-up). */
export async function lookAgain(): Promise<void> {
  try {
    await scanLocal();
  } catch (e) {
    logError('localScan', e);
  }
}

/**
 * Asks Android's picker for a folder (at [again], one that can't be reached, to choose it
 * again). A folder inside one already chosen isn't added: "Already in Music".
 */
export async function addFolder(again?: string): Promise<void> {
  try {
    const r = await addLocalFolder(again);
    if (r.result === 'inside') toast(`Already in ${r.name}`);
    if (r.result === 'added') await refresh();
  } catch (e) {
    logError('localAddFolder', e);
    toast("Couldn't add that folder");
  }
}

/** ✕ on a folder: it and its songs go at once, with Undo; its access is given back once the toast goes. */
export function removeFolder(f: LocalFolder): void {
  removing.value = new Set([...removing.peek(), f.id]);
  const keep = () => {
    const next = new Set(removing.peek());
    next.delete(f.id);
    removing.value = next;
  };
  toast(`Removed ${f.name}`, undefined, {
    label: 'Undo',
    run: keep,
    done: () => {
      removeLocalFolder(f.id)
        .catch((e) => logError('localRemoveFolder', e))
        .finally(() => {
          folders.value = folders.peek().filter((x) => x.id !== f.id);
          songs.value = songs.peek().filter((s) => s.folder !== f.id);
          keep();
        });
    },
  });
}

/** The toggle on: the picker opens at once (backing out leaves it on, with no folder). */
export async function turnOn(): Promise<void> {
  updateSettings({ localMusic: true });
  await addFolder();
}

/** The toggle off (after asking): every folder's access given back, the list and covers deleted. */
export async function turnOff(): Promise<void> {
  updateSettings({ localMusic: false });
  folders.value = [];
  songs.value = [];
  removing.value = new Set();
  localScan.value = null;
  try {
    await disableLocal();
  } catch (e) {
    logError('localOff', e);
  }
}

let started = false;

/** Follows the plugin from start-up on; while on, reads the list and looks through the folders once. */
export function startLocal(): void {
  if (started || !localAvailable()) return;
  started = true;
  // Liked hides the liked local songs that aren't on the phone now.
  shownSongs.subscribe((s) => (localHere.value = new Set(s.map((x) => x.id))));
  void onLocalChanged((e) => {
    localScan.value = e.done || !e.scanning ? null : { folder: e.scanning, found: e.found };
    // A folder done (the next one starts at 0) or all of them: its songs show.
    if (e.done || e.found === 0) void refresh();
  });
  if (!settings.peek().localMusic) return;
  localLoading.value = true;
  void refresh().then(lookAgain);
}

