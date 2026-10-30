# Offline, done properly (1.3.6): design

Status: draft for the maintainer's review. Nothing here is built yet.
Main at writing: 3f9839e (1.3.5).

## 1. What we're fixing, and for whom

**What the maintainer saw on the phone (1.3.5, offline):**
1. In Now Playing, the offline line is clipped and sits in the wrong place.
2. At the end of the feed: "Retry loading more", which can't work offline.
3. A liked song has no album art.
4. Next says "No carrier. Your liked songs still play." and doesn't move, although liked songs are queued.

The review found 27 more problems. Section 9 lists all 31 with where each is fixed.

**The goal:** a person with liked songs can go offline (plane, subway, no data) and:
- the app opens on something that plays;
- Next, the end of a song, the notification and headphones all move to the next song that's on the phone;
- every liked song shows its art;
- every line on screen says something true and useful.

Saving stays automatic. That is the maintainer's choice: there is no download button, and liking a song is what saves it.

**Success means:**
- On a phone in airplane mode, with a mixed queue of saved and unsaved songs, Next from the app, the notification and the headset each land on the next saved song. A song ending does the same.
- Liked songs saved on Wi-Fi are still there after a week of streaming other music, on any cache size.
- Liked rows, Now Playing and the lock screen show art offline.
- No offline screen shows a button that can't work there.

## 2. What other players do (from the research)

