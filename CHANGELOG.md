# Changelog

## [Unreleased]

### The app
- Starring a genre or artist, or liking a track, now responds at once. One tap used to redraw the whole Artists or Genres grid (every tile, even behind another tab) or the whole page around the star; now only the star changes.
- On the Genres and Artists tabs, a starred tile moves up into ★ Favourites the moment you tap (no copy stays in the grid below); unstarring puts it back in its place. This used to wait for a scroll or the next visit.
- Adding shows a short "‹name› added to Favourites" / "Added to Liked songs" message without Undo; removing still offers Undo.
- Messages at the bottom can be swiped away, left or right, and only one shows at a time: a new one replaces the last (quick taps no longer stack "Added" and "Removed"). A message also goes as soon as you touch or scroll anywhere else; Undo stays a tap on the message itself.
- Settings → Updates: CyberJuke checks GitHub for a newer release (once a day at most; can be turned off, or checked on request). A new release shows at the top of Settings with a Download link, and as a dot on the Settings tab. Installs from F-Droid update through F-Droid and never check.

### Fixes
- A scroll that starts on the seek bar scrolls Now Playing and no longer seeks.
- Messages at the bottom no longer cover back-to-top or the YouTube banner's [Try now]; a message without Undo lets a tap through to what's under it.
- A quick second tap where a starred tile was no longer stars the tile that slid into its place.
- Genre and artist names fit their tiles on narrow phones instead of breaking mid-word.
- The A–Z letter while fast-scrolling skips a letter whose tiles are all in Favourites.
- Keyboard and screen-reader focus stays put when a star moves its tile, when Up next rows move or go, and after Clear history.
- Settings → Updates shows the time of the last check.
- Now Playing, the Library and Recently played do much less work while music plays (Now Playing redrew itself every second); long histories load as you scroll.
- After Android stopped the app: a tap on the music notification opens Now Playing even if the page had to reload; a list of over 500 tracks comes back at the right place; Autoplay and audio quality settings apply to a media-key resume; a restored session keeps which tracks are members-only (and drops them when signed out).
- Playback that YouTube paused resumes only where it was playing (not on the speaker once headphones are gone), keeps the phone awake for it when Play was pressed meanwhile, and a pause key cancels it.

## [1.0.2] - 2026-10-09

### The app
- The app opens on what you were playing last time, paused at the same spot (with Up next, shuffle and repeat), even after it was swiped away, stopped by Android, force-stopped or crashed. Nothing loads until you press Play.
- Tapping the media notification (or the lock screen player) opens Now Playing.

### Fixed
- If Android reclaimed the memory of the app's web page while music played in the background (or that page crashed), Android killed the whole app and the music stopped. Now only the page reloads; playback goes on.
- Dragging the seek bar sought on every step of the drag, and the bar then stayed where it was let go, even after skipping to the next track. A drag now seeks once, when it ends, and the bar follows playback again.

### Repository
- The emulator smoke test also ends the page's renderer while music plays (as a system kill and as a crash) and checks that the app keeps playing, and force-stops the app and checks the last session comes back.

## [1.0.1] - 2026-10-09

The same app as 1.0.0, released so that F-Droid can ship it.

### Releases
- The release APK is signed without re-aligning it (`apksigner --alignment-preserved`): it is now exactly the unsigned build plus a signature, so F-Droid's own build of the tag matches it and F-Droid can ship the GitHub-signed APK. 1.0.0's signing had re-padded two uncompressed files, which broke that comparison.
- The Release workflow publishes nothing unless the signed APK passes that comparison (`apksigcopier compare`).

## [1.0.0] - 2026-10-09

The first stable release.

### The app
- The Cyberspace Jukebox as a music app: the latest tracks as an endless list, Most saved, "Shuffle the Jukebox", genres and artists with Play all and Shuffle, and search (Here, Jukebox and Global).
- Background playback through a native Media3 service, with notification, lock screen and headset controls; the queue keeps going with the screen off.
- Now Playing with synced lyrics and an Up next you can reorder; liked tracks and recently played, stored on the device.
- Optional sign-in for members-only shared tracks.
- Eight Cyberspace themes: Dark, Light, C64, VT320, Matrix, Crypt, Bubblegum and Brutalist. NSFW posts are hidden by default; high and low audio quality.

### Autoplay and queue
- **Autoplay:** when a list ends, similar songs keep playing. Jukebox tracks lead to Jukebox tracks picked by artist, genre and which artists the same posters share; Global tracks lead to that song's radio. A tap on Home, Most saved or search results starts a radio from that song; albums, Liked, history and genre pages play in order first. Settings → Autoplay turns it off.
- Tracks added with "Add to queue" stay next when you start another list.
- Up next shows three parts: queued by you, the rest of the list ("Next from …") and Autoplay, each reorderable with ▲/▼ (except with shuffle on). Now Playing says where playback came from.

