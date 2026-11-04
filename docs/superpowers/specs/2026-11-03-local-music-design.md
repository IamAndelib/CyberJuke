# Local music (1.4.0): design

Status: approved by the maintainer on 3 Nov 2026, with every recommended option, and updated the same day after the playlist concepts (Library becomes a list). Nothing is built yet.
Main at writing: db554ac (1.3.6).

## 1. What we're building, and for whom

People who keep music files on their phone can play them in CyberJuke, beside the Jukebox, without giving the app access to the rest of their storage.

**The maintainer's three rules:**
1. Local music is a choice in Settings, off by default.
2. Once it's on, Local is a section of the Library.
3. The person chooses which folders the app may read. The app never looks anywhere else on the phone.

**The maintainer's answers (3 Nov):**
- **Liked:** a local song can be liked and joins Liked. It's already on the phone, so it's never downloaded.
- **End of a list:** a local list stops at its last song, like an album, and Repeat loops it. Autoplay never adds Jukebox or Global songs after it.
- **Lyrics:** looked up on LRCLIB as for any song. Only the title, artist and length are sent.
- **Settings:** its own "Local music" card.
- **From the concept screenshots:**
  - Library becomes a list (chosen with the playlist concepts): **Liked**, **Recently played** and **Local** are rows with outlined icon tiles, each opening its own page. Playlists join that list (both shipped in 1.4.0);
  - sorting is a **Title / Artist / Album** switch;
  - local songs in mixed lists carry an **On phone** tag.

**Success means:**
- With two folders chosen, the songs in them, and nothing else, show under Library → Local within a few seconds of the first look, and play from the app, the notification and headphones.
- They play in airplane mode, show their covers (in lists, Now Playing, the notification and the lock screen), and come back after a restart.
- Turning it off leaves no access to any folder and no list of their songs in the app.

## 2. How others do it, and what we follow

- **Folder access through Android's own picker** (Storage Access Framework, `ACTION_OPEN_DOCUMENT_TREE`, with `takePersistableUriPermission`):
  - The app then reads that folder and what's inside it, and nothing else. This is what makes rule 3 true by construction rather than by promise.
  - It needs no storage permission, so there's no manifest change and nothing new on F-Droid.
  - Auxio, a well-known open-source player, moved to it in 4.0: its loader "directly accesses user files rather than unreliable media database". It later brought back Android's music index only as a faster, less reliable option.
