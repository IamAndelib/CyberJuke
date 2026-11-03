# Local music 1.4.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Songs in folders the person chooses play in CyberJuke under Library → Local, beside the Jukebox, with nothing else on the phone readable by the app.

**Architecture:**
- **Native owns the folders, the scan and the song list.** It uses Android's folder picker with persisted read grants, `DocumentsContract` queries and `MediaMetadataRetriever` tags, and keeps an index plus covers in `no_backup/local/`.
- **The web side sees ids and tags only.** The player resolves `loc:` ids to files from native's own index.
- **The screens** are the approved concepts.

**Tech Stack:**
- Web: Preact 11 + @preact/signals, Vitest, Playwright.
- Android: Kotlin, Media3 1.11.1, Capacitor 8.

**Spec:** `docs/superpowers/specs/2026-11-03-local-music-design.md` (approved 3 Nov 2026, every recommended option).

## Global Constraints

- **Delivery:** one PR at a time from a `claude/*` branch off the latest `origin/main`, merged before the next starts. Each PR has CI green on all 8 checks.
- **CHANGELOG:** a `[Unreleased]` line for every user-visible change (PR 3 onwards; PRs 1–2 change nothing visible).
- **Commits:**
  - the subject is `Area: what changed`, under 72 characters, and the body says why;
  - the usual trailers;
  - `npm run check` passes on every commit.
- **Tests:**
  - pure Kotlin rules get JVM tests (`android/app/src/test/`);
  - web logic gets Vitest units; flows get Playwright e2e on the test build with the fake `JukeLocal`.
  - Kotlin is verified by CI (`testDebugUnitTest`, the emulator smoke test).
- **Invariants:**
  - no new permission and no new host;
  - logs never carry file, folder or tag text;
  - the backup XMLs stay in sync;
  - "YouTube Music" never appears in UI text.

## Review Focus

- **Rule 3 holds:** only `ACTION_OPEN_DOCUMENT_TREE` grants are read; nothing queries MediaStore or walks storage paths.
- **The web side can't name a file:** every native entry point takes a `loc:` id and looks it up in native's own index.
- **Turning off leaves nothing behind:** no persisted grants (`getPersistedUriPermissions()` is empty), no `no_backup/local/`, and no local songs in the queue.
- **Local songs never reach** the caches, the saver, `QualityGovernor` or YouTube's back-off.

## PR 1: Native folders and scan (`claude/local-scan`, no screens)

### Task 1.1: Pure rules (`local/LocalRules.kt`) with JVM tests
- [ ] **Overlapping folders:** `relation(newTreeDocId, existing)` gives `INSIDE`, `CONTAINS` (the ids it replaces) or `NONE`. It goes by the provider authority plus the document-id path prefix (`primary:Music` vs `primary:Music/Rock`).
- [ ] **What a file is:** `isAudio(mime, name)` accepts `audio/*`, or `application/octet-stream` with one of `.mp3 .flac .ogg .oga .opus .m4a .aac .wav`. Hidden names (a leading `.`) are skipped.
- [ ] **What to read again:** `needsRead(old, size, modified)`.
- [ ] **Ids:** `idOf(documentUri)` is `loc:` plus the first 16 hex of SHA-256.
- [ ] **Shown tags:**
  - with no title, the file name without its extension;
  - with no artist, "Unknown artist".
- [ ] **Covers:** the picks in order are embedded, then `cover.jpg`, `folder.jpg`, `front.jpg` (case-insensitive).
- [ ] Tests cover each rule, including a nested folder added before and after its parent.

### Task 1.2: Index and covers (`local/LocalIndex.kt`)
- [ ] An in-memory `Map<id, Entry>` (folder id, document URI, title, artist, album, length, size, modified, cover yes/no).
- [ ] Load and save `no_backup/local/index.json` atomically (temp file plus rename).
- [ ] Covers in `no_backup/local/art/<id>.jpg`.
- [ ] `clear()` deletes both.
- [ ] A JVM test for the JSON round trip, and for an old or corrupt file read as empty.

