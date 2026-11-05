# "From the top" and rule 8 (songs you queue): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Step 4 of the queue rules, plus rule 8.
- With Repeat all on, Up next goes on under "From the top" with the next lap.
- A song you queue keeps a "queued by you" mark after it plays, never comes back in the loop, and is saved by Save queue as playlist.

**Architecture:**
- **The mark:**
  - web: `Entry.mine`;
  - native: the queue serial already on each queued MediaItem (`EXTRA_QUEUE_SERIAL`, never cleared), so mine = `serialAt(i) != 0L`;
  - saved with the session.
- **The loop:** when the player wraps from the list's last song in play order to its first, heard mine songs (not the current) leave the queue. A tap on a "From the top" row enters the next lap, so it does the same. Previous, or a tap on Played or on any other row, walks back and keeps them.
- **State:**
  - `PlayerState.mine` (queue indices with the mark);
  - `PlayerState.lap` (the next lap: play order from the first song up to the current one, without mine songs, Repeat all only, at most 50).
  - The web player computes both. Native sends them as `mineIndex` / `lapIndex`, built by StateEncoder.
- **Save:** the current list, plus every mine song still in the queue, plus mine songs that left the player since the last song or list you started yourself. The web remembers those.

**Tech Stack:** Preact + signals (web), Kotlin + Media3 (native), Vitest, pure-JVM JUnit, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-05-queue-rules-design.md`: rules 3 (Save), 5 ("From the top") and 8, and build step 4.

## Global Constraints

- The web and native sides change together.
  - Every queue rule is a case in `tests/spec/queue-rules.json`, run by `src/player/queueRules.test.ts` and `android/app/src/test/java/io/github/iamandelib/cyberjuke/playback/QueueRulesTest.kt`.
  - Each case is shown failing on both runners first.
  - Kotlin is checked here with the pure-JVM harness (`scratchpad/ql/run.sh`, pointed at the worktree in use) and in CI. PlaybackService, StateEncoder and LastSessionTest compile in CI only.
- `npm run check` passes on every commit, with 0 lint warnings.
- Logs never carry track ids.
- UI: only the approved concept A, the "From the top" label and its rows, per the concept screenshots.
  - Played stays as it is.
  - "N up next" counts to the end of the list.
  - No new mark or styling on Played rows.
- Commit subjects `Area: what changed` (Player, Android, Now Playing, Tests, Docs), with a body explaining why and the session trailers. CHANGELOG `[Unreleased]` gets a plain line per visible change.
- Rulings already made (don't reopen):
  - **R1:** "Add to queue" with nothing playing makes the first song a list of one, not mine (the web does this today). Native must match: serial 0 for that first item in `NativeQueue.queueNext`'s `count == 0` path.
  - **R2:** a heard mine song that's ahead again after Previous keeps its row kind (list). No new heading.
  - **R3:** a tap on a "From the top" row enters the next lap, so heard mine songs leave first. A tap on a Played row walks back, so they stay and play again (rule 8, maintainer's choice b).
  - **R4:** the web's memory of mine songs that left the player is lost if Android kills the WebView. Accepted.
  - **R5:** the web loop goes to `order[0]`, as Media3 does, and removes the other heard mine songs.
  - **R8:** Undo of a "From the top" row uses a new restore kind `top`. It goes back before `beforeId` among everything before the current song in play order, without becoming heard.

## Review Focus

1. **The loop on native:** Media3 reports a user Next, a tap, Previous and the crossfade hand-over all as `REASON_SEEK`.
   - The service passes `forward` into `NativeQueue.onTransition(forward)`. It is true for AUTO, and for Next, the error skip, continue-after-end and `handOver()`.
   - The queue detects the loop itself: `forward && host.repeatAll && playPos(new) < playPos(lastUid)`.
   - Removal happens inside the transition callback, as `trimPlayedAuto` already does. It never removes the current item.
   - A forward flag that no transition consumes must be cleared.
2. **Crossfade and gapless:** removing items behind the current one never touches the playing period. Never remove at fade start.
3. **The lap under shuffle:** native sends its play order from `getFirstWindowIndex(shuffle)` to the current one. The web uses `order`, never `list` (`rebuildOrder` changes order only).
4. **A restart:** the mark is saved and restored.
   - `restoreSession` must take pending songs from sections only. Today line ~442 turns any upcoming serial into pending.
   - Older saved sessions read as no mark.
5. **Optimistic UI paths in `nativePlayer.ts`** (`playList`, `showMoved`, `showRemoved`) remap `mine` and `lap`, so rows don't flicker.
6. **Preact keys:** a song can be in Played and in "From the top" at once. Keys include the kind.

---

### Task 1: The mark (web, native, spec)

**Files:** `src/player/queue.ts`, `src/player/webPlayer.ts`, `src/player/types.ts`, `src/player/native.ts`, `src/player/nativePlayer.ts`, `android/.../playback/QueueOrder.kt`, `android/.../playback/QueueCommands.kt`, `android/.../playback/PlaybackService.kt` (ACTION_RESTORE ~1912), `tests/spec/queue-rules.json`, `src/player/queueRules.test.ts`, `QueueRulesTest.kt`.

- [ ] **Spec first.** Add the expect key `mine` (ids carrying the mark, in list order) and `mine: true` on the `restore` op to the spec's `about` text and both runners.
  - Kotlin runner: mine = `serials[i] != 0`.
  - Cases, failing first:
    - queue M, play into it and past it: `mine` = [M];
    - ✕ the heard M from Played, then Undo (`restore` kind `played`, `mine: true`): still mine;
    - "Add to queue" with nothing playing [M1, M2]: `mine` = [M2] (R1).
- [ ] **Web.** Add `mine?: true` on `Entry` next to `auto` (~60-65).
  - Set it in `queueNext` (~336) for the entries that are queued (not `entries[0]` when nothing plays), and in `restore` when kind is `queued` or the new `mine` arg is set.
  - `restore(item, kind, beforeId, mine = false)`.
  - Add `mineIndices(): number[]` (list indices).
- [ ] **Native.**
  - `NativeQueue.queueNext` `count == 0` path: serial 0 for index 0 (R1).
  - `restorePlayed(item, beforeId, mine)`: `nextSerial++` when mine, not added to pending.
  - Bridge: `restore({track, kind, beforeId, mine?})` (`native.ts` ~100, `nativePlayer.restore`, `QueueCommands.ARG_MINE`, `PlaybackService` ACTION_RESTORE).
  - `UpNext.tsx`'s Undo passes `mine` for a Played row whose song carried it. Until Task 4 adds `state.mine`, pass false. Task 6 wires it.
- [ ] `npm run check`; the Kotlin harness; commit `Player: a song you queue keeps its mark after it plays`.

### Task 2: The mark survives a restart (native)

**Files:** `android/.../playback/LastSession.kt`, `PlaybackService.kt` (`sessionOf` ~1420-1463, `restoreLastSession` ~1375-1392), `QueueOrder.kt` (`restoreSession` ~419-445), `LastSessionTest.kt`, `QueueOpsTest.kt`.

- [ ] Test first:
  - `LastSessionTest`: an entry with `mine` round-trips. A file without `"m"` reads `mine = false`. The version stays 2: an older app ignores the field.
  - `QueueOpsTest`: `restoreSession` with a heard mine entry ahead of the current one (after Previous) gives it a serial but **not** pending; a QUEUED entry stays pending.
- [ ] `LastSession.Entry.mine` stored as `"m"` (`optBoolean("m", false)`). `sessionOf` sets `mine = serial != 0L`. `restoreLastSession` passes `entries.map { it.mine }`.
- [ ] `restoreSession(..., mine)`:
  - serial when `(section == QUEUED && i != s) || mine[i]`;
  - pending from `section == QUEUED` only (fix the "any upcoming serial is pending" line).
- [ ] Kotlin harness for `QueueOpsTest` where it runs pure; LastSessionTest runs in CI. Commit `Android: the queued-by-you mark is saved with the session`.

### Task 3: The loop never brings a queued song back (web, native, spec)

**Files:** `src/player/queue.ts` (`next` wrap ~213-217, `skipTo`), `src/player/webPlayer.ts`, `src/player/nativePlayer.ts`, `src/player/native.ts`, `QueueOrder.kt` (`onTransition`, `skipTo`, `QueueHost`), `ExoQueueHost.kt`, `PlaybackService.kt` (SessionPlayer `seekToNext*` ~716-730, error skip ~1741, continue-after-end ~1087, crossfade `handOver` ~785-798, `onMediaItemTransition` ~1022, SKIP_TO), `JukePlayerPlugin.kt` (`skipToNext` ~741 if it bypasses SessionPlayer), `QueueCommands.kt`, spec + both runners.

- [ ] **Spec first.** Add `skipTo {id, lap: true}` (a tap on a "From the top" row) to the spec's `about` text and both runners. FakePlayer: `transition` takes `forward`. It is true from `next`/`nextAuto`, false from `skipTo` and `prev`. `QueueHost.repeatAll` reads `repeat == "all"`. Cases, failing first:
  1. Album [a,b,c], queue M while on a, play to c, Repeat all, `nextAuto`: current a, M gone (`list` has no M).
  2. The same with user `next`.
  3. From c, `prev` to b, then `next`, `next`: M not removed by Previous. Then a tap (`skipTo` a, no `lap`) from c: M stays, and playing on plays M again (choice b).
  4. From c, `skipTo` a with `lap: true`: M gone, current a.
  5. Shuffle on, Repeat all, the same: M gone after the loop, and the other songs' order is unchanged (`upNext` equals the lap captured before the loop; add an op `keepTop` and an expect `upNextIsKeptTop` if needed).
  6. M pending (not yet heard) at the loop: stays (only heard mine songs go).
  7. `setRepeat all` with a heard M before `listStart` drops it (today's drop). Pin it.
- [ ] **Web.**
  - In `Queue.next`'s Repeat all branch, after `settle()`: drop entries that are `mine && heard.has(e) && e !== cur`, with `unmark`.
  - `skipTo(index, lap = false)` does the same before moving when `lap`.
  - Thread `lap` through `webPlayer.skipTo`, `Player.skipTo` (`types.ts`) and `nativePlayer.skipTo` → bridge `skipToIndex({index, id, lap})`.
- [ ] **Native.**
  - `QueueHost.repeatAll` (ExoQueueHost: `repeatMode == REPEAT_MODE_ALL`).
  - `NativeQueue` keeps `lastUid`, and has `onTransition(forward: Boolean)`. On a loop it removes `(0 until count).filter { it != cur && serialAt(it) != 0L && isHeard(it) }`, in descending order.
  - `skipTo(index, lap)` removes the same first (re-resolve `index` by uid after the removals).
  - PlaybackService:
    - a `forwardAsked` flag, set in SessionPlayer `seekToNext*` (incl. the saved-only path), the error skip, continue-after-end and `handOver()`;
    - consumed and cleared in `onMediaItemTransition`;
    - also cleared after `super` returns when no transition happened.
  - SKIP_TO reads `ARG_LAP`.
- [ ] Kotlin harness; `npm run check`; re-run both queued-songs fuzzes (`scratchpad/ql/fuzz-both.sh`, pointed at the worktree). Commit `Player: Repeat all never brings back a song you queued`.

### Task 4: The lap and the mark reach the app (web state, bridge, native encoder)

**Files:** `src/player/types.ts` (`PlayerState`, `EMPTY_STATE`), `src/player/queue.ts` (`lapIndices`), `src/player/webPlayer.ts` (`publish` ~182-203), `src/player/native.ts` (`NativeState`), `src/core/guards.ts` (`parseNativeState` ~75-115), `src/player/nativePlayer.ts` (`apply` ~221-283, `builtFrom`, `playList` ~296-330, `showMoved` ~397-415, `showRemoved` ~418-426), `android/.../bridge/StateEncoder.kt`, `src/player/index.ts` (`lapTracks` computed, `__cyberjukeQueue` hook: add `top` and `mine`), tests (`guards.test.ts`, `nativePlayer.test.ts`, `queue.test.ts`, `QueueInfoTest.kt` if the encoder walk is reachable in JVM).

- [ ] **Spec first.** Expect `top` (lap ids in play order) and `topSet` (as a set, for shuffled cases). Web: `lapIndices()`. Kotlin: `top()`, which walks play order from the first index to the current one, skipping serial != 0, Repeat all only. Cases:
  - mid-start album (start 2) with Repeat all: `top` = [song 1, song 2];
  - a heard M excluded;
  - Repeat off: `top` empty;
  - shuffle on: `topSet` = played minus M.
- [ ] Web `lapIndices(max = UP_NEXT_MAX)` = `repeat === 'all' ? order.slice(0, p).filter((e) => !e.mine).slice(0, max)` → list indices. `publish` sets `mine` and `lap` (`UpNextItem[]`, like `previous`).
- [ ] StateEncoder:
  - `mineIndex`: all queue indices with `EXTRA_QUEUE_SERIAL != 0`.
  - `lapIndex`: Repeat all only. From `timeline.getFirstWindowIndex(shuffle)`, step with `getNextWindowIndex(i, REPEAT_MODE_OFF, shuffle)` until the current one, skipping serial != 0. At most 50.
- [ ] `parseNativeState`: both fields like `prevIndex` (integers, in range, not the current one). `lapIndex` keeps the first 50. A missing field gives `[]`.
- [ ] `nativePlayer.apply` fills `mine` and `lap`. Add both to `builtFrom`. The optimistic paths remap them: `playList` mine = the kept queued songs' indices, `lap` = []; `showMoved`/`showRemoved` remap like `previous`.
- [ ] Tests, `npm run check`, harness. Commit `Player: the app knows the next lap and the songs you queued`.

### Task 5: Undo of a "From the top" row (web, native, spec)

**Files:** `src/player/types.ts` (`UpNextKind`/restore kinds), `src/player/queue.ts` (`restore`), `QueueOrder.kt` (`restorePlayed` or a new `restoreTop`), `QueueCommands.kt` (`KIND_TOP`), `PlaybackService.kt` ACTION_RESTORE, `native.ts`, spec + both runners.

- [ ] **Spec first.** `restore {kind: "top", beforeId}`. It goes back right before `beforeId` among all songs before the current one in play order, heard or not, and is not marked heard; with no `beforeId`, right before the current song. Cases:
  - mid-start album (start 2), Repeat all, ✕ song 1 from the lap (`remove`), Undo with `beforeId` song 2: `top` = [1, 2] again, `played` unchanged;
  - shuffled: back before its follower in play order.
- [ ] Web and native implement it with the same anchor rule; the bridge carries `KIND_TOP`.
- [ ] Commit `Player: Undo puts a From the top song back in its place`.

### Task 6: "From the top" in Up next (UI, e2e)

**Files:** `src/features/now-playing/UpNext.tsx`, `src/features/now-playing/now-playing.css` (only if the label needs it; reuse `.upnext-label`), `src/player/index.ts` (`lapTracks`), `tests/e2e/autoplay.spec.ts` (or a new `tests/e2e/from-the-top.spec.ts`), `CHANGELOG.md`.

- [ ] **e2e first** (fails today):
  - **Night Owl album, Repeat all, Next ×4 (song 5 of 8):** after the list's rows, a label "From the top" (`data-testid="upnext-top-label"`), then rows `data-section="top"` for songs 1–4 in order. The first row's ↑ is disabled and the last row's ↓ is disabled. "3 up next" stays.
  - **At song 8:** "From the top" shows songs 1–7.
  - **Mid-start (tap song 3 on the album page), Repeat all:** "From the top" shows songs 1–2.
  - **Shuffle on:** the rows have ✕ only, in the order Played shows them.
  - **Repeat off:** no "From the top".
  - **A queued song you heard:** not under "From the top"; still in Played.
  - **Tap a "From the top" row:** it plays; a queued song you heard is gone from Played (`lap` tap).
  - **✕ on a "From the top" row, then Undo:** the song is back in its place.
- [ ] **Render.**
  - After the runs: the label, then `rows('top', lap)`. Keys `${kind}:${id}:${index}` (Played and "From the top" can show one song at once).
  - Add `top` to the aria-label suffix map (no suffix), the Undo kind (`top`), `movedRow` parts, and focus.
  - A tap on a top row calls `player.skipTo(index, id, true)`.
  - Undo of a Played row passes `mine` from `state.mine` (Task 1 left it false).
- [ ] CHANGELOG `[Unreleased]`:
  - "With Repeat all on, Up next goes on under "From the top" with the songs that play next time round, and you can reorder or remove them there."
  - "Songs you add to the queue play once: Repeat all no longer plays them again with the album."
- [ ] Commit `Now Playing: Up next shows the next lap under "From the top"`.

### Task 7: Save keeps the songs you queued (web)

**Files:** `src/player/index.ts` (the `player` wrapper ~100-114: memory, reset on `playList`), a pure helper in `src/player/` (e.g. `saveSongs.ts` + test), `src/features/now-playing/UpNext.tsx` (`saveQueue` ~95-111), `tests/e2e/playlists.spec.ts`, `CHANGELOG.md`.

- [ ] **Unit test first** for the pure helper `saveSongs({queue, listStart, nextStart, shuffle, shown, mine, gone})`:
  - result = mine songs before `listStart`, in play order, then the current list (in play order when shuffled, as today), then mine songs in `gone` that are no longer in the queue, each right after the song it followed when it played (`after` id), else at the end;
  - duplicates dropped; at most `PLAYLIST_MAX_SONGS`.
- [ ] **Memory** in `src/player/index.ts`:
  - an ordered list of `{track, after}` for each mine song that became current (from `state.mine` and `index`; `after` = the previous current's id);
  - reset when `player.playList` is called from the app (wrap it like `remove`/`restore`). The offline guard's empty-queue `playList` doesn't count as starting something new: check `offlineGuard.ts` ~93 and decide by the call path;
  - a song ✕-removed by the user drops out, and Undo brings it back (the existing `removed` Set).
- [ ] **e2e** (playlists.spec), failing first:
  - album + 2 queued, play past them, Repeat all, play through the loop: Save saves 10;
  - album ended into its suggestions with 2 queued heard before: Save on the batch includes them;
  - a new album tapped: Save no longer includes them.
- [ ] CHANGELOG: "Save queue as playlist keeps the songs you queued, also after the album repeats or its suggestions start."
- [ ] Commit `Now Playing: Save queue as playlist keeps the songs you queued`.

### Task 8: Docs, gates, PR

- [ ] TESTING.md phone checks:
  - Repeat all from a mid-list start with a queued song, crossfade on and off, gapless on, the screen locked across the loop: the queued song doesn't come back, nothing stutters;
  - a restart (swipe the app away, reopen): a queued song you heard is still not in "From the top".
- [ ] `npm run check`; the full e2e in its own worktree; both fuzzes; the Kotlin harness.
- [ ] PR `Player: From the top, and songs you queue play once` with the template. Then CI green on all 8 checks.
