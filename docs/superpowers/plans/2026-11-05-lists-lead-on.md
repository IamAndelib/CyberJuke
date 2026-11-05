# Lists that lead on (the core): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Step 3 of the queue rules, version 3. The queue knows which list you're in and what's on the way, both in the web player and on the phone. On top of that:
- Repeat all loops the current list;
- turning shuffle off skips nothing;
- Save queue as playlist saves the current list.

**Architecture:**
- **Two markers per queue:** where the current list starts and where the next list (on the way) starts. Both are kept as entry identities: the web `Entry`, and the phone's uid.
- **Moving on:** the first marker moves when a song at or past the second becomes current. Kinds and labels don't change (rule 4).
- **Blocks:** the existing list/suggestion blocks become "current list / on the way". Shuffle mixes each block on its own. Repeat all drops what's on the way and the history before the first marker.
- **Transport:** the markers travel to the app as two queue indices, and are saved with the session.

**Tech Stack:** Preact + signals (web), Kotlin + Media3 (native), Vitest, pure-JVM JUnit, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-05-queue-rules-design.md`, version 3: rules 2, 3, 5 and 7, section 6 "How the queue holds it", and build step 3.

## Global Constraints

- The web and native sides change together.
  - Every queue rule is a case in `tests/spec/queue-rules.json`, run by `src/player/queueRules.test.ts` and `QueueRulesTest.kt`.
  - Each case is shown failing on both runners first.
  - Kotlin is checked here with `scratchpad/ql/run-gate2.sh` (or a copy pointed at the worktree in use), and in CI.
- `npm run check` passes on every commit, with 0 lint warnings.
- Logs never carry track ids.
- No visible change except:
  - Save's count;
  - what Repeat all loops after a list's suggestions have started;
  - shuffle off keeping unheard songs.
- No new headings or labels: "On the way" is step 5.
- Commit subjects `Area: what changed` (Player, Android, Now Playing, Tests), with a body explaining why and the session trailers. CHANGELOG `[Unreleased]` gets a plain line per visible change.
- The fix "queued songs stay next when shuffle turns on or off" (branch `claude/queued-shuffle`) is merged first. This work builds on its `rebuildOrder`.

## Review Focus

1. **A long session:** old played suggestions are trimmed (`KEEP_PLAYED` 50, `trimPlayedAuto`). The trim must never remove the first marker's song, or the current list would silently grow back into history. Trim only before the first marker.
2. **A restart mid-batch** (the app's screen killed, then the saved session restored): both markers come back. A v1 saved session reads as "current list from the first song, on the way from the first suggestion", which is today's meaning.
3. **A tapped Home song (a radio):** its first suggestions join its list. So Repeat all keeps them, as it does today through the single-song exception that this step removes. Without this, removing the exception would make Repeat all loop the one song.
4. **Autoplay turned off mid-batch:** only what's on the way goes, and the batch you're in stays. Today `dropAuto` drops every suggestion ahead.
5. **Queued songs under every new operation** (moving on, the Repeat all trims, shuffle off moving songs): they stay next, first in, first out. Re-run the queued-songs fuzz (`scratchpad/ql/zzQueuedFuzz.test.ts`, `scratchpad/ql/QueuedFuzz.kt`) before the PR.

---

### Task 1: The markers and moving on (web, native, spec)

**Files:**
- `tests/spec/queue-rules.json`: new cases.
- `src/player/queueRules.test.ts` and `android/.../playback/QueueRulesTest.kt`: a new expect key, `listStart` (the id of the current list's first song).
- `src/player/queue.ts`.
- `android/.../playback/QueueOrder.kt` (`NativeQueue`).

**Interfaces:**
- **Web `Queue`:**
  - `listStartIndex: number`: the list index of the current list's first entry, 0 by default.
  - `nextStartIndex: number`: the list index of the first entry on the way, or -1.
  - `addAuto(items: T[], joinList = false): void`.
- **Native `NativeQueue`:**
  - `listStartIndex(): Int` and `nextStartIndex(): Int`, with the same meaning;
  - `addAutoplay(items: List<T>, joinList: Boolean = false)`;
  - `restoreSession(…, listStart: Int = 0, nextStart: Int = -1)`.
- **Rules, the same on both sides:**
  - `setList` resets both markers: the current list starts at its first song, and nothing is on the way.
  - `addAuto` / `addAutoplay` sets the second marker to the first added entry when it's unset and `joinList` is false. With `joinList`, the entries join the current list.
  - When the current entry changes to one at or past the second marker in play order, the first marker becomes the current entry and the second is unset. Hook this where the entry becomes heard: web `settle()`, native where `heard.add` runs.
  - The played trim never removes entries at or after the first marker.

- [ ] **Step 1: Add the `listStart` expect key to both runners.** It's the id of the entry at `listStartIndex`. Also add the spec cases:
  - "playing on into the suggestions moves on: the current list starts at the first of them": list `[a,b]`, `addAuto [s1,s2,s3]`, `next`, `next` → `current s1`, `listStart s1`, `upNext [s2,s3]`.
  - "a tap on a suggestion moves on from it; the ones it jumped over play next": list `[a]`, `addAuto [s1,s2,s3]`, `skipTo s3` → `current s3`, `listStart s3`, `upNext [s1,s2]`.
  - "Previous from the first song of the new list plays the last one heard; Next comes back, and the new list stays current": list `[a,b]`, `addAuto [s1,s2]`, `next`×2, `prev 0` → `current b`, `listStart s1`, `upNext [s1,s2]`; then `next` → `current s1`.
  - "suggestions added after moving on are on the way, after the current list": continue the first case, `addAuto [t1,t2]` → `upNext [s2,s3,t1,t2]`, `listStart s1`.
  - "a new list starts from its first song": `setList` → `listStart` is its first.
  - "a radio's first suggestions join its list": needs an `addAuto` op flag `"joinList": true` in both runners. List `[a]`, `addAuto [s1,s2] joinList` → `listStart a`; then `addAuto [t1]` (no flag); `next`×2 to `s2` → `listStart a` (still the same list).
- [ ] **Step 2: Run both runners, expect red** (an unknown expect key, then wrong values).
- [ ] **Step 3: Implement both sides** as in Interfaces.
  - Web: keep `listStart`/`nextStart` as `Entry<T> | null` fields.
  - Native: keep them as uids, with 0 meaning unset.
  - Both trims (web `trimPlayed`, native `trimPlayedAuto`) skip entries at or after the first marker.
- [ ] **Step 4: Run both runners and `npm run check`, expect green.**
- [ ] **Step 5: Commit** `Player: the queue knows the list you're in and the one on the way`

