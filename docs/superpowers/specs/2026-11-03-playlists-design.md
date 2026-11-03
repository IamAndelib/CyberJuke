# Playlists (1.5.0): design

Status: approved by the maintainer on 3 Nov 2026, from the playlist concept screens and two polish rounds. Nothing is built yet.
Main at writing: db554ac (1.3.6). This builds on local music (1.4.0, `2026-11-03-local-music-design.md`), which turns Library into a list.

## 1. What we're building, and for whom

People can make their own playlists out of any songs in CyberJuke (Jukebox, MP3s, Global, Signal Radio, local songs), add songs from anywhere, and play, reorder, rename and delete them.

**The maintainer's answers (3 Nov):**
- **Where:** Library as a list. **[New playlist]** and your playlists sit under Liked, Recently played and Local.
- **Adding:**
  - a song's ⋯ menu;
  - a **≡+** button beside the heart in Now Playing;
  - **[Save queue as playlist]** under the Queue heading.
- **Editing:** the ↑ ↓ ✕ buttons Up next already has, reached from the playlist's ⋯ (Edit songs). Removing a song has Undo; deleting a playlist asks first.
- **Cover:** a 2×2 mosaic of the first four different covers.
- **Offline:** playlist songs aren't saved for offline. Only liked songs are, as now.
- **Version:** 1.5.0, after local music.
- **From the polish rounds:**
  - Library's row icons are outlined square tiles (style B), not pictures;
  - ≡+ is drawn on the heart's rows so the two line up;
  - [Save queue as playlist] sits left-aligned under the Queue heading;
  - with no playlists, ≡+ opens New playlist straight away;
  - **Undo after making a playlist from a song removes the song and keeps the playlist.**

**Success means:**
- From Now Playing, two taps put the playing song in a playlist, and one more makes a new one.
- A playlist plays like any list (notification, lock screen, restore after a restart) and survives an app update.
- Nothing about playlists leaves the phone.

## 2. How others do it, and what we follow