- **A separate store for downloads.** NewPipe, InnerTune, Metrolist and SimpMusic all keep downloads in their own store, which never evicts (Media3's `NoOpCacheEvictor`). The player cache is separate and evicts by LRU. Playback reads the download store first, then the cache, then the network. This is also what Media3's docs show.
- **A fixed download quality,** separate from streaming quality. Wi-Fi only by default.
- **Art saved with the song.** It shows in lists and in the notification (Metrolist, InnerTune).
- **Offline, unplayable rows are greyed out.** The app opens on what plays (Spotify, YouTube Music).
- **Notices are passive.** There are no retry buttons that can't work offline.
- **Where others fall short:** most stop or show an error on an unsaved song in the queue. Skipping to the next saved one is where CyberJuke can do better.

## 3. Playback offline: Next goes to the next saved song

**Rule:** offline, any move forward lands on the next song in play order that's saved on the phone. It skips the songs that aren't. With Repeat all it wraps round the list. If no saved song is ahead, nothing changes from today: the song plays out and "Signal lost…" shows.

- **Native owns the skip.** It covers every path, including with the screen off:
  - `SessionPlayer.seekToNext*`, which handles the app, the notification and headsets;
  - `onMediaItemTransition`, when a song ends;
  - `handlePlayerError`, when the network drops on an unsaved song;
  - the crossfade target, so a crossfade never starts into an unsaved song.
- **One pure helper,** `OfflineNext.target(from, count, next, playable)`. It walks `timeline.getNextWindowIndex` at most `count` steps and treats Repeat one as off for Next. It is JVM-tested (shuffle order, wrap, none found, all unsaved never loops). A skip counter, reset once a song is READY, prevents loops.
- **"Saved" means the same set on both sides:** the `savedLiked` snapshot that the web's offline guard also uses.
- **Web guard** (`offlineGuard.ts`):
  - Next is allowed when any saved song is ahead (`savedAhead`; with Repeat all, anywhere in the queue).
  - Previous checks the song it would really land on: `previous.at(-1)` under 3 s, else the current one.
  - A refused liked song says "unsaved", not "offline".
  - This merges **in the same PR** as the native skip, since it is a contract (`native.ts` doc).
- **Also in this area:** `savedLiked` counts only the liked songs the app shows (`likedShown`), so a hidden NSFW song can't make Liked look playable.

## 4. Storage: a saved store for liked songs

### Approaches

| | A. Separate saved store (recommended) | B. Keep one cache, patch it |
|---|---|---|
| What | `no_backup/saved`, which never evicts, next to the listening cache | Fix `victims()` order, a fixed save quality, wake the saver on resize |
| Liked songs vs. other music | Can't push each other out | Still share one size limit; a full cache stops saving more |
| Copies on High | One | Two, as today |
| Code | About 3 new small units plus migration | Smaller |
| Used by | NewPipe, InnerTune, Metrolist, Media3 docs | Only us |

**A is recommended.** B keeps the root cause, liked songs and streamed songs fighting over one limit. That root cause is behind the flakiness the maintainer noticed.

### Design (A)

- **Two SimpleCaches,** sharing the one `StandaloneDatabaseProvider` (allowed as long as the folders differ):
  - `audio/` is the **listening cache**: the Settings size, LRU, emptied by Clear cache.
  - `saved/` is the **saved store**: one copy per liked song, no size limit, under the same `yt:`/`mp3:` keys.
- **Read order.** A read-only `CacheDataSource` over `saved` wraps the existing listening `CacheDataSource`, both with `FLAG_IGNORE_CACHE_ON_ERROR`, so a bad file never stops a song. `wholeKey` looks in saved first.
- **The saver writes into saved.** A pure `SavePlan` picks one of two moves:
  - **COPY** from a whole listening copy that's good enough. It's local and instant, needs no network, and doesn't count toward YouTube's limits. A liked song you just played is saved this way.
  - **DOWNLOAD** at the fixed save quality: High for Auto and High, Low for Low. It no longer uses the live Auto rung, which only reflects a bad moment on the network.
- **Wi-Fi only stays the default.** "Download using mobile data" keeps its meaning.
- **A free-space floor:** no new save when the phone has less than 1 GB free (`StatFs`).
- **Migration from 1.3.5: copy, don't move.** On first start, liked songs already whole in `audio/` are copied into `saved/` one at a time, with no network. Each keeps its protection in the listening cache until its copy exists. A downgrade ignores `saved/` (it only wastes space until the app is cleared).
- **Unliking.** An unliked song leaves the saved store at the next app start, not right away. That way a quick re-like costs nothing. An empty liked list (a failed load) never wipes the store. A pure `SavedReconcile.toRemove` decides this.
- **Signing out and members-only songs:** they leave both stores, as they leave the cache today.
- **Saving stays inside the player service.** There's no download notification, no new permission, no background job and no wake-ups. Saves happen while the app runs on Wi-Fi. If people report songs left unsaved, WorkManager (unmetered, storage not low) is the fallback.
- **Settings** (shown as a concept first):
  - the size choice becomes "Recent songs cache: 128/256/512 MB";
  - a read-only line under it, "Saved liked songs: N songs · X MB".

  The CHANGELOG says liked songs no longer count toward that size.

### Saver reliability (these apply to either approach)

- **A dropped connection isn't a failure.** A save cut off because the network was lost or changed counts as cancelled, not a strike. The give-up list clears on a new Wi-Fi network.
- **Answers that can be retried are retried.**
  - 403 or 410: resolve the link again once, inside the job.
  - 5xx, 408, 416 or 429: a strike, so it's tried again later.
  - Other 4xx: give up.
- **A broken cache index recovers.** If a store fails to open, it's wiped and opened once more. A wiped saved store refills itself on Wi-Fi.
- **No startup race.** `cachedIds` and `cacheChanged` carry a `seq` number, and the web keeps only the newest. That fixes the case where liked songs read as unsaved after launch.
- **Raising the size wakes the saver** (one line in `setLimitMb`).

## 5. Art offline

- **Saving:** after a song is saved, its covers go to `no_backup/art/<audioId>-hq.jpg` and `-mq.jpg`. MP3s use their bunker cover. Each is written to a temp file, then renamed. Covers leave with the song.
- **Notification and lock screen:** a small `BitmapLoader` wrapper around Media3's `DataSourceBitmapLoader`. When a saved copy exists, an allowed cover URL reads from its `file://` copy. It's set with `MediaSession.Builder.setBitmapLoader`.
- **Lists and Now Playing:** a thin `BridgeWebViewClient` subclass (Capacitor's `Bridge.setWebViewClient`, which is public in 8.x) answers GET requests for exactly those cover URLs from `art/`. Everything else goes to `super`.
  - **Rejected: a service worker.** It needs a CSP change (`worker-src 'none'` today), and its storage would be backed up.
  - **Rejected: `LOAD_CACHE_ELSE_NETWORK`.** It applies to the whole WebView, and its HTTP cache can evict art.
- **Contract:** `setLikedIds` gains `covers[]`, one cover per id for MP3s and `""` otherwise. Each is checked by `SessionPolicy.isAllowedArtwork`.

## 6. Screens and words offline

Anything visual is a **concept screenshot first**: 360 and 412 px, Dark plus one light theme. The maintainer picks before any of it is built. The defaults below are recommendations.

| Where | Today | Proposed (default) |
|---|---|---|
| Now Playing offline line | Squeezed between two buttons, clipped | **A:** a full-width bar at the top of Now Playing, like the app's offline bar (B: a short chip; C: none) |
| List end, offline | "Retry loading more" | A quiet line: "No carrier. More loads when you're back." It loads by itself on reconnect |
| Home, offline | `[ NO CARRIER ]` | **A:** a "Shuffle liked songs" hero ("Saved on the phone · plays offline"), with the stored Jukebox list below and unsaved rows dimmed (B: the offline box with a **Liked** button) |
| Search, offline | The Jukebox part is blocked | Jukebox results from the stored list, unsaved rows dimmed; "Search globally" hidden |
| Album, playlist, releases | Generic offline box | "Connect to the internet to load this album." (or playlist, list) |
| Offline bar | Two heights, and it flickers at launch | One 44 px height. It waits for the saved list before dimming rows (up to 2 s) |
| New-tracks pill | Shows offline and drops feeds | Hidden offline, back on reconnect |
| Pull to refresh, offline | The list flickers, no message | Springs back with the existing "pull again" toast; nothing is reloaded |
| Up next, offline | Unsaved rows look tappable to TalkBack | `aria-disabled`; the current row dims if it can't play |
| Clear cache, offline | No warning | Adds "No carrier right now: nothing plays until you're back online." |
| Add to queue, refused | Says "Playing" anyway | No "Playing" toast |
| Back online | Not announced | Screen readers hear "CONNECT. Back online." |

**Stores, without UI:**
- Signing out offline keeps the public Jukebox list. Only the members-only keys go.
- No update check runs offline; it runs on reconnect instead.
- Liked counts only the songs the app shows (section 3).

No new UI text names "YouTube Music". That content stays "Global".

## 7. Contracts, privacy and docs

- **Web ↔ native changes,** each made on both sides in one PR:
  - the offline Next rule;
  - `seq` on `cachedIds`/`cacheChanged`;
  - `covers[]` on `setLikedIds`;
  - `savedBytes` for the Settings line.
- **Backups:** `saved/` and `art/` live in `no_backup/`, which is never backed up, and the cache index is already excluded. `data_extraction_rules.xml` and `full_backup_content.xml` only get matching comment updates.
- **Network:** covers are now also fetched natively (i.ytimg.com and bunker.cyberspace.online) when a song is saved. The README network table gets that row, and the privacy table a "Stored on the phone: covers of saved liked songs" row.
- **Logs:** new code logs only where an error happened and its name and message. No ids or URLs.
- **Docs:**
  - TESTING.md: its two contradicting offline lines (:68 and :125) are rewritten, and phone checks are added for each phase;
  - README:46 says Next skips to saved songs;
  - CHANGELOG lines for each user-visible change.

## 8. How it ships

One PR at a time, each merged before the next. Every confirmed bug gets a test that fails without its fix. Kotlin is proven by CI and the emulator smoke test, and anything storage- or art-related also gets a phone check from a Preview.

**Phase 1: Next works offline, and the small store bugs** (no UI change):
1. Player + web: offline Next, song end, the error path and crossfade skip to the next saved song. Native and web together.
2. Stores: Liked counts only shown songs; signing out keeps the public list; no update check offline.
3. Player + web: saved-set `seq` (the startup race).
4. UI: no "Playing" toast on a refused Add to queue.

→ **Preview 1.**

**Phase 2: saver reliability**, the four fixes in section 4, one PR each or two small ones.

**Phase 3: the saved store**
1. Open the saved store and read it first. Nothing writes to it yet, so nothing changes.
2. Saves go into it at the fixed quality, with the migration copy.
3. The listening cache protects only unsaved likes, plus the free-space floor and the Settings line (concept first).
4. Unliked songs leave at start.

→ **Preview 2:** upgrade from 1.3.5 with saved likes, then airplane mode.

**Phase 4: art**
1. Notification and lock-screen art.
2. Lists and Now Playing (the WebView intercept).
3. MP3 covers (`covers[]`).

→ **Preview 3.**

**Phase 5: screens.** One concept set covers all of section 6, made right after this spec is approved so it can be reviewed while phases 1–4 are built. Then one PR per row group, in the table's order, and the docs PR.

→ **Preview 4.** Then the 1.3.6 release review, the release and the F-Droid recipe.

**Also in 1.3.6, separate from offline:** with shuffle on, the stale-link retry and the manifest fallback skip the song (`replaceMediaItem` in shuffle). It gets its own PR with a failing-first test, deferred from 1.3.5.

## 9. Every problem found, and where it's fixed

| # | Problem | Fix |
|---|---|---|
| 1 | Now Playing offline line clipped | §6, phase 5 |
| 2 | "Retry loading more" offline | §6, phase 5 |
| 3 | Liked song art missing offline | §5, phase 4 |
| 4 | Next refuses with liked songs queued | §3, phase 1 |
| 5 | Automatic advance and notification Next stop on unsaved songs | §3, phase 1 |
| 6 | Previous checks the wrong song | §3, phase 1 |
| 7 | Repeat all: Next at the last song refused | §3, phase 1 |
| 8 | Refusal says "offline" for a liked song | §3, phase 1 |
| 9 | A hidden NSFW liked song counts as playable | §3, phase 1 |
| 10 | Startup race: saved songs read as unsaved | §4, phase 1 |
| 11 | Signing out offline deletes the public Jukebox list | §6, phase 1 |
| 12 | Update check runs offline | §6, phase 1 |
| 13 | Refused Add to queue says "Playing" | §6, phase 1 |
| 14 | A dropped Wi-Fi connection counts as a failed save | §4, phase 2 |
| 15 | Any HTTP error gives up for good | §4, phase 2 |
| 16 | A broken cache index never recovers | §4, phase 2 |
| 17 | Raising the cache size doesn't wake the saver | §4, phase 2 |
| 18 | Streaming music pushes out saved liked songs | §4, phase 3 |
| 19 | Saves use the live Auto quality | §4, phase 3 |
| 20 | High keeps two copies; the kept one isn't whole offline | §4, phase 3 |
| 21 | Notification art offline | §5, phase 4 |
| 22 | Offline bar flickers and changes height at launch | §6, phase 5 |
| 23 | New-tracks pill offline drops feeds | §6, phase 5 |
| 24 | Load more offline | §6, phase 5 |
| 25 | Pull to refresh offline flickers | §6, phase 5 |
| 26 | Offline copy points to Global search | §6, phase 5 |
| 27 | Search blocks the stored Jukebox offline | §6, phase 5 |
| 28 | Clear cache offline has no warning | §6, phase 5 |
| 29 | The Shuffle hero offline says the wrong thing | §6, phase 5 |
| 30 | Up next: unsaved rows not `aria-disabled`; the current row not dimmed | §6, phase 5 |
| 31 | Back online not announced | §6, phase 5 |

## 10. Decisions: the maintainer's, and the defaults

- **Made by the maintainer:** saving stays automatic.
- **Defaults** (each one can be changed):
  - **D1:** offline Next skips to the next saved song on every path.
  - **D2:** a separate saved store (approach A), so liked songs no longer count toward the cache size.
  - **D3:** save quality is High for Auto and High, Low for Low.
  - **D4:** an unliked song leaves at the next app start.
  - **D5:** art is saved with liked songs.
  - **D6:** saving runs only while the app runs; no background downloads.
  - **D7:** free-space floor of 1 GB.
  - **D8 to D10** are visual (Now Playing line A, Home A, Search with the stored Jukebox) and get picked from the concept screenshots.

## 11. Risks

- **Migration (phase 3).** Copy, not move, and protection is kept until each copy exists. CI can't test an upgrade, so Preview 2 checks it on the phone.
- **Storage growth.** Covered by the free-space floor, the Settings line and the CHANGELOG note.
- **A Capacitor update changing `BridgeWebViewClient`.** The subclass is thin and calls `super`, and the dependency review checks it.
- **Two caches and two locks.** They're never held at once. The writer reads the listening cache through its own source.
- **The web guard's 2 s wait** must time out if native never reports. A Vitest covers that.
- **Behind a captive portal** the app thinks it's online. The existing toasts cover it.
