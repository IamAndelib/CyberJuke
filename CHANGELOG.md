# Changelog

## [Unreleased]

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
