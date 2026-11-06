# The queue the rules imply: an ideal model, and how today's two queues map onto it

Companion to findings.md and mindmap.html (its top section draws this model). Main 66bc36c.

## 1. What the rules say, reduced to structure

| Rule | What it needs from the state |
|---|---|
| 1, 2 | The current list and the list on the way are two separate sequences; the way plays only after the list. |
| 3 | Shuffle, ↑ ↓, ✕ and Save act on the current list only; shuffle never reorders what was heard. |
| 4 | A song's kind is a property of the song (entry), not of its place. Undo puts *that entry* back. |
| 5 | One lap of the current list is a sequence of its own; "From the top" is that sequence before the playing song. |
| 6 | Repeat one is a flag on "song ended". |
| 7 | What you heard is a sequence (oldest first) you can walk back through, across lists; walking back never changes which list is current. |
| 8 | Songs you queue are a FIFO of their own, outside every list; once heard they stay where they played. |

Every rule above is about **which sequence a song is in**. Today both queues keep one flat sequence and work out the sequences from positions (two markers, kinds, a "pending" set, list order vs play order). Most findings are a position landing on the wrong side of a line.

## 2. The ideal model

```
Entry   { key, track, kind: 'list' | 'auto', mine: boolean, heard: boolean }   // immutable but for `heard`

Queue {
  history: Entry[]        // earlier lists of this chain, as they played (heard); empty while Repeat all is on
  lap:     Entry[]        // the current list in play order (one lap), with your heard queued songs where they played
  order:   Entry[]        // the current list in list order (album order), for shuffle off, Save, "N of M"
  cursor:  Position       // the playing song: an index into lap, or into history while walking back
  queued:  Entry[]        // yours, waiting: FIFO, ↑ ↓, never shuffled
  way:     { lap: Entry[], order: Entry[] } | null   // the next list (none with Repeat all or Vibe off)
  shuffle: boolean; repeat: 'off' | 'all' | 'one'
}
```

Everything the screen shows is a pure function of it:

| View | Function |
|---|---|
| Playing | `at(cursor)` |
| Played | `history ++ lap[0, cursor)` filtered to heard (walking back: the part of history before the cursor) |
| Up next | `queued ++ (walking back: history after the cursor ++ lap[0, ...)) ++ lap(cursor, end] ++ way.lap` (no way with Repeat all) |
| From the top | Repeat all: `lap[0, cursor)` without `mine` |
| N of M | position of the playing song in `order` / `order.length` (not `mine`) |
| Save | `order` ∪ {playing} ∪ every `mine` entry of history, lap and queued ∪ Save's memory of queued songs that left (in played order) |
| Native timeline | `history ++ lap[0, cursor] ++ queued ++ lap(cursor, end] ++ way.lap`, Media3 shuffle **off** (the queue owns shuffle) |

### Transitions (each a pure function `Queue → Queue`)