### Task 2: Shuffle mixes each block; turning it off skips nothing (web, native, spec)

**Files:**
- `src/player/queue.ts`: `rebuildOrder`.
- `QueueOrder.kt`: `shuffleFromCurrent`, `arrange`, `enforceLinearOrder`.
- `tests/spec/queue-rules.json`.

**Interfaces:**
- Consumes the markers from Task 1.
- **Blocks ahead in play order:**
  - queued (unchanged);
  - the current list's unheard songs, mixed;
  - on the way (list index ≥ `nextStartIndex`), mixed.

  Before moving on, this is exactly today's list block and suggestion block.
- **Turning shuffle off** (only then: web `setShuffle(false)` / native `onShuffleModeChanged(false)`, never `setList`): the current list's unheard songs before the playing one move to right after the queued run, in list order.
  - On the phone, `host.moveItem`, since Media3 plays its queue in stored order when shuffle is off.

- [ ] **Step 1: Spec cases**
  - "shuffle off never skips a song: the list's unheard songs stay ahead, in list order": list `[a..h]`, start 0, `setShuffle on`, `next`×3, `setShuffle off` → Played as heard. `upNext` is every unheard song in list order. Assert with `upNext` over a fixed seed, or with `listSet` plus `upNextOrderedBy: "list"` if the runners need it; prefer exact `upNext` with the runners' seeded shuffle.
  - "a list started mid-way still starts there": list `[a..e]`, start 2, nothing else → `upNext [d,e]` (unchanged behaviour, a guard).
  - "after moving on, shuffle mixes the current list, then what's on the way, each on its own": first case of Task 1, then `addAuto [t1,t2]`, `setShuffle on` → `listSet` `[s2,s3]` before `autoplaySet` of `t1,t2`. Read the runners' existing set keys and use them.
