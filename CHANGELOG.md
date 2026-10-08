# Changelog

## [Unreleased]

Hardening for a public release and F-Droid.

### Security and releases
- The preview is now a separate app, **CyberJuke Preview** (`io.github.iamandelib.cyberjuke.preview`), built like a release (R8, not debuggable) and signed with its own key kept only in repository secrets. It installs alongside CyberJuke and never shares its data. Uninstall the old debug-signed preview.
- The committed debug keystore is removed; debug builds use each machine's own debug key.
- Releases are built unsigned in a read-only job (no credentials, no install scripts, no caches) and signed with `apksigner` in a separate job in the protected `release` environment.
- Every GitHub Action is pinned to a commit SHA, each job has least-privilege permissions, and the Gradle wrapper and distribution are checksum-verified. A workflow generates Gradle dependency-verification metadata.
- The WebView's console logging and remote debugging are off in every build.
- The unused `google-services` Gradle plugin is removed.

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