| Action | Transition |
|---|---|
| Next / song ends | Repeat one + ended: unchanged. Else the first of: `queued.shift()` inserted into `lap` right after the cursor (it now lives where it played); `cursor+1`; **moving on** to `way.lap[0]`; Repeat all: **loop**; else stop. |
| Moving on to entry e | `history ++= lap` (heard ones); new `lap = [e, ...unheard rest of the old list, ...way.lap without e]`, new `order = [...unheard rest (list order), ...way.order]`; `way = null` (the app fetches the next). |
| Loop | heard `mine` entries leave `lap`; cursor = 0 of what's left; `heard` resets for the lap (Played keeps showing them: rule 5). |
| Previous (≤ 3 s) | `cursor − 1` (into history at 0; Repeat all: the lap's last). Queued stay first: they're a separate sequence. |
| Tap | rest of the lap: move e to cursor+1, cursor+1 (what it jumped over stays ahead); way: moving on to e; Played / history: cursor = it; From the top: cursor = it, then heard `mine` leave (a new lap). |
| Add to queue | `queued.push(...)`; nothing playing: the first becomes `lap = [it]`, unmarked. |
| Shuffle on | `lap = heard part (as is) ++ playing ++ mix(unheard songs of order)`; `way.lap = mix(way.order)`. history, queued untouched. |
| Shuffle off | `lap = heard part (as is) ++ playing ++ unheard songs of order, in list order`; `way.lap = way.order`. |
| Repeat all on | `history = []` (also the walked-back playing song once it ends); `way = null`. |
| Vibe off | `way = null` (a station's next station stays). |
| ✕ | remove the entry from its sequence; keep `{entry, sequence, key of the entry after it}` for Undo. |
| Undo | put the same entry back in the same sequence before that key (or at the sequence's end), never at or before the playing song. |
| ↑ ↓ | swap within one sequence: `queued`, the rest of `lap` (and `order`, unshuffled), From the top. |
| Sign-out | remove those entries everywhere; the playing one gone: the next in Up next, else the one before (paused). |
| New list | `history = []`, `lap = order = the new list from its tapped song`, `queued` kept, Save's memory reset. |

### What becomes structural (no check needed)

R1.3 (a Vibe only after the list), R2.3 (history never ahead), R3.1-R3.6 (shuffle touches only the unheard part of the current list), R3.10 (↑ ↓ stay inside one sequence), R4.1-R4.3 (Undo restores the same entry, in the same sequence), R5.1-R5.2 (Repeat all: history and way are empty), R5.3 and R8.3-R8.4 (the loop starts at the first entry left after heard `mine` leave), R7.1 (Previous moves only the cursor), R8.1-R8.2 (queued is its own FIFO; `mine` is an entry flag), R3.7-R3.9 (Save is a function of the sequences), R4.4 (N of M from `order`).

What stays a behaviour to test: R1.4 (no skip), R2.2 (moving on), R6, R7.2-R7.4, R8.5-R8.6, and the native timeline staying equal to the model's.

## 3. Today's web Queue against the model

`src/player/queue.ts` keeps `list` (everything, list order) and `order` (everything, play order), `cur`, two marker entries (`listStart`, `nextStart`), `queued` (pending), `heard`, flags `auto` / `mine`, and `listLeft` / `nextLeft` (ids).

| Model | Web Queue | Matches? |
|---|---|---|
| history | `list[0, listStart)` | by position: anything moved past the marker changes list (F7, F14) |
| lap | `order` restricted to `[listStart, nextStart)` | yes, but blocks are recomputed by list index on every rebuild (F1: block 0 mixed ahead) |
| order (album order) | `list[listStart, nextStart)` | can differ from play order unshuffled after an Undo (F13) |
| queued | `queued` set + `keepQueuedNext` moving them in both arrays after every jump | yes, by repair after each step |
| way | `list[nextStart, end)` | by position (F6, F7) |
| Entry flags | `auto`, `mine`; heard in a side set | Undo makes new entries and loses `auto` / heard (F8, F15) |
| Undo anchor | `beforeId` (an id) | duplicates and kind changes (F9, F10) |

Patches the model makes unnecessary: `keepQueuedNext`, `afterQueued`, the three blocks and `played` keeping in `rebuildOrder`, the shuffled "bring jumped-over songs along" list surgery in `skipTo`, `unmark` / `listLeft` / `nextLeft` and the marker regain in `restore`, `restore`'s section-end search, `firstAuto` and `nextStartIndex` clamps, `drop` by index, `movesOn` by list index, the `lap` flag on `skipTo` (a From the top tap is a cursor move plus the loop's drop).

## 4. Today's NativeQueue against the model

`QueueOrder.kt` `NativeQueue` doesn't own the sequence: Media3 does (item order = list order; `ShuffleOrder` = play order when shuffled). The queue rebuilds its view from events (`onTransition`, `onPlaylistChanged`, `onShuffleModeChanged`) with uids and serials.

| Model | NativeQueue | Matches? |
|---|---|---|
| sequences | one Media3 timeline + markers by uid (`listStart`, `nextStart`) + `last` snapshot to hand markers on (`reanchor`) | by position, as the web (F1, F6, F7, F14) |
| play order | Media3 `ShuffleOrder` kept in line by `setShuffleOrder` after Media3's random inserts (`placeAhead`, `enforceShuffleOrder`, `restoreShuffledListItem`, the move fix-up for `cloneAndMove`) | yes, by repair |
| queued | `pending` serials + `enforceLinearOrder` / `enforceShuffleOrder` / `resortByList` | yes, by repair |
| loop | `onTransition(forward)` guessing the loop from "forward to an earlier play position"; `startLap` seeks on from Media3's window 0 when that is a heard song you queued, and a crossfade fades into where it lands (`landing`) | yes, since step 4c (F5), by a seek (without crossfade, that one loop isn't gapless) |
| shuffle off | `unshuffle`: the playlist moved (`moveItem`) into the order `rearranged` makes from the old `ShuffleOrder`, by a heard-this-lap set | yes, since step 4c (F2) |

The model's native form keeps Media3 for what it is best at (gapless, crossfade hand-over, preloading, the notification) and gives it a timeline already in play order, with Media3's shuffle mode off: a shuffle toggle becomes `moveMediaItems` to the new order (Media3 keeps the playing item playing). That removes every `ShuffleOrder` repair above, and list order (album order, for shuffle off and Save) is a small uid array the queue keeps and `LastSession` saves. The cost: moving items discards a preload of the next item when it moves (it reloads), on a toggle only.

## 5. Converging in small steps, riding along steps 5-8

Each step is one PR with its spec cases first (findings-cases.json has them), failing on both runners, then the fix on both sides.

1. **Before step 5 (bugs, no new architecture):**
   - a. F1 + F2 (shuffle: history stays behind; shuffle off keeps heard songs behind). Web `rebuildOrder`, native `shuffleFromCurrent` / `onShuffleModeChanged`.
   - b. F5 (the loop's first song) and F4 (a walked-back song leaves the loop): rule 5/8 wording + web `next` / `settle`, native `onTransition`.
   - c. "Undo carries its entry": F8, F9, F15, and F10's id anchors — the Undo keeps kind, heard, mark and the key of the song after it in play order; `restore` puts it back in its own list (clamped at the markers: F6).
   - d. F7: Up next breaks a heading at the second marker (`sectionsOf` by kind and list), so ↑ ↓ never cross it; F14: markers never hand over to a song you queued.
   - e. Small ones: F3 (Save keeps the playing song), F11 (web sign-out), F12 (N of M from the markers), F13 (web list order = play order unshuffled).
2. **Step 5 (Vibe batches, On the way):** On the way becomes the explicit `way` sequence (in the web Queue a `way: Entry[]` beside `list`; natively still after `nextStart` in the timeline). Settle D1 (window of 25), D2 (mix at arrival), D3 (only unheard songs come along), D7, D8, D16, D18 (keep the next list while Repeat all is on) in the doc first.
3. **Step 6 (stations, Jukebox batches):** `history` explicit in the web Queue (labels follow the song: D11); entry keys everywhere for repeated ids (D12); D10, D13, D14.
4. **Step 7:** no queue change.
5. **Step 8 (Vibe session memory):** boundary = you start something yourself (D9).
6. **After 1.4.1 (optional, the larger one):** web `Queue` as the five sequences (drops `list`/`order` duality and its repairs); native timeline in play order with Media3 shuffle off (drops the `ShuffleOrder` repairs). The shared spec and the parity explorer (parity.ts) prove each move: 3,000 unshuffled cases already match step for step today.