### Task 1.3: Scanner (`local/LocalScanner.kt`)
- [ ] A recursive `DocumentsContract.buildChildDocumentsUriUsingTree` query, with the projection id, name, MIME type, size and last-modified.
- [ ] A provider's `EXTRA_LOADING` is retried once after a short wait.
- [ ] Tags come from `MediaMetadataRetriever.setDataSource(context, uri)` (title, artist, album, duration, `getEmbeddedPicture`) on a 2-thread executor.
- [ ] Covers are decoded with `inSampleSize` to at most 512 px and written at JPEG quality 85.
- [ ] Removed files leave the index.
- [ ] Progress is reported per folder.
- [ ] Cancellable: `setEnabled(false)` and `removeFolder` stop a running scan first.
- [ ] Errors are logged as type only.

### Task 1.4: Plugin (`bridge/LocalPlugin.kt`, `MainActivity.java`)
- [ ] `addFolder`:
  - `startActivityForResult` with `ACTION_OPEN_DOCUMENT_TREE` (with `EXTRA_INITIAL_URI` when re-choosing) and an `@ActivityCallback`;
  - `takePersistableUriPermission(READ)`;
  - the `relation` rule (`inside` is refused; `contains` releases the inner folders' grants);
  - then a scan.
- [ ] `folders`:
  - **Names:** the tree's display name, plus the volume's description from `StorageManager` when it isn't the primary storage ("SD card › Albums").
  - **State:** `gone` when the grant is missing or a query throws.
- [ ] `removeFolder`, `tracks`, `scan` and `setEnabled`, plus the `localChanged` event.
- [ ] Register the plugin, and add a row to the CLAUDE.md plugin table.

### Task 1.5: Web data layer
- [ ] `src/data/local.ts`: the typed plugin wrapper, and a fake in the test build (`tests/fixtures/local.ts`: two folders, about 20 songs with and without tags, covers at `/_local/art/`, silent audio at `/_local/audio/`).
- [ ] Vitest for parsing native's answers (`core/guards.ts`).
- [ ] **Gates:** check, e2e (unchanged), CI.

## PR 2: Local songs play (`claude/local-play`, web + native together)

### Task 2.1: The song record
- [ ] `model.ts` gains `source: 'local'`.
- [ ] `guards.ts` adds `local` to `ORIGINS`, and `isTrackFull` / `asTrack` accept `loc:` with no ytId or mp3.
- [ ] `playable()` counts local songs.
- [ ] **Unit tests first:** a liked local song survives a reload of `liked.json`; a malformed `loc:` id is rejected.

### Task 2.2: The contract and player
- [ ] **Contract:** `native.ts` and `PlayerShared.kt` get `NativeTrack.local`, and `toMediaItem` maps it to `cyberjuke://local/<id>`.
- [ ] **Player:**
  - the resolver (`YtDataSpecResolver` / `CacheRouter`) maps it to the index's document URI, with no cache;
  - `SessionPolicy` accepts `loc:`;
  - `JukeExtractors` keeps the defaults for it.
- [ ] **Errors:** a `FileNotFoundException` or `SecurityException` skips with "Can't find this file. Skipped it." (`TrackErrorPolicy`, `JukeLoadErrorPolicy`). It's never NetBlock and never IPv4.
- [ ] **Kept out:** `QualityGovernor`, `LikedSaver`, `setLikedIds` (both sides filter `loc:`) and the listening cache.
- [ ] **`LastSession`:** a version bump with local entries, which are dropped at restore when they're no longer in the index.
- [ ] **JVM tests:** session round trip and restore, the error decision, and the URI mapping.

### Task 2.3: Offline, autoplay, lyrics, art
- [ ] **Offline:**
  - web `isSaved` / `offlineGuard` and native `OfflineNext` count local ids as playable;
  - unit and JVM tests: offline Next lands on a local song.
- [ ] **Autoplay:**
  - no fill when the list's context is Local or the playing song is local, and local songs are never seeds;
  - `autoplay.test.ts`: a Local list never gets Jukebox picks, and Liked with local songs seeds from the Jukebox ones only.
- [ ] **Lyrics:** an LRCLIB-only lookup for `loc:`, and `keepSaved` includes liked local songs (`lyrics.test.ts`).
- [ ] **Covers:**
  - `ArtWebViewClient` serves `/_local/art/<id>.jpg`;
  - `SavedArtBitmapLoader` gives the same file to the notification.
- [ ] **e2e** (fake library, played through a test hook since the screens come in PR 3): plays, goes to Next and back, restores after a reload, and plays offline.

## PR 3: The screens (`claude/local-screens`), as the approved concepts

### Task 3.1: Store
- [ ] `src/stores/local.ts`:
  - signals `localOn` (a setting), `folders`, `localTracks`, `scanning`;
  - the settings `localMusic` and `localSort`;
  - removal with Undo following `stores/undo.ts`;
  - on start, when on, read `tracks()` then `scan()`.
- [ ] `likedShown` hides liked local songs that aren't in `localTracks`.

### Task 3.2: Settings → Local music
- [ ] The card between Content and Storage: the toggle, folder rows (count, "Looking…", "Can't reach this folder" with [Choose it again]), ✕ with Undo, [Add folder].
- [ ] Turning it on opens the picker; turning it off asks first.
- [ ] The toasts "Already in Music" and "Removed Music [Undo]".
- [ ] A pixel `folder` icon in `ui/icons.tsx`.

### Task 3.3: Library as a list, and the Local page
- [ ] Library's root is a list: Liked, Recently played and (while on) Local as rows with outlined icon tiles (`ui/icons.tsx` gains `clock` and `folder`) and a chevron.
- [ ] Each row pushes its page on Library's stack (`nav.ts` page kinds `liked`, `recent`, `local`); Back returns. `openLiked()` opens the Liked page.
- [ ] e2e that open Liked or Recently played through the old switch (`lib-liked`, `lib-recent`) open them through the rows instead: same intent, named in the PR.
- [ ] Play/Shuffle, the Title/Artist/Album switch (remembered), and the rows with the album on the meta line; untagged songs go last.
- [ ] The empty, first-look, nothing-found and unreachable states.
- [ ] Here search on Local, and pull down to look again.

### Task 3.4: Everywhere else
- [ ] The "On phone" tag on local rows outside Local (`TrackRow`).
- [ ] **Now Playing:**
  - "On this phone · <folder>" with the folder icon;
  - a plain artist name;
  - a menu without Share, More by, Open post or Open in YouTube.
- [ ] The offline dim never applies to local rows.

### Task 3.5: Tests and words
- [ ] **e2e:**
  - on with the picker faked, adding a folder, adding a nested folder ("Already in…");
  - sort, search, play;
  - removing with Undo, and without;
  - an unreachable folder;
  - turning it off (the list, Local and local queue entries go);
  - offline play;
  - the tag in Liked.
  - Fits at 320 and 360 px in all 8 themes (`npm run screenshots`).
- [ ] **CHANGELOG:** "Play music from folders on your phone: turn on Settings → Local music and choose the folders. CyberJuke reads those and nothing else; the songs show under Library → Local, play offline, and can be liked."

## PR 4: Docs (`claude/local-docs`)
- [ ] **README:** a feature line, a storage row, and the LRCLIB network row mentioning local songs.
- [ ] **The store description:** one line, keeping under 4,000 characters.
- [ ] **TESTING.md:** the phone checks from the spec (§8).
- [ ] **Both backup XMLs:** the comment line for `no_backup/local/`.

## Then
- A Preview for the maintainer's phone, with the TESTING checks and the first-look timing on a real library.
- The whole-app review (`release-review` skill), fixes, then release 1.4.0 and the F-Droid recipe.
