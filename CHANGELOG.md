# Changelog

## [Unreleased]

Hardening for a public release and F-Droid.

### Autoplay and queue
- **Autoplay:** when a list ends, similar songs keep playing. Jukebox tracks lead to Jukebox tracks picked by artist, genre and which artists the same posters share; Global tracks lead to that song's radio. A tap on Home, Most saved or search results starts a radio from that song; albums, Liked, history and genre pages play in order first. Settings → Autoplay turns it off.
- Tracks added with "Add to queue" stay next when you start another list.
- Up next shows three parts: queued by you, the rest of the list ("Next from …") and Autoplay. Now Playing says where playback came from.

### Interface
- Artist, genre and album pages open on the tab you're on; Back returns exactly where you were. Tapping the active tab scrolls to the top, then back to its first page.
- Undo for unlike, unfavourite, removing from Up next and clearing history; confirmation before clearing history and signing out.
- ★ marks favourite genres and artists (♥ is only for liked tracks).
- Long titles scroll in Now Playing and the mini player; long-press a row for its menu; swipe up on the mini player.
- Smoother pull to refresh, sheets and scrolling; bigger touch targets; no accidental text selection; a tap that stops a scroll no longer plays a track.
- Recent searches (with Clear all); "Here" search on the Genres and Artists tabs; shorter Settings text; better contrast in the C64, Matrix, Crypt and Bubblegum themes.

### YouTube
- When YouTube limits requests from your network, playback pauses with a banner and waits (2, 5, 15, then 60 minutes) instead of skipping track after track; switching between Wi-Fi and mobile data no longer counts as a block.
- NewPipeExtractor follows the commit the NewPipe app ships. "Prefer IPv4" in Settings can help on networks YouTube flags.
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
- Literal `versionCode`/`versionName` (0.1.0 = 1000); the Release workflow commits the bump before tagging.
- Fastlane store metadata: descriptions, icon, feature graphic, screenshots and per-version changelogs.
- Reproducible builds: no dependency-metadata block in the APK, and a byte-identical web build.
- A draft fdroiddata recipe in `docs/fdroid/`.

### Repository
- Web screenshots are no longer committed (a workflow renders them as an artifact); the README images are in `docs/images/`.
- New `CONTRIBUTING.md` and `SECURITY.md`; the README covers the architecture, privacy and data use, YouTube limitations and building.

## [0.1.0] - 2026-10-05

First release.

- Latest Jukebox tracks as an endless list, "Shuffle the Jukebox", and genre browsing with Play all / Shuffle.
- Library with liked tracks and recently played, stored on the device.
- Background playback through a native Media3 service: notification, lock screen and headset controls. The queue keeps advancing with the screen off.
- Now Playing screen with seek, shuffle, repeat, like, "Posted by @user" and an Up Next queue you can reorder.
- Unplayable tracks are skipped automatically.
- Cyberspace themes: Dark, Light, C64, VT320, Matrix, Crypt, Bubblegum, GRiD.
- NSFW posts hidden by default.
- High and low audio quality settings.

Known limitation: with shuffle on, "Play next" adds the track to the queue but may not play it next.
