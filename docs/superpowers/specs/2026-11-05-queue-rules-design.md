# The queue: list, shuffle, repeat and autoplay (1.4.1): design

Status: approved by the maintainer on 5 Nov 2026 ("go ahead with the queue rules"). Nothing is built yet.
Main at writing: 0aa6e69 (1.4.0 + #147, #148).

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

## 2. The rules

1. **The list always comes first.** Suggestions play only after the list, shuffle or not. Nothing but ✕ (or sign-out) takes a list song out.
2. **Suggestions are always shown, and never end.**
   - With Autoplay on, a list's first suggestions are fetched when it starts, once the app is idle.
   - They show at the end of Up next, under "Autoplay · similar to …".
   - Scrolling near the bottom loads more, with "Loading more…" as Home's feed shows it. The player tops up by itself as before, so it never runs dry while you just listen.
   - New batches always go at the end.
   - With Autoplay off, or Repeat all on a list, none are added (as now).
3. **Shuffle mixes what hasn't played.**
   - What stays behind is exactly what Played shows. Everything in Up next, plus list songs before the start, is mixed ahead.
   - The list is mixed first, then the suggestions among themselves (the maintainer's choice). New suggestions while shuffled go at the end, mixed among themselves.
   - Shuffle off restores list order.
4. **Each song keeps its own label.**
   - A row's section comes from its own kind (queued by you, list, autoplay), never from its position. Native already sends the kinds.
   - A heading shows each time the kind changes.
   - "N of M" counts list songs only.
   - Undo puts a song back as its own kind, in its own place.
5. **Repeat all loops the whole list from S1, and Up next shows it.**
   - After the last song, Up next goes on with S1, S2… under "From the top", which is a UI change and gets concept screenshots first.
   - With shuffle on, every lap plays the same mixed order (Media3's documented default).
   - A song tapped on its own keeps its radio (the `mayAutoplay` exception), queued songs included.
6. **Repeat one** replays the song when it ends, and Next moves on (unchanged).

**Also (F5):** on the phone, a song that fails while pre-loading is skipped where it is when its turn comes, as the playing-item path already does. It is never removed from the list.

**Sources:**
- YouTube Music: an Autoplay preview always at the end of the queue.
- Apple Music: the Autoplay section below Playing Next, never shuffled with your music, and hidden under repeat.
- Metrolist: "Shuffle playlist or album first", and its similar content fetched at album start.
- InnerTune and Metrolist: refill at 5 or fewer left.
- NewPipe `PlayQueue.append`: new items go at the end.
- Auxio and SimpMusic `BetterShuffleOrder.cloneAndInsert`: added items as one block.
- Media3 `Timeline.getNextWindowIndex`: repeat all goes to the first item.

## 3. How it's built

Each rule ships as its own PR:
- the web side (`src/player/queue.ts`, `webPlayer.ts`, `autoplay.ts`, `types.ts`, `UpNext.tsx`) and the native side (`QueueOrder.kt`, `NativeQueue`, `PlaybackService.kt`, `StateEncoder`) change together;
- the shared spec `tests/spec/queue-rules.json` gets the case first, failing on both runners (Vitest `queueRules.test.ts`, JVM `QueueRulesTest.kt`), then the fix.

Order:
1. **Labels:** rule 4, F2.
2. **Shuffle:** rule 3, F1, plus F7.
3. **Repeat all:** rule 5, F3, F6 (concept screenshots for "From the top" first), plus F5.
4. **Autoplay:** rules 1 and 2, F4: suggestions from the start, appended in order, endless loading in Up next.

Each PR needs:
- `npm run check`;
- the full e2e run, in its own worktree;
- e2e cases for what a person sees;
- green CI (Kotlin is checked there);
- a CHANGELOG line in the plain user tone.

TESTING.md gets phone checks for:
- Repeat all from a mid-list start, with a private DNS on;
- shuffle after Previous;
- a long session's suggestions.