- [ ] **Step 2: Run both runners, expect red.**
- [ ] **Step 3: Implement both sides.**
- [ ] **Step 4: Run both runners, `npm run check` and the queued fuzz, expect green.**
- [ ] **Step 5: Commit** `Player: turning shuffle off never skips a song`, with the CHANGELOG line:
  > "Turning shuffle off no longer skips songs: every song of the list you haven't heard stays in Up next, in the list's order."

### Task 3: Repeat all loops the current list (web, native, spec)

**Files:**
- `src/player/queue.ts`: `setRepeat`; `dropAuto` is replaced by `dropOnTheWay`.
- `src/player/webPlayer.ts`: `setAutoplay`, and its `mayAutoplay` calls.
- `src/player/types.ts`: `mayAutoplay`.
- `src/player/autoplay.ts`.
- `QueueOrder.kt`: `onRepeatModeChanged`; `dropUpcomingAuto` becomes `dropOnTheWay`.
- `Stations.kt`: `mayAutoplay`, and its callers in `PlaybackService.kt`.
- `tests/spec/queue-rules.json`.

**Interfaces:**
- `mayAutoplay(repeat: RepeatMode): boolean` and `Stations.mayAutoplay(repeatMode: Int): Boolean`: true unless repeat is all.
- `dropOnTheWay()` on both sides: removes the entries at or after the second marker that aren't queued, and unsets the marker. Autoplay off uses it too, so it no longer drops the batch you're in.
- Repeat all turned on runs `dropOnTheWay()`, then drops the history before the first marker, keeping the playing entry and the queued ones.

- [ ] **Step 1: Spec cases**
  - "after moving on, repeat all loops the current list: the songs before it and what's on the way go": Task 1's first case plus `addAuto [t1]`, then `setRepeat all` → `played []`, `upNext [s2,s3]`; `nextAuto`×2 then `nextAuto` → `current s1`.
  - "a one-song list's suggestions go under repeat all": list `[a]`, `addAuto [s1,s2]` (no `joinList`), `setRepeat all` → `upNext []`. This replaces "a single song's autoplay tracks are its radio…".
  - "a radio's suggestions are its list: repeat all keeps them": list `[a]`, `addAuto [s1,s2] joinList`, `setRepeat all` → `upNext [s1,s2]`.
  - Rewrite "Up next keeps play order in a radio's loop…" to start with `joinList`. Delete "with repeat all, jumping to an autoplay track keeps the ones after it (the loop)", or rewrite it with `joinList`. Name each in the PR.
  - Update the spec's `rule` text to rule 5.
- [ ] **Step 2: Run both runners, expect red.**
- [ ] **Step 3: Implement both sides.** Update every `mayAutoplay` caller, and make the rule text in `queue.ts`, `QueueOrder.kt` and `types.ts` match.
- [ ] **Step 4: Run both runners and `npm run check`, expect green.**
- [ ] **Step 5: Commit** `Player: repeat all loops the list you're in`, with the CHANGELOG line:
  > "Once a list's suggestions are playing, Repeat all loops them, the list you're in now, instead of jumping back to the list before."

### Task 4: The markers reach the app and survive a restart; the players pass `joinList`

