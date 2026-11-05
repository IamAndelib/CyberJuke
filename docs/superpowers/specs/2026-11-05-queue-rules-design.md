# The queue: list, shuffle, repeat and autoplay (1.4.1): design

Status: approved by the maintainer on 5 Nov 2026 ("go ahead with the queue rules"); version 2, below, approved the same day ("approve the doc"): radios, Repeat all, Signal stations and Shuffle the Jukebox.
Main at writing: 0aa6e69 (1.4.0 + #147, #148); version 2 at 02d7ec3 (rules 4 and 3 built: #152, #154).

## 1. Why

The maintainer found the queue hard to predict on the phone (1.4.0):
- turning shuffle on made album songs vanish from Up next, and turning it off brought them back;
- with Repeat all, after the last song, Next seemed to skip songs;
- suggestions showed up at unpredictable times: sometimes 39 at once, sometimes none until the end.

Two investigations on 5 Nov looked into this:
- **Simulation:** a QA agent fuzzed both queues (the web `Queue` and the native `NativeQueue`) thousands of times. It left 22 failing cases in `queue-rules.json` form.
- **Research:** a second agent compared Spotify, YouTube Music, Apple Music, InnerTune, Metrolist, SimpMusic, Auxio, Gramophone, NewPipe and Media3.

Its findings, verified in the code:

| # | What a person sees | Cause | Kind |
|---|---|---|---|
| F1 | Previous twice, then shuffle on: songs still ahead move into Played | shuffle keeps behind every song *ever heard*, wherever it is (`queue.ts` `rebuildOrder`, `QueueOrder.kt` ~329) | bug, both |
| F2 | After a tapped suggestion and Previous, list songs show under Autoplay; "1 of 4" becomes "Single track"; Undo puts a list song back as a suggestion | sections by position: from the first suggestion on, everything counts as one (`sectionsOf`), and a tap moves a suggestion into the list | bug, both |
| F3 | Repeat all started at S3: at the last song Up next is empty, and S1 plays next without showing anywhere | Up next stops at the end (`StateEncoder`, `Queue.upNext`) | design |
| F4 | Suggestions arrive at 5 or fewer left, or 50 at once when the app goes to the background | the `queueLow` rule plus the background reserve (`autoplay.ts`) | design |
| F5 | On the phone, a song whose early load fails disappears from the list (the likely cause of "S4 after the last song" with a private DNS) | `PlaybackService` removes an upcoming item that fails to pre-load | bug, native |
| F6 | A radio with one song queued: Repeat all drops its suggestions | the "more than one list song" check counts queued songs | bug, both |
| F7 | Web player only: Undo while shuffled, then shuffle off, can put a song behind the current one | `restore` uses list order before the next row in play order | bug, web |

## 2. What you play: a list or a radio

Every way of starting music is one of two kinds. The kind is set when it starts; changing a setting halfway doesn't change it.

**A list** has an end, so it has a top to come back to:
- an album, a playlist, Liked, Recently played, an artist, a genre's page;
- Home with a **genre** chosen (Metal, say): the genre's list from the tapped song on, as its own page plays it;
- Home, Most saved, Search or Global with Autoplay off: the feed from the tapped song on, as it shows;
- a Signal Radio station: a list that leads on to the next station (section 4).

**A radio** has no end, so it has no top:
- a song tapped on Home with **All** chosen (Latest or Most saved), in Search or in Global, with Autoplay on: that song, then endless suggestions;
- **Shuffle the Jukebox** (all of it, or one genre): endless random songs, also with Autoplay off. It is one of the app's own features: the shuffle itself goes on, it isn't a suggestion.

## 3. The rules

1. **The list always comes first.** Suggestions play only after a list, shuffle or not. Nothing but ✕ (or sign-out) takes a list song out.
2. **Suggestions come after a list, and never end.**
   - With Autoplay on and Repeat off, they show at the end of Up next, under "Autoplay · similar to …", fetched once the app is idle after the list starts.
   - Scrolling near the bottom loads more, with "Loading more…" as Home's feed shows it. The player also tops up by itself, so it never runs dry while you just listen.
   - New batches always go at the end.
   - With Autoplay off, or Repeat all on, none are shown or added.
3. **Shuffle mixes what hasn't played** (built: #154).
   - What stays behind is exactly what Played shows; everything in Up next, plus list songs before the start, is mixed ahead.
   - The list is mixed first, then the suggestions among themselves. New suggestions while shuffled go at the end, mixed among themselves.
   - Shuffle off restores list order.
4. **Each song keeps its own label** (built: #152). A row's section comes from its own kind (queued by you, list, autoplay), never from its position; a heading shows each time the kind changes; "N of M" counts list songs only; Undo puts a song back as its own kind, in its own place.
5. **Repeat all on a list loops the list, and Up next shows it.**
   - After the list's last song, Up next goes on with the next lap under **"From the top"**: from the first song up to the one before the playing song (approved concept A). Its rows have ↑ ↓ ✕, which act on the list itself, so a move changes every lap from then on; with shuffle on, ✕ only, as everywhere. The first ↑ and the last ↓ are off.
   - With shuffle on, every lap plays the same mixed order (Media3's documented default), and "From the top" shows it.
   - No suggestions while it's on: those waiting come back when Repeat is off (Apple Music hides Autoplay under Repeat).
6. **A radio has no Repeat all.**
   - The repeat button goes Off → Repeat song → Off. The notification, lock screen, headphones and car do the same: a request for Repeat all gives Repeat song, so cycling there still works.
   - Starting a radio while Repeat all is on turns repeat off; Repeat song stays.
   - To loop what a radio found: Save queue as playlist, then play the playlist with Repeat all.
   - This replaces the old exception "a single song's suggestions are its radio, the loop itself". Repeat all now always means one thing: loop the list.
7. **Repeat one** replays the song when it ends, and Next moves on (unchanged).
8. **Shuffle the Jukebox is endless.**
   - Up next shows its songs as one list, "Next from: Jukebox shuffle" (or "Jukebox shuffle · rock"), not as a list plus suggestions.
   - Scrolling near the bottom loads more, as in rule 2; the player tops up by itself too.
   - New songs are random picks from the same pool (the whole Jukebox or the genre) not yet in the queue; once the pool is used up, a fresh shuffle of all of it, never starting with the song just played.
   - It ignores the Autoplay setting. Repeat as on any radio (rule 6).

**Save queue as playlist** (unchanged): with shuffle off, the whole queue in list order (Played, playing, Up next); with shuffle on, the order shown, then the rest. Duplicates dropped, at most 1000 songs. With suggestions, it saves what's in the queue then: suggestions heard more than 50 songs ago are no longer in it (the queue drops them to stay light).

## 4. Signal Radio stations: lists that lead on

Each station is a list of 32-50 songs. When it ends, the next station follows, the way Poweramp's default repeat mode ("Advance Category") plays the next list, and its "Shuffle Songs and Lists" picks a random list with its songs mixed.

| | Shuffle off | Shuffle on |
|---|---|---|
| Repeat off | The station in its listed order, then the next station in the Radio tab's order (YM, then ZM, by frequency); after the last, the first again. | The station's songs mixed, then a random station not played yet, its songs mixed too; once all 16 have played, a new random order of them. |
| Repeat all | Stays on this station: it loops, with "From the top". | Stays on this station, mixed. |
| Repeat song | Repeats the song. | Repeats the song. |

- **Always going:** stations ignore the Autoplay setting (as now) and never end, so suggestions never follow them.
- **Robust in the background:** the next station is queued in full as soon as the current one starts (30-50 songs, an hour or two ahead), so playback goes on when Android closes the app's screen with the phone locked. Up next shows it under "Next from: Signal Radio · <station>".
- **Labels follow the song:** "Playing from", the Radio tab's on-air mark and "N of M" (within its station) change when the next station's first song plays.
- **Repeat all already on** when a station is tapped: it loops that station, as any list.
- **Shuffle turned on or off mid-station:** rule 3, within the queue as it is.
- **Offline:** unsaved songs are dimmed as everywhere, and Next skips to the next saved one, across stations; with none saved, "No carrier", as now.

## 5. Also looked at

- **F5 (native removes an upcoming song that fails to pre-load):** not changed. In Media3 1.11 a pre-loading period's error is held (loading stops) and only thrown once that period becomes the playing one, and `handleIoException` tags every source error with the playing period. So `perVideoFailure` takes its skip-in-place branch; the removal branch doesn't look reachable from a load error, and no failing test shows it. The private-DNS report is more likely F3 (Up next ending at the last song, S1 playing next unseen), which rule 5 makes visible.
- **F6 (a radio with a song queued lost its suggestions under Repeat all):** fixed in #155, which rule 6 makes moot: a radio has no Repeat all. #155 is closed unmerged.

**Sources:**
- YouTube Music: an Autoplay preview always at the end of the queue.
- Apple Music: the Autoplay section below Playing Next, never shuffled with your music, and hidden under repeat.
- Spotify: Autoplay plays similar songs once your music ends.
- Poweramp: Repeat "Advance Category" (its default) and Shuffle "Songs and Lists" ([its FAQ](https://forum.powerampapp.com/kb/en_us/faq/how-to-use-%E2%80%98repeat%E2%80%99-and-%E2%80%98shuffle%E2%80%99-in-poweramp-r4/)).
- Metrolist: "Shuffle playlist or album first", and its similar content fetched at album start.
- InnerTune and Metrolist: refill at 5 or fewer left.
- NewPipe `PlayQueue.append`: new items go at the end.
- Auxio and SimpMusic `BetterShuffleOrder.cloneAndInsert`: added items as one block.
- Media3 `Timeline.getNextWindowIndex`: repeat all goes to the first item.

## 5a. Vibe (after the queue rules)

Autoplay is renamed **Vibe**: the same feature, with wording in Settings and Up next that says what it does (shown as a concept first). One change to how it picks:
- **No repeats within a session.** Today a Jukebox suggestion skips the queue and the last 50 songs heard. Vibe skips every song heard since the current list or radio started, read from Recently played (which keeps up to 1000 songs or 3 days, with when each played; no new store, and it survives a restart). New Cyberspace posts are unheard, so they come up as usual.
- When every match has been heard (a small genre, or offline with a few saved songs), it falls back to skipping the last 50, as today, so it never goes quiet.
- Cost: one filter of at most 1000 entries per refill (about every 20 songs), on the app's side only; the phone's player doesn't change.
- **Not doing:** continuing with Global songs once the Jukebox is used up. Nobody can realistically hear all of it, and it would send Jukebox sessions to YouTube Music, which they never do today.
- A song played from Global keeps continuing with YouTube Music's radio for it, as now.

## 6. How it's built

Each step ships as its own PR:
- the web side (`src/player/queue.ts`, `webPlayer.ts`, `autoplay.ts`, `radio.ts`, `types.ts`, `UpNext.tsx`, `PlayerUI.tsx`, `ui/playAll.ts`, `features/home/Home.tsx`) and the native side (`QueueOrder.kt`, `NativeQueue`, `PlaybackService.kt`, `StateEncoder`, `Stations.kt`, `ModeButtons`) change together;
- the shared spec `tests/spec/queue-rules.json` gets the case first, failing on both runners (Vitest `queueRules.test.ts`, JVM `QueueRulesTest.kt`), then the fix.

Order:
1. **Labels:** rule 4, F2. Done (#152).
2. **Shuffle:** rule 3, F1, F7. Done (#154).
3. **Radios:** rule 6 and section 2: Repeat on a radio (app, notification, other controllers), Home with a genre plays as a list, the single-song exception removed. #155 closed.
4. **Repeat all:** rule 5, F3: "From the top" with ↑ ↓ ✕.
5. **Signal stations:** section 4.
6. **Shuffle the Jukebox:** rule 8.
7. **Suggestions:** rules 1 and 2, F4: from the list's start, appended in order, endless loading in Up next (concept q1), with the button back up to the playing song (concept q2).
8. **Vibe:** section 5a: the rename (wording concept first), then session memory.

Each PR needs:
- `npm run check`;
- the full e2e run, in its own worktree;
- e2e cases for what a person sees;
- green CI (Kotlin is checked there);
- a CHANGELOG line in the plain user tone.

TESTING.md gets phone checks for:
- Repeat all from a mid-list start, with a private DNS on;
- shuffle after Previous;
- the repeat button on a Home song (Off, Repeat song), also from the notification;
- a station played to its end, with the screen locked, shuffle off and on;
- a long session's suggestions.