### Interface
- Artist, genre and album pages open on the tab you're on; Back returns exactly where you were. Tapping the active tab scrolls to the top, then back to its first page.
- Undo for unlike, unfavourite, removing from Up next and clearing history; confirmation before clearing history and signing out.
- ★ marks favourite genres and artists (♥ is only for liked tracks); a genre or artist can be starred from its own page too.
- Now Playing: the ♥ sits beside the title and artist; long titles scroll in Now Playing and the mini player; long-press a row for its menu; swipe up on the mini player.
- Smoother pull to refresh, sheets and scrolling; bigger touch targets; no accidental text selection; a tap that stops a scroll no longer plays a track.
- Settings → Licenses lists every bundled library and opens their full license texts.
- Menus and confirmations hold the screen behind them: nothing scrolls or reacts under a menu, and focus returns to where it was.
- Search finds the music only (title, artist, genre), not who posted it. Recent searches (with Clear all); "Here" search on the Genres and Artists tabs; shorter Settings text; better contrast in the C64, Matrix, Crypt and Bubblegum themes.

### YouTube
- **"YouTube is limiting requests" happens far less and clears by itself.**
  - A new **IPv4** setting: **Auto** (the default), Always or Off. YouTube flags IPv6 addresses much more readily, so on Auto the app switches a network to IPv4 the moment YouTube refuses a request over IPv6, retries at once with no banner, and remembers that network (Wi-Fi and mobile data separately) for a day. The old "Prefer IPv4: on" becomes Always.
  - A refused request is retried once before anything is blocked; a refused stream gets one fresh link first.
  - When a block does happen, playback pauses instead of skipping track after track, and **resumes by itself** when a short wait is over (screen off too; not if you unplugged your headphones meanwhile). Waits are shorter (1, 3, 10, then 30 minutes) and relax again after half an hour without a block.
  - The same after a dropped connection: playback picks up again when the network is back.
  - Switching between Wi-Fi and mobile data, changing the IPv4 setting, or tapping **[Try now]** on the banner lifts a block at once.
  - A refused search, artist page, radio or lyrics lookup no longer stops the music: those features wait on their own.
  - Each song now costs YouTube 2 requests instead of 5 (the app asks only for what playback needs, and falls back to the full lookup if anything looks unexpected).
  - Settings shows a "Connection" line (IPv4 or IPv6, the last limit) to paste into bug reports.
- NewPipeExtractor follows the commit the NewPipe app ships.
- Stream links are reused until they expire; prefetching waits until a track has played for a while.

### Security and releases
- The preview is now a separate app, **CyberJuke Preview** (`io.github.iamandelib.cyberjuke.preview`), built like a release (R8, not debuggable) and signed with its own key kept only in repository secrets. It installs alongside CyberJuke and never shares its data. Uninstall the old debug-signed preview.
- The committed debug keystore is removed; debug builds use each machine's own debug key.
- Releases are built unsigned in a read-only job (no credentials, no install scripts, no caches) and signed with `apksigner` in a separate job in the protected `release` environment.
- Every GitHub Action is pinned to a commit SHA, each job has least-privilege permissions, and the Gradle wrapper and distribution are checksum-verified. A workflow generates Gradle dependency-verification metadata.
- The WebView's console logging and remote debugging are off in every build.
- The unused `google-services` Gradle plugin is removed.
- Other apps can only play, pause and skip: they can't change or read the queue. Sign-in data and members-only tracks stay out of Android backups and are removed on sign-out (and at startup when signed out).
- No plain-HTTP traffic; JitPack can only serve NewPipeExtractor's own artifacts.

### Quality
- ESLint (typescript-eslint and the hooks rules), and `npm run check` for typecheck, lint and unit tests.
- CI runs the Kotlin unit tests and the e2e suite (stubbed backends, three shards), and builds the preview.
- A daily canary checks playback, search, artist pages and lyrics against YouTube, and opens a `youtube-breakage` issue when parsing fails.
- Renovate keeps npm, Gradle, GitHub Actions and NewPipeExtractor up to date.

### F-Droid
- Literal `versionCode`/`versionName` (1.0.0 = 1000000); the Release workflow commits the bump before tagging.
- Fastlane store metadata: descriptions, icon, feature graphic, screenshots and per-version changelogs.
- Reproducible builds: no dependency-metadata block in the APK, and a byte-identical web build.
- A draft fdroiddata recipe in `docs/fdroid/`.

### Repository
- Web screenshots are no longer committed (a workflow renders them as an artifact); the README images are in `media/screenshots/`.
- New `CONTRIBUTING.md` and `SECURITY.md`; the README covers the architecture, privacy and data use, YouTube limitations and building.