**Files:**
- `android/.../bridge/StateEncoder.kt`: `listStart` and `nextStart` as queue indices.
- `src/player/native.ts`, `src/core/guards.ts` (`parseNativeState`; missing → 0 and -1), `src/player/nativePlayer.ts`.
- `src/player/types.ts`: `PlayerState.listStart: number` and `PlayerState.nextStart: number`, defaulting to 0 and -1 in `EMPTY_STATE`.
- `src/player/webPlayer.ts`: publishes them from the `Queue` getters; `addAutoplay` passes `joinList`.
- `android/.../playback/PlaybackService.kt`: its `addAutoplay` passes `joinList`, and the session save/restore carries the markers.
- `android/.../playback/LastSession.kt`: `VERSION = 2`, with `listStart` and `nextStart` as entry indices in the saved window; a v1 file reads as 0 and the first suggestion entry, or -1.
- Tests: `guards.test.ts`, `nativePlayer.test.ts`, `LastSessionTest.kt`, `webPlayer` tests.

**Interfaces:**
- `joinList` is true exactly when the play context's mode is `radio`, the current list is the tapped song alone, and nothing is on the way (`nextStart === -1`).
- Keep the condition in one helper on each side, named as in `isRadio` style: `firstBatchOfRadio(state)` / `Radios.firstBatch(...)`, beside its twin, each with a comment naming the other.

- [ ] **Step 1: Failing tests**
  - `parseNativeState` reads `listStart`/`nextStart`, and their absence gives 0/-1.
  - `LastSession` round-trips v2 markers, and reads a v1 fixture as 0 and the first suggestion.
  - The web player publishes the markers after moving on.
  - A web player in a `radio('Home · Latest')` context adds its first suggestions with `joinList`, and later ones without it.
- [ ] **Step 2: Run them, expect red.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: `npm run check` and the Kotlin harness (with `LastSession.kt` added to a copy of the script if it compiles without Android, otherwise CI), expect green.**
- [ ] **Step 5: Commit** `Player: the app and a restored session know the list you're in`

### Task 5: Save queue as playlist saves the current list

**Files:**
- `src/features/now-playing/UpNext.tsx`: `saveQueue`.
- `tests/e2e/playlists.spec.ts`.

**Interfaces:**
- Consumes `PlayerState.listStart` / `nextStart`.
- The songs are the queue entries with index in `[listStart, nextStart < 0 ? queue.length : nextStart)`:
  - shuffle off: in list order;
  - shuffle on: the order shown (Played, the playing song, Up next) filtered to that range, then the rest of it.
- Deduplicated, at most `PLAYLIST_MAX_SONGS`.

- [ ] **Step 1: Failing e2e test** `after an album's suggestions start, Save queue as playlist saves the list you're in`.
  - Play the Night Owl album (`playAlbum`), go to its end, and Next into the first suggestion.
  - Save → the dialog note reads "With N songs", where N is the number of suggestions.
  - Keep the two existing Save tests passing unchanged: they're before any moving on, so they're the album.
- [ ] **Step 2: Run it, expect red.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it and the playlists spec, expect green.**
- [ ] **Step 5: Commit** `Now Playing: Save queue as playlist saves the list you're in`, with the CHANGELOG line:
  > "Save queue as playlist saves the list you're in: an album, or once its suggestions are playing, those."

### Task 6: e2e for what a person sees, gates, PR

- [ ] **e2e** in `tests/e2e/autoplay.spec.ts`:
  - after an album's suggestions start, Repeat all loops them: no album song in Played, and the Next after the last goes to the first suggestion;
  - turning shuffle off mid-album keeps every unheard song in Up next;
  - a Home song with Repeat all keeps its suggestions (the existing test, still green).
- [ ] Run the queued-songs fuzz on both sides; 0 failures.
- [ ] `npm run check`, the Kotlin harness, then the full e2e in its own worktree (private port).
- [ ] Read the diff adversarially:
  - the rule text is the same in the spec, `queue.ts`, `QueueOrder.kt` and `types.ts`;
  - no `dropAuto` and no `mayAutoplay` count argument is left;
  - both markers are adjusted wherever entries are removed or moved (`remove`, `move`, the trims, `restore`).
- [ ] Push `claude/lists-lead-on` and open the PR (template sections), naming each changed test and why. Subscribe, and merge on green across all 8 checks.
