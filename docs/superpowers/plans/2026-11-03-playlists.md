# Playlists 1.5.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People make their own playlists from any songs in CyberJuke, add to them from a song's menu, Now Playing and the queue, and play, reorder, rename and delete them.

**Architecture:**
- **Web only.** A `stores/playlists.ts` store holds the playlists in `cyberjuke/playlists.json`, as Liked does.
- **Screens:** a Playlists section on 1.4.0's Library list, a pushed playlist page, and one sheet for picking and naming.
- **No native change:** a playlist plays through `playAll` with a list context.

**Tech Stack:** Preact 11 + @preact/signals, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-03-playlists-design.md` (approved 3 Nov 2026).

**Depends on:** local music 1.4.0 (Library as a list, the `clock`/`folder` icons, outlined tiles). It starts after 1.4.0 is released.

## Global Constraints

- **Delivery:** one PR at a time from a `claude/*` branch off the latest `origin/main`, merged before the next. Each PR has CI green on all 8 checks.
- **CHANGELOG:** a `[Unreleased]` line for every user-visible change.
- **Commits:**
  - the subject is `Area: what changed`, under 72 characters, and the body says why;
  - the usual trailers;
  - `npm run check` passes on every commit.
- **Tests:**
  - every bug fix has a test that fails first;
  - flows get Playwright e2e on the test build;
  - every new screen is checked at 320 and 360 px in all 8 themes (`npm run screenshots`).
- **Invariants:**
  - layer rules: the store in `stores/`, screens in `features/library/`, shared pieces in `ui/`;
  - no new host and no new permission;
  - "YouTube Music" never appears in UI text.

## Review Focus

- **Undo does exactly one thing:**
  - after adding a song, Undo removes that song;
  - after making a playlist from a song, Undo removes the song and the playlist stays.
- **Duplicates can't happen,** whichever path adds the song.
- **Members-only songs** leave playlists at sign-out and come back with that account. Nothing members-only stays visible while signed out.
- **The file:** a broken or old file reads as empty without touching Liked or history.

## PR 1: The store (`claude/playlists-store`, no screens)

### Task 1.1: `src/stores/playlists.ts`
- [ ] **State:**
  - `playlists` signal: `Playlist { id, name, created, updated, tracks: Track[] }`;
  - `playlistsShown` (local songs not in the list and members-only songs while signed out hidden, as `likedShown`).
- [ ] **Operations:**
  - `create(name, tracks?)` returns the id;
  - `add(id, track)` returns `'added' | 'already' | 'full'`;
  - `remove(id, index)`, `move(id, from, to)`, `rename(id, name)`, `removePlaylist(id)`.
  - Names are trimmed, at most 60 characters, never empty.
  - Limits: 1,000 songs a playlist, 200 playlists.
- [ ] **The file:** `jsonFile('data', 'playlists', parse)`, debounced writes; `{ version: 1, playlists }`; anything else reads as empty.
- [ ] **Sign-out and sign-in:** members-only songs move to the account's kept file and come back on that account's sign-in, as `members-kept` does for Liked.
- [ ] **Unit tests (`playlists.test.ts`):**
  - create;
  - add twice gives `'already'`; the limit gives `'full'`;
  - remove, then Undo through `stores/undo.ts`;
  - move, rename (trim, 60 characters, empty refused), delete;
  - the file round trip, and a broken file read as empty;
  - sign-out and sign-in.

### Task 1.2: Undo helpers (`stores/undo.ts`)
- [ ] `addToPlaylistWithUndo(id, track)` toasts "Added to <name>", and Undo removes that song.
- [ ] `createWithSongWithUndo(name, track)` toasts "Added to <name>", and Undo removes the song but keeps the playlist.
- [ ] `removeFromPlaylistWithUndo(id, index)` toasts "Removed from <name>", and Undo puts it back where it was.
- [ ] Unit tests for each Undo.

## PR 2: Library's Playlists section and a playlist's page (`claude/playlists-screens`)

### Task 2.1: Shared pieces (`ui/`)
- [ ] `Mosaic({ tracks, size })`:
  - the first four different covers, 2×2;
  - with one to three, the first fills; with none, an outlined `playlist` tile;
  - it reuses `ArtFrame` and the art treatment.
- [ ] Icons: `playlist`, `playlistAdd` (rows 2–9, cols 1–10, matching the heart), `check`, `chevron`.

### Task 2.2: Library
- [ ] Under the rows:
  - the **> PLAYLISTS** head, with [New playlist] once there's one;
  - playlist rows (mosaic, name, count, chevron), newest first;
  - the empty state "No playlists yet" / "Make one here, or with ≡+ in the player." / New playlist.
- [ ] **New playlist from Library:** the name sheet, then Create opens the playlist's page.

### Task 2.3: The playlist's page (a `nav.ts` page kind `userPlaylist`; the existing `playlist` kind is Global's)
- [ ] The head (mosaic, name, "Playlist · N songs"), Play/Shuffle, rows, and the context `list(name)`.
- [ ] The ⋯ sheet with Edit songs, Rename and Delete playlist.
- [ ] Edit mode: ↑ ↓ ✕ (Up next's buttons) and [Done]; ✕ with Undo.
- [ ] Rename sheet, and the Delete confirm with the spec's wording.
- [ ] The empty state, the offline dim (as any list), and Here search on the page.
- [ ] **e2e:**
  - make, rename, delete;
  - edit: move up and down, remove with Undo;
  - play from a row ("Playing from <name>");
  - the empty states;
  - a restart keeps everything.

## PR 3: Adding (`claude/playlists-add`)

### Task 3.1: The sheet
- [ ] "Add to playlist" / "<title> · <artist>":
  - New playlist first;
  - then the playlists by most recently added-to;
  - "Already in it", ticked and off, for one that has the song.
- [ ] Picking runs `addToPlaylistWithUndo`.
- [ ] **New playlist from the sheet:** "With <title>" and Create run `createWithSongWithUndo`, and the person stays where they were.

### Task 3.2: Entry points
- [ ] The song ⋯ menu gains "Add to playlist" after Add to queue.
- [ ] Now Playing's ≡+ sits beside the heart; with no playlists it opens New playlist at once.
- [ ] **[Save queue as playlist]:**
  - under the Queue heading, left-aligned, above the repeat line;
  - New playlist with "With N songs";
  - it saves the queue as shown (played, playing, up next), up to the limit.
- [ ] **e2e:**
  - add from a row's menu and from Now Playing;
  - "Already in it";
  - New playlist from a song, with Undo keeping it empty;
  - with no playlists, ≡+ opens New playlist;
  - Save queue as playlist with shuffle and repeat on;
  - ≡+ and ♥ share top and bottom (bounding boxes of their drawn pixels).
- [ ] **CHANGELOG:** "Playlists: make your own from any songs, Jukebox, Global, Radio or your own files, with Add to playlist in a song's ⋯ menu, ≡+ in the player, or Save queue as playlist. Find them in Library."

## PR 4: Docs (`claude/playlists-docs`)
- [ ] **README:** the storage row becomes "Liked tracks, playlists and recently played", plus a feature line.
- [ ] **The store description:** one line, under 4,000 characters.
- [ ] **TESTING.md:** playlists after an app update; sign-out and sign-in with a members-only song in a playlist.

## Then
- A Preview for the maintainer's phone.
- The whole-app review, then release 1.5.0 and the F-Droid recipe.
