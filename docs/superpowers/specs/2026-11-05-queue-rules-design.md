# The queue: list, shuffle, repeat and autoplay (1.4.1): design

Status: approved by the maintainer on 5 Nov 2026 ("go ahead with the queue rules"); version 2 approved the same day ("approve the doc"); version 3, below, the same day: everything is a list, and some lists lead on to the next: radios, Repeat all, Signal stations and Shuffle the Jukebox.
Main at writing: 0aa6e69 (1.4.0 + #147, #148); version 2 at 02d7ec3 (rules 4 and 3 built: #152, #154).
Version 4 (6 Nov, main 66bc36c; the maintainer delegated every remaining decision): a simulation of 14.6 million steps over every list kind, Repeat, Shuffle and action (`scratchpad/sim-report`, findings S1-S15, wording A1-A5, design gaps D1-D18) checked the rules against both queues. Every rule held where the code follows it; where the wording was unclear it is made exact below, and the ideal model the rules imply is `2026-11-06-queue-architecture.md`.

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

## 2. Everything is a list

Nothing in the queue is endless any more. Everything you play is a list, and some lists lead on to the next one:

| You play | The list | When it ends (Repeat off) |
|---|---|---|
| An album, a playlist, Liked, Recently played, an artist, a genre's page | its songs | a Vibe follows (with Vibe on), else it stops |
| A song tapped on Home (All or a genre, Latest or Most saved), in Search or in Global | a **Vibe batch**: the tapped song and 24 like it | the next Vibe batch |
| The same with Vibe off | the feed from the tapped song on, as it shows | it stops |
| Shuffle the Jukebox (all, or one genre) | a batch of 25 random songs from its pool | the next random batch, whatever the Vibe setting |
| A Signal Radio station | its 32-50 songs | the next station (section 4), whatever the Vibe setting |

Home and Search start a Vibe; the Genres, Artists and album pages play their lists.

## 3. The rules

1. **The list comes first.** A Vibe plays only after a list, shuffle or not. Nothing but ✕ (or sign-out) takes a list song out.
2. **The current list and what's on the way.**
   - Up next shows the rest of the current list. Below it, under **"On the way"**, the next list (a Vibe batch, a Jukebox shuffle batch, the next station) fills Up next to 25 rows: as songs finish, one more shows (D1: a function of what's ahead, not a counter).
   - "On the way" rows look like any row but have no ↑ ↓ ✕, and the current list's last row has ↓ off, so nothing crosses the line (S7, D15). A tap on one starts that list from it; the current list's songs it jumped over that you haven't heard play right after it, at the new list's start, shuffle or not (they join the new list, so "N of M" counts them); heard ones stay in Played (A2, D3).
   - With shuffle on, the next list is mixed when it arrives (and again at each shuffle toggle), so "On the way" shows the order it will play (D2).
   - A batch never repeats a song already in the queue (D8). Vibe turned on again mid-list fetches the next batch at once (D6).
   - The next list is fetched in full as soon as the current one starts, so the player always has it: for gapless and crossfade, on a slow connection, and when Android closes the app's screen with the phone locked (the app's side picks Jukebox songs). Nothing loads because you scrolled.
   - With Vibe off, a list that ends has nothing on the way.
3. **Shuffle, reorder, ✕ and Save act on the current list.**
   - Shuffle on mixes what hasn't played of the current list; what Played shows, songs from earlier lists, and songs you walked back over with Previous stay where they are (S1, D5).
   - **Turning shuffle off never skips a song, in every list:** every song of the current list not yet heard stays ahead, in list order; Played keeps what you heard, as you heard it. (Before, an album went back to list order from the playing song's place, as Spotify does, and the unheard songs before it only came round with Repeat all.)
   - This is only about turning shuffle off. A list started mid-way (song 3 of an album tapped) still starts there, as everywhere: songs 1-2 come round with Repeat all, under "From the top".
   - [Save queue as playlist] saves the current list: what you heard of it, the playing song (also after Previous into the list before: S3) and the rest of it, plus the songs you queued (rule 8). For an album, the album; for a Vibe batch, its 25 songs (D7). Duplicates dropped, at most 1000 songs.
4. **Each song keeps its own label** (built: #152). A row's section comes from its own kind, never from its position; a heading shows each time the kind changes; "N of M" counts the current list's songs, a radio's first batch included and the songs you queued not (A3, S12); Undo puts a song back as its own kind, in its own place.
5. **Repeat all loops the current list**: an album, a Vibe batch, a Jukebox shuffle batch, a station.
   - After its last song, Up next goes on under **"From the top"** with the next lap, from the first song up to the one before the playing song (approved concept A). Its rows have ↑ ↓ ✕, which act on the list itself; with shuffle on, ✕ only. The first ↑ and the last ↓ are off. Songs you queued are never in it (rule 8).
   - Played stays as it is: opened, it shows what you heard, so a song can show both there and under "From the top"; ↑ ↓ ✕ in either acts on the same song. "N up next" counts to the end of the list, not the next lap.
   - With shuffle on, every lap plays the same mixed order, and "From the top" shows it.
   - Nothing is on the way while it's on.
   - Media3 loops its whole queue, not part of it, so while Repeat all is on the player holds only the current list and the songs you queued: songs heard from earlier lists leave the queue (they stay in Recently played, and don't come back to Played when Repeat is off), and what was on the way goes; when Repeat is off, the next list is fetched afresh (for a station, the same next station; for a Vibe, a new batch). Jumping back at the end instead would fight gapless and crossfade.
   - So with Repeat all on, Previous on the list's first song goes to its last song, as on any player: the list is a loop. Played shows only this list's songs meanwhile.
   - Songs from earlier lists leave the queue, heard or not (A5). One that is playing when Repeat all turns on (you went back with Previous) plays out, then leaves once another song plays (S4).
   - The loop starts at the lap's first song: never at a song you queued and heard (S5).
   - This replaces version 2's "a radio has no Repeat all" and the old single-song exception: Repeat all means one thing everywhere.
6. **Repeat one** replays the song when it ends, and Next moves on (unchanged).
7. **Previous goes to the song before** (what you heard; in a list started mid-way, the song before it in the list, as every player does: A1), across lists: from the first song of a new batch, Previous plays the last song heard of the batch before, and Next comes back to the new batch where you were. The list ahead stays the current list; an earlier one never becomes current again.
8. **Songs you queue belong to no list** ("Add to queue", "Queued by you"), the same for every kind of list (Spotify's and Apple Music's queue).
   - They play next, in the order you added them; shuffle never mixes them, so their ↑ ↓ show with shuffle on too.
   - Each keeps its mark after it plays. It stays where it played: in Played, with ↑ ↓ ✕ and Undo, and Previous goes back to it.
   - **Repeat all never brings one back:** "From the top" leaves it out, and when the list loops (its last song ends and its first starts again) it leaves the queue. Going back past it yourself (Previous, a tap on an earlier song) and playing on plays it again where it was, with Repeat on or off: you're walking through what you heard.
   - **Save** saves them with the current list, where they played or will play (A4): the ones still to come, the ones heard in this list, and the ones heard in earlier lists of the same chain (Vibe batches, stations), also those that left the player with Repeat all; the phone's player keeps that memory with its session, so it survives Android closing the app's screen. Starting something new yourself (once it starts: a tap refused offline changes nothing) (a tap on another album, playlist or song) starts over: songs you queued and heard before it aren't saved; the ones still to come are.

## 4. Signal Radio stations: lists that lead on

Each station is a list of 32-50 songs. When it ends, the next station follows, the way Poweramp's default repeat mode ("Advance Category") plays the next list, and its "Shuffle Songs and Lists" picks a random list with its songs mixed.

| | Shuffle off | Shuffle on |
|---|---|---|
| Repeat off | The station in its listed order, then the next station in the Radio tab's order (YM, then ZM, by frequency); after the last, the first again. | The station's songs mixed, then a random station not played yet, its songs mixed too; once all 16 have played, a new random order of them. |
| Repeat all | Stays on this station: it loops, with "From the top". | Stays on this station, mixed. |
| Repeat song | Repeats the song. | Repeats the song. |

- **Always going:** stations ignore the Vibe setting (as now) and never end, so no Vibe follows them.
- The next station is on the way (rule 2): fetched in full when the current one starts, an hour or two ahead.
- **Labels follow the song:** "Playing from", the Radio tab's on-air mark and "N of M" (within its station) change when the next station's first song plays. Walking back into the station before with Previous, they show that station, and Up next's heading for the list ahead names its station (D11).
- **Shuffle toggled while the next station is on the way:** it stays the next station; only its songs are mixed or unmixed (D10). "Not played yet" is kept with the session and starts over when you start something yourself.
- Offline, unsaved songs skipped are neither heard nor kept (D13).
- **Repeat all already on** when a station is tapped: it loops that station, as any list.
- **Offline:** unsaved songs are dimmed as everywhere, and Next skips to the next saved one, across stations; with none saved, "No carrier", as now.

## 5. Also looked at

- **F5 (native removes an upcoming song that fails to pre-load):** not changed. In Media3 1.11 a pre-loading period's error is held (loading stops) and only thrown once that period becomes the playing one, and `handleIoException` tags every source error with the playing period. So `perVideoFailure` takes its skip-in-place branch; the removal branch doesn't look reachable from a load error, and no failing test shows it. The private-DNS report is more likely F3 (Up next ending at the last song, S1 playing next unseen), which rule 5 makes visible.
- **F6 (a radio with a song queued lost its suggestions under Repeat all):** fixed in #155, which version 3 makes moot: Repeat all loops the current list (a Vibe batch included) with the songs you queued, and drops nothing. #155 is closed unmerged.

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

Autoplay is renamed **Vibe** (this doc says Vibe throughout): the same feature, with wording in Settings and Up next that says what it does (shown as a concept first). One change to how it picks:
- **No repeats within a session.** Today a Jukebox suggestion skips the queue and the last 50 songs heard. Vibe skips every song heard since you last started something yourself (a tap on a list or a song: the same boundary as Save's memory; with batches, "since the current list started" would reset every 25 songs: D9), read from Recently played (which keeps up to 1000 songs or 3 days, with when each played; no new store, and it survives a restart). New Cyberspace posts are unheard, so they come up as usual.
- When every match has been heard (a small genre, or offline with a few saved songs), it falls back to skipping the last 50, as today, so it never goes quiet.
- Cost: one filter of at most 1000 entries per refill (about every 20 songs), on the app's side only; the phone's player doesn't change.
- **Not doing:** continuing with Global songs once the Jukebox is used up. Nobody can realistically hear all of it, and it would send Jukebox sessions to YouTube Music, which they never do today.
- A song played from Global keeps continuing with YouTube Music's radio for it, as now.
- **A genre chosen on Home keeps the Vibe in that genre first:** it picks from that genre while it has unheard songs, then widens to the genre's family (metal to metalcore, hard rock), then to popular Jukebox songs.

## 6. How it's built

**How the queue holds it (no new architecture).** Both queues, web and phone, already keep the songs ahead in two blocks, the list and the suggestions, mixed separately, the suggestions dropped under Repeat all, kinds saved for restarts and sent to the app. Version 3 reuses them:
- the **current list** is the list block; **"On the way"** is the suggestion block;
- two **markers** say where the current list starts and where the next one (on the way) starts, as two positions in the queue, sent to the app and saved with the session; the songs before the first are history, what Played shows from earlier lists. Each song keeps its own kind (rule 4): no player item is rewritten;
- **moving on:** when a song at or past the second marker becomes current (played on to, or tapped), the first marker moves to it, or to the second marker if that comes first in the queue (with shuffle on, the batch's songs before it in the queue stay ahead, and a tap brings the current list's unheard songs it jumped over along, at the new list's start, as a tap ahead without shuffle keeps them), and nothing is on the way until the next list arrives; a station's label then follows (step 6);
- a radio-like start (one tapped song) is the one case where the first batch joins the current list instead of coming after it: the tapped song and the songs like it are one list (step 5);
- **Repeat all** drops the history before the first marker and everything from the second (what's on the way, as the existing drop does for suggestions), so Media3's own repeat loops just the current list;
- shuffle mixes each block on its own: the current list, then what's on the way;
- **turning shuffle off** moves the current list's unheard songs that sit before the playing one to after it (on the phone, Media3 plays its queue in stored order then; the queue already moves queued songs this way).

Each step ships as its own PR:
- the web side (`src/player/queue.ts`, `webPlayer.ts`, `autoplay.ts`, `radio.ts`, `types.ts`, `UpNext.tsx`, `PlayerUI.tsx`, `ui/playAll.ts`, `features/home/Home.tsx`) and the native side (`QueueOrder.kt`, `NativeQueue`, `ExoQueueHost.kt`, `PlaybackService.kt`, `StateEncoder`, `LastSession.kt`, `Stations.kt`) change together;
- the shared spec `tests/spec/queue-rules.json` gets the case first, failing on both runners (Vitest `queueRules.test.ts`, JVM `QueueRulesTest.kt`), then the fix;
- UI changes get concept screenshots first.

Order:
1. **Labels:** rule 4, F2. Done (#152).
2. **Shuffle:** rule 3's first part, F1, F7. Done (#154; and queued songs kept next when shuffle turns on or off, found by a fuzz).
3. **Lists that lead on (the core):** the two markers, moving on, Repeat all keeping the current list (the single-song exception goes), turning shuffle off skipping nothing, Save acting on the current list. No visual change but Save's count.
4. **"From the top":** rule 5's display, F3 (approved concept A), with rule 8's mark, loop and Save. Done (#159).
4b. **Queued songs' ↑ ↓ with shuffle on:** rule 8's first point. Done (#160).
4c. **The simulation's fixes:** S1-S15 and A2 (version 4), and Save's memory kept by the phone's player.
5. **Vibe batches and "On the way":** rules 2 and 7, F4: batches of 25 fetched when a batch starts, a Home tap starting one, "On the way" in Up next (concept screenshots first).
6. **Signal stations** (section 4) and **Shuffle the Jukebox** batches, on steps 3-5.
7. **Up to the playing song:** the button in Up next (concept q2).
8. **Vibe:** section 5a: the rename (wording concept first), session memory, a Home genre staying in its genre first.

Each PR needs:
- `npm run check`;
- the full e2e run, in its own worktree;
- e2e cases for what a person sees;
- green CI (Kotlin is checked there);
- a CHANGELOG line in the plain user tone.

TESTING.md gets phone checks for:
- Repeat all from a mid-list start, with a private DNS on;
- shuffle after Previous, and shuffle off mid-list (no song skipped);
- a Vibe from a Home song past its first batch, with the screen locked;
- Previous from the first song of a new batch;
- a station played to its end, with the screen locked, shuffle off and on.