- **Add to playlist:** Spotify, YouTube Music, NewPipe, InnerTune/Metrolist and Auxio all offer it from a song's menu. Its sheet starts with **New playlist**, then lists the playlists.
- **Duplicates:** a playlist that already has the song is greyed out or ticked. NewPipe added this after users asked (NewPipe #4783, #9538).
- **The cover:** YouTube Music and InnerTune use a 2×2 mosaic of the first covers.
- **Not followed:**
  - M3U import and export (Auxio): a file list can't describe a streamed song;
  - drag-to-reorder: we reuse Up next's ↑ ↓ ✕ instead of adding a second editing pattern.

## 3. Library

Local music already makes Library a list. Playlists add a section under its rows:

- the heading **> PLAYLISTS**, with **[New playlist]** on its right once there's at least one;
- one row per playlist, newest first: the mosaic, the name, "12 songs", a chevron;
- **with none:** "No playlists yet" / "Make one here, or with ≡+ in the player." / **New playlist** (a button);
- **New playlist from here:** a sheet asks for the name. Create opens the new, empty playlist's page, with no toast.

## 4. A playlist's page

- **The top bar:** Back, the name with "Playlist" under it, and **⋯**.
- **The head:** the mosaic in the album frame, the name, and "Playlist · 12 songs".
- **Play and Shuffle,** then the songs as usual rows. A tap plays the playlist from that song.
- **Playing from it:** Now Playing reads "Playing from Night drive". At the end, Autoplay follows its setting, as after Liked, and local songs are never seeds.
- **The cover mosaic:**
  - the first four different covers, 2×2;
  - with one to three covers, the first fills the frame;
  - with none, an outlined tile with the playlist icon.
- **The ⋯ sheet:** the playlist's mosaic and name, then **Edit songs**, **Rename** and **Delete playlist**.
- **Edit songs:**
  - each row gets ↑ ↓ ✕ (Up next's buttons and sizes), and the top bar shows **[Done]**;
  - ✕ removes a song: "Removed from Night drive [Undo]".
- **Rename:** a sheet with the name. The name is trimmed, at most 60 characters, and can't be empty. Two playlists may share a name.
- **Delete:** it asks first, with no Undo: "Delete Night drive?" / "Its 12 songs stay wherever else they are: Liked, other playlists, the Jukebox." / [Delete playlist].
- **Empty:** "No songs yet" / "Add songs with ≡+ in the player or a song's ⋯ menu."
- **Offline:** songs that can't play dim, as in every list. Local songs and saved liked songs play.
- **Search:** Here searches the playlist while its page shows.

## 5. Adding songs

- **The ⋯ menu** of every song, wherever it is, gains **Add to playlist**, right after Add to queue.
- **Now Playing's ≡+** sits beside the heart. The icon is redrawn to fill the heart's rows (2–9 of 12) and width, so the two share a top and bottom; this was measured equal on screen.
- **The sheet:**
  - "Add to playlist" / "<title> · <artist>";
  - **New playlist** first;
  - then the playlists, the most recently added-to first, each with its mosaic and "12 songs";
  - a playlist that already has the song is ticked, reads "Already in it", and can't be picked.
- **Picking a playlist** adds the song at the end: "Added to Night drive [Undo]". Undo takes it out.
- **With no playlists,** ≡+ (and the menu's Add to playlist) opens **New playlist** straight away, with "With <title>".
- **Making a playlist from a song:**
  - Create makes it with that song in it, and you stay where you were: "Added to Road trip [Undo]";
  - **Undo removes the song and keeps the playlist** (the maintainer's call).
- **[Save queue as playlist]** sits under the Queue heading, left-aligned, above "Repeating the queue." when Repeat is on.
  - It opens New playlist with "With 26 songs".
  - It saves the queue as shown, top to bottom: played, playing, up next (autoplay included), at most the playlist limit.
- **Press feedback:** each new control uses the app's existing styles. Small buttons and links invert, sheet items invert, rows take the faint state layer, and a held choice is tinted (#106).

## 6. Data

- **File:** `cyberjuke/playlists.json`, through `jsonFile` like Liked, so it's written debounced and atomically. It sits under the app's `files/cyberjuke/`, which both backup XMLs already exclude, because a playlist can hold members-only songs.
- **Shape:** `{ version: 1, playlists: [{ id, name, created, updated, tracks: Track[] }] }`.
  - Whole song records are stored, as Liked does, so a playlist plays without the catalog loaded.
  - Old or broken files read as empty; nothing else is lost.
- **Limits:** 1,000 songs per playlist and 200 playlists, to keep the file small. Past either, a toast says so.
- **Members-only songs:** at sign-out they leave every playlist but are kept per account and come back with that account, as liked songs do today (`members-kept`).
- **Local songs:** hidden from a playlist while not in the local list, and kept, as in Liked.
- **Store:** `src/stores/playlists.ts`, with signals and `create`, `add`, `remove`, `move`, `rename` and `remove playlist`; Undo goes through `stores/undo.ts`.
- **Native:** no change. Playlists play through the existing `playAll` with a list context.

## 7. Privacy and docs

- **No new network request and no new permission.**
- **README:** the "Liked tracks and recently played" storage row becomes "Liked tracks, playlists and recently played", with the same rules.
- **Also:** the store description gains one line, and TESTING.md gains a phone check: playlists after an app update and after sign-out and sign-in.

## 8. How it ships (1.5.0, after 1.4.0)

One PR at a time, each merged before the next:
1. **The store and file** (no screens): unit tests for create, add (no duplicates, the limit), remove with Undo, move, rename, delete, the file round trip, and sign-out and sign-in.
2. **Library's Playlists section and a playlist's page:** mosaic, ⋯, Edit, Rename, Delete, and the empty states.
3. **Adding:** the menu item, Now Playing's ≡+ with its redrawn icon, the sheet, New playlist from a song (Undo keeps the playlist), and Save queue as playlist.
4. **Docs,** then a Preview and the release.

## 9. Risks

- **A long playlist file:** 1,000 songs × 200 playlists is far beyond normal use. Writes are debounced, and the file is read once at start.
- **Songs that disappear** (a Jukebox post deleted, a members-only song after sign-out, a local file moved) stay in the file. They play if they still can; otherwise their rows dim like any unplayable row.
- **Moving between phones:** playlists, like Liked, aren't backed up. An export/import file could come later if asked for.