- **Limits Android sets** (Android's documentation):
  - on Android 11+, the picker refuses the root of the storage, the root of an SD card, and Download itself; folders inside them are fine;
  - persisted grants are capped at 512 per app (128 before Android 11).
- **Reading folders:**
  - direct `DocumentsContract` child queries, not `DocumentFile`, which re-queries per file (CommonsWare's "listFiles() woe");
  - tags through Android's own `MediaMetadataRetriever`, with no new library. Auxio uses TagLib through JNI; that's a native dependency we don't need for title, artist, album, length and the embedded cover.
- **Playback:** Media3 already reads `content://` (`DefaultDataSource` → `ContentDataSource`) and every format we list (MP3, FLAC, Ogg/Opus, M4A/AAC, WAV).

## 3. Settings → Local music

A new card between Content and Storage.

- **The toggle: "Play music from this phone", "Only from folders you choose."**
  - Turning it on opens the folder picker at once. If the person backs out, it stays on with no folder.
  - Turning it off asks first: "Turn off local music?" / "CyberJuke forgets your folders and its list of their songs. Your files stay as they are." / [Turn off].
    - It releases every folder grant and deletes the song list and covers.
    - Local songs leave the queue.
- **Folder rows** (shown while it's on): a folder icon, the folder's name, and a line that reads one of:
  - "312 songs";
  - "Looking… 37 songs so far";
  - "Can't reach this folder", with **[Choose it again]**, which opens the picker at that folder.
  - **Names:** "Music" on the phone's storage; "SD card › Albums" (the volume's own name) elsewhere.
  - **✕ removes a folder,** with an **Undo** toast:
    - the row and its songs go at once;
    - the grant is released only when the toast ends without Undo, following the existing undo pattern (`stores/undo.ts`).
- **[Add folder]** under the rows.
  - A folder inside one already chosen isn't added: "Already in Music".
  - A folder that contains chosen folders replaces them.

## 4. Library → Local

- **Library is a list** (in place of today's Liked / Recently played switch):
  - rows for **Liked** ("8 songs"), **Recently played** and, while local music is on, **Local** ("19 songs · on this phone");
  - each row has an outlined square tile with its icon (heart, clock, folder), no picture texture, and a chevron;
  - a tap opens that list as its own page, with Back to Library. Liked and Recently played keep today's content; [Clear] sits in Recently played's top bar.
  - **Trade-off until playlists:** with local music off, Library is two rows, one more tap than today's switch. Playlists fill the list (also in 1.4.0).
- **The Local page:**
  - Play and Shuffle, then a **Title / Artist / Album** switch. The choice is remembered in settings (`localSort`).
  - Then the usual rows: cover, title, artist, and the album on the meta line.
  - Songs without tags sort last. They show their file name (without the extension) and "Unknown artist".
- **States:**
  - **No folders:** "No folders yet" / "Choose the folders CyberJuke may play music from. It looks nowhere else." / [Add folder].
  - **The first look:** "Looking in Music… 48 songs so far" over skeleton rows. Songs show as they're found.
  - **Nothing found:** "No music in these folders" / "CyberJuke plays MP3, FLAC, Ogg, Opus, M4A and WAV files." / [Add folder] [Folders].
  - **A folder can't be reached:**
    - a dashed box above the list: "Can't reach "Albums" on the SD card. Its 5 songs are hidden." / [Choose it again];
    - the other folders' songs play as usual.
- **Search:** while Local is showing, Here searches it. Jukebox and Global search never include local songs.
- **Pull down** looks through the folders again.

## 5. Local songs everywhere else

- **The "On phone" tag:** a `tag` on the meta line of local songs in mixed lists: Liked, Recently played, Search results and Up next. It isn't shown in Local itself.
- **Now Playing:**
  - the context reads "Playing from Local";
  - the post line becomes "On this phone · <folder>", with a folder icon, not tappable;
  - the artist name is plain text (no artist page);
  - the ⋯ menu has Add to queue and Like only (no Share, More by, Open post or Open in YouTube).
- **Offline:** local songs never dim, and the offline rules (web `offlineGuard`, native `OfflineNext`) count them as playable.
- **Liked:**
  - a liked local song whose file isn't in the current list (folder removed, card out, local music off) is hidden from Liked but kept, and comes back with the folder, as members-only likes are kept today;
  - local ids never go to the liked saver (`setLikedIds`) or the listening cache.
- **Lyrics:** looked up like any song's. A liked local song's lyrics are kept like a saved liked song's (`keepSaved`). There's no YouTube Music fallback, since there's no video id.
- **Autoplay:** a list started from Local, or a local song started alone, never fills with Jukebox or Global picks. In a mixed list (Liked), local songs are never used as seeds.

## 6. The native side

**A new `JukeLocal` plugin** (`bridge/LocalPlugin.kt`, registered in `MainActivity.java`), with its logic in a new `local/` package. The web side is `src/data/local.ts`, plus a store `src/stores/local.ts`.

| Call | What it does |
|---|---|
| `folders()` | The chosen folders: id, display name, song count, state (`ok`, `scanning`, `gone`) |
| `addFolder({ initial? })` | Opens the picker and returns the added folder, or `inside` / `cancelled` |
| `removeFolder({ id })` | Releases the grant and drops its songs (called when the Undo toast ends) |
| `tracks()` | Every local song: id, title, artist, album, length, folder id, whether it has a cover |
| `scan()` | Starts an incremental look through every folder |
| `setEnabled({ on })` | `false` releases every grant and deletes the list and covers |

A `localChanged` event reports progress and the end of a scan.

- **Ids:** `loc:<first 16 hex of SHA-256 of the document URI>`. They're stable while a file isn't moved or renamed.
- **Security:**
  - the web side only ever sends ids. The player looks up the file in its own list, so neither a page nor another app's media controls can make it open any other file. This is the same pattern as a Jukebox MP3's link (`TrackExtras`, `SessionPolicy`).
  - `SessionPolicy` accepts `loc:` audio ids.
- **Scan:**
  - it walks only the chosen trees, skipping hidden names;
  - it keeps `audio/*`, or the listed extensions when a provider reports `application/octet-stream`;
  - only new or changed files are read again, by size and date;
  - tags are read on a small thread pool (2 threads to start; more only if the Preview measures a need).
  - **Covers:** the embedded picture, else `cover.jpg`, `folder.jpg` or `front.jpg` in the same folder. They're shrunk to 512 px JPEG.
  - **When it runs:** at app start when local music is on (in the background), on pull-down, and after a folder is added.
- **Storage:** `no_backup/local/index.json`, written atomically (temp file plus rename), and `no_backup/local/art/<id>.jpg`. Android never backs up `no_backup/`; both backup XMLs get the same comment line.
- **Covers on screen:**
  - the WebView asks for `/_local/art/<id>.jpg`, which is same-origin, so the CSP's `img-src 'self'` covers it. `ArtWebViewClient` answers it from that folder;
  - the notification and lock screen get the file through `SavedArtBitmapLoader`.
- **Playback** (`cyberjuke://local/<id>`):
  - the resolver maps the id to the document URI;
  - local songs bypass the caches, the saver and `QualityGovernor`;
  - a missing file or a removed card skips to the next song with "Can't find this file. Skipped it.", and never trips YouTube's back-off;
  - `LastSession` stores local entries (version bump); at restore, those no longer in the list are dropped.
- **Logs** name where an error happened and the error's type only, never a file, folder or tag (`src/core/log.ts` rule; the same on the Kotlin side).

## 7. The web side

- **The song record** (`data/model.ts`, `core/guards.ts`):
  - `source: 'local'`, an `album`, and `artworkUrl` as `/_local/art/<id>.jpg` or `''`;
  - `isTrackFull` / `asTrack` accept `loc:` ids with no ytId or mp3;
  - the playability check counts local songs.
- **The contract** (`player/native.ts` ↔ `PlayerShared.kt`): `NativeTrack` gains `local?: true`. The contract comments are updated on both sides together.
- **Test build:** a fake `JukeLocal` in `tests/fixtures/local.ts` (folders, songs, covers). The web player plays `/_local/audio/<id>`, which the fixture serves as silent MP3, as it does for latex.gg.

## 8. Privacy and docs

- **Network:** nothing about local files leaves the phone, except an LRCLIB lookup (title, artist, length) when lyrics are opened, or kept for a liked local song. The README network table's LRCLIB row says so.
- **Storage:** a new README row: the folder list, the song list and covers, in app files Android never backs up, deleted when local music is turned off.
- **Unchanged:** no new permission and no new host. The F-Droid recipe and anti-features stay the same; the store description gains one line.
- **TESTING.md (phone checks):**
  - the picker on Android 7, 12 and 13+;
  - Download's subfolders;
  - an SD card in and out;
  - a 1,000-song first look, timed;
  - playing with the screen off.

## 9. How it ships (1.4.0)

One PR at a time, each merged before the next. The plan has the steps.

1. **Native folders and scan** (no screens).
2. **Local songs play** (contract, player, offline, autoplay, liked, lyrics, art).
3. **The screens** (Settings card, Library → Local, tags, Now Playing, menu), as in the approved concepts.
4. **Docs**, then a Preview, the whole-app review, and the release.

## 10. Risks

- **Scan speed on big libraries:** about 20–50 ms a file, so a first look at 1,000 songs takes roughly 20 s–1 min. It's measured in the Preview; songs show as they're found, and repeat looks read only changes.
- **Odd providers:**
  - some document providers (cloud, USB) report loading lists or wrong types. We check `EXTRA_LOADING` and fall back on extensions;
  - cloud folders aren't a goal; they work if the provider serves the files.
- **Download on Android 11+:** only its subfolders can be chosen. The empty state and TESTING say so.
- **Moved or renamed files** get new ids: they show again as new songs, and a like on the old id hides until the file is back where it was.
