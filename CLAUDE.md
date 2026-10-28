# CyberJuke

An unofficial Android music app for the Cyberspace Jukebox. It is a Preact 11 + @preact/signals web app (Vite 8, TypeScript 7) inside Capacitor 8, with a Kotlin native player (Media3 ExoPlayer + NewPipeExtractor). It is licensed GPL-3.0.

Human docs come first, so don't duplicate them here:
- [CONTRIBUTING.md](CONTRIBUTING.md): setup, commands, build types, releases, dependencies, commit style.
- [docs/PUBLISHING.md](docs/PUBLISHING.md), [docs/TESTING.md](docs/TESTING.md) and [docs/fdroid/](docs/fdroid/).
- [SECURITY.md](SECURITY.md).

**Maintenance protocol:** [`.claude/skills/steward/SKILL.md`](.claude/skills/steward/SKILL.md). Read it before triaging, fixing, reviewing dependency PRs or preparing a release.

## Layout

- `src/` imports go **down** the layers only: `app → features → ui → stores / player / data → core`.
  - ESLint enforces this (`layerRules` in `eslint.config.js`, rule R1).
  - A feature never imports another feature.
  - Exceptions: `data/index.ts` may import stores, `stores/block.ts` may import player types, and `core/guards.ts` may import types only.
- `src/features/<screen>/` holds one screen each: a component plus its CSS.
- `src/data/source.ts` (`TrackSource`) is the only way into the Cyberspace backend (`firestore.ts`, `auth.ts`: plain HTTPS, no SDK).
- Web ↔ native bridges are registered in `MainActivity.java`. Native code lives in `android/app/src/main/java/io/github/iamandelib/cyberjuke/`.

  | Plugin | Web | Kotlin |
  |---|---|---|
  | `JukePlayer` | `src/player/native.ts` (a contract: change both sides together) | `bridge/JukePlayerPlugin.kt` → `playback/PlaybackService.kt` |
  | `JukeMusic` | `src/data/ytmusic.ts` | `bridge/MusicPlugin.kt` → `yt/` |
  | `SecureStore` | `src/data/secureStore.ts` | `bridge/SecureStorePlugin.kt` |

- `tests/spec/queue-rules.json` is one queue spec shared by `src/player/queue.ts`, `QueueOrder.kt` and their tests. Keep the TS and Kotlin sides in step.
- Only `yt/YtCompat.kt` (streams) and `yt/YtMusic.kt` (YouTube Music) touch NewPipeExtractor's API. It is pinned in `android/variables.gradle` (`newPipeExtractorVersion`).
- Tests:
  - Vitest units next to the code (`src/**/*.test.ts`).
  - Playwright `tests/e2e/` runs on a test build with stubbed backend, music plugin and YouTube (`tests/fixtures/`); `@live` tests hit the real Firestore.
  - Kotlin JVM tests are in `android/app/src/test/`.

## Commands

In a cloud session, the SessionStart hook (`.claude/hooks/session-start.sh`) installs `node_modules`.

| Runs here | Command |
|---|---|
| typecheck + lint (0 warnings) + unit tests, before every commit | `npm run check` |
| e2e on a phone-sized Chromium (uses `/opt/pw-browsers` automatically) | `npm run e2e` |
| one unit test file | `npx vitest run src/stores/feed.test.ts` |
| render every screen to `test-results/screenshots/` | `npm run screenshots` |
| production web build | `npm run build` |

**CI only:** there is no Android SDK in cloud sessions. That covers Gradle, `testDebugUnitTest` (Kotlin), `assembleDebug/Preview/Release`, the emulator smoke test (`scripts/ci-smoke.sh`) and the YouTube canary. Changes to Kotlin are verified by CI on the PR. Read the job logs; don't guess.

## Invariants: never break these

- **Privacy:**
  - Logs name where an error happened and the error's name and message only. Never log search queries, track ids or tokens (`src/core/log.ts`).
  - `res/xml/data_extraction_rules.xml` and `full_backup_content.xml` stay in sync and keep excluding the secure store, last session and `file/cyberjuke/`.
  - `capacitor.config.json` keeps `loggingBehavior: "none"`, `webContentsDebuggingEnabled: false` and `accessOrigins: []`.
  - No Firebase SDK, Play Services, google-services or analytics.
  - When a data flow changes, update the README privacy and network tables.
- **Naming:** never show "YouTube Music" in UI text; that content is "Global". The Jukebox stays the centrepiece.
- **F-Droid / reproducibility:**
  - `versionCode` and `versionName` stay literal in `android/app/build.gradle`.
  - No timestamps in builds; `dependenciesInfo` stays off.
  - The update check never runs for F-Droid installs.
  - Node 22.22.0 is pinned in the workflows. The recipe installs Debian's nodejs (forky); the Reproducible build check with `debian_node: forky` proves both give the same APK.
- **Supply chain:**
  - GitHub Actions are pinned to full SHAs with a `# vX.Y.Z` comment; workflows start with `permissions: {}`.
  - Gradle's `distributionSha256Sum` comes from gradle.org.
  - Never commit keystores, `*-secrets.txt`, `google-services.json`, build output or `test-results/`.
- **Lint:** `--max-warnings=0`. Every `eslint-disable` says why after `--`.

## Workflow rules

- Work on a `claude/*` branch and deliver through a PR (template: `.github/pull_request_template.md`). Never push to `main`, merge, run Release/Preview, or touch signing secrets.
- **Keep it simple; don't reinvent the wheel.** Before building anything, look for how others already solve it (Media3/Android docs and samples, well-known open-source players such as NewPipe, SimpMusic, InnerTune, established web patterns) and follow the proven approach. Build our own only where theirs falls short, and name the source in the PR.
- **How we build: a reliable, fluid app from a small, clear codebase.** Software made with care, as a craft.
  - The fewest clear lines: don't write ten where two will do, add no redundancy, and remove what isn't needed.
  - Fast and fluid where a person can feel it. Don't optimise what no one will notice.
  - Slow and steady. One change at a time, finished, verified and merged before the next. Research and measure before building. Never run agents in parallel on the same files.
- A confirmed bug gets a fix **and** a test that fails without it. No failing test, no fix: a hypothesis is not a bug.
- Every user-visible change gets a line under `## [Unreleased]` in `CHANGELOG.md`, in the existing plain, user-facing tone.
- Commits:
  - Subject is `Area: what changed`, under ~72 characters. Areas: Player, Data, Stores, UI, Android, Tests, CI, Build, Release, Docs, F-Droid, Repo, or a screen name.
  - The body explains why.
  - One logical change per commit, and `npm run check` passes on each.
