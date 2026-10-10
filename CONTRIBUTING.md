# Contributing to CyberJuke

Thanks for helping. Bug reports, fixes and small features are all welcome. For anything bigger, open an issue first so we can agree on the approach.

Security problems: please don't open a public issue. See [SECURITY.md](SECURITY.md).

## Setup

You need **Node 22**, **JDK 21** (Temurin is what CI uses) and the **Android SDK** with compile SDK 36. Android Studio is optional.

```bash
git clone https://github.com/IamAndelib/CyberJuke && cd CyberJuke
npm ci --ignore-scripts      # no dependency needs an install script on Linux/Windows
npx playwright install chromium   # once, for the e2e tests
```

## Day to day

```bash
npm run dev          # the web UI in a browser (playback needs the app: the CSP blocks embeds)
npm run check        # typecheck + ESLint + unit tests: run before every commit
npm run lint -- --fix   # fixes what ESLint can fix by itself
npm run e2e          # Playwright e2e tests on a phone-sized Chromium
npm run screenshots  # renders every screen into test-results/screenshots/ (not committed)
npm run media        # regenerates the README and store images in media/ and fastlane/
npm run sync         # build the web app and copy it into android/
cd android && ./gradlew testDebugUnitTest   # Kotlin unit tests
cd android && ./gradlew assembleDebug       # debug APK in android/app/build/outputs/apk/debug/
```

- **ESLint** allows no warnings (`--max-warnings=0`). Where a rule has to be switched off for a line, the `eslint-disable` comment says why after `--`.
- **e2e tests** run against the production build with Firestore, the native player and sign-in stubbed by a shared fixture, so they work offline and give the same results every run. Tests tagged `@live` talk to the real Cyberspace backend; CI leaves them out.
- **Kotlin tests** are plain JVM tests under `android/app/src/test/`. The YouTube canary (`-Pcanary=true`) needs the network and is run daily by CI, not by default.

### Emulator smoke test

CI installs the debug APK on an API 34 emulator and runs [`scripts/ci-smoke.sh`](scripts/ci-smoke.sh): it starts playback, checks the media session reaches PLAYING, sends the app to the background and checks it keeps playing. To run it locally with an emulator or a phone connected over adb:

```bash
npm run sync && (cd android && ./gradlew assembleDebug)
bash scripts/ci-smoke.sh android/app/build/outputs/apk/debug smoke
```

Screenshots and logcat end up in `smoke/`. YouTube often blocks datacenter IPs, so the script also plays a test tone that is bundled only in debug builds.

## Build types

| Build type | App | Signed with | Use |
|---|---|---|---|
| `debug` | CyberJuke (debuggable) | your machine's `~/.android/debug.keystore` | development, CI smoke test |
| `preview` | **CyberJuke Preview** (`io.github.iamandelib.cyberjuke.preview`), R8, not debuggable | the preview key (`PREVIEW_*` env vars), unsigned without them | the rolling `preview` pre-release |
| `release` | CyberJuke, R8, not debuggable | unsigned; the Release workflow signs with `apksigner` | GitHub releases and F-Droid |

No signing key is committed to this repository.

## Releases (maintainers)

### Before every stable release

A stable release gets a review of the **whole** app, not only of what changed since the last one:

- **UI/UX and function:** every screen and flow, all 8 themes at 360 px and 412 px, accessibility (labels, focus, 48 px targets).
- **Native and lifecycle:** playback service, plugins, process and renderer death, Android 7–15 differences, R8.
- **Code quality:** dead code (unused exports, files, CSS, icons, resources, dependencies), redundancy (duplicated logic worth merging, repeated literals), clean code (stale or misplaced comments, needless `eslint-disable`, casts, layering).
- **Release files and docs:** README, privacy tables, `docs/`, the F-Droid recipe.

Every finding is checked before it is acted on; a confirmed bug gets a fix and a test that fails without it. Then all gates pass (`npm run check`, the full Playwright suite twice, the JVM tests), CI is green including the emulator smoke test, and a Preview has been tried on a phone.

After publishing: verify the APK's checksum, signing certificate and version, run **Actions → Reproducible build check** on the tag, and move the F-Droid recipe to the new version.

### Publishing

1. Add a `## [x.y.z] - YYYY-MM-DD` section to `CHANGELOG.md` on `main` (move the Unreleased items into it).
2. Run **Actions → Release** with the version. It checks the version is higher than the one in `android/app/build.gradle` (or equal to it, for a version the tree already carries that has no tag yet), commits the bump (Gradle, `package.json`, and `fastlane/.../changelogs/<versionCode>.txt` if missing), builds an unsigned APK from that commit, then signs and publishes it in the protected `release` environment, tagging the commit `v<version>`.

versionCode is `major × 1,000,000 + minor × 1,000 + patch` (1.0.0 → 1000000, 1.2.3 → 1002003).

The release key secrets are `KEYSTORE_FILE` (base64), `KEYSTORE_PASSWORD`, `KEY_ALIAS` and `KEY_PASSWORD`; the preview key uses the same four names with a `PREVIEW_` prefix. They can be repository secrets, or live in the `release` and `preview` environments for extra protection (main only, a required reviewer for releases). Only the signing jobs read them. [`scripts/setup-publishing.sh`](scripts/setup-publishing.sh) can create the keys on the maintainer's computer and set the environments up; [`docs/PUBLISHING.md`](docs/PUBLISHING.md) is the step-by-step guide. The `main` branch must accept pushes from GitHub Actions for the bump commit.

### Preview builds

**Actions → Preview** builds `assemblePreview` unsigned with a read-only token, then signs it with `apksigner` in the `preview` environment and replaces the `preview` pre-release (`CyberJuke-preview.apk` + `.sha256`). The preview key is separate from the release key. [`docs/TESTING.md`](docs/TESTING.md) is the phone checklist for a preview.

Keep both `.jks` files and their passwords backed up outside the repository (`*.jks` is gitignored). Losing the preview key means preview users must uninstall once; losing the release key means nobody can update the app.

## Dependencies

- **Renovate** ([`.github/renovate.json`](.github/renovate.json)) proposes grouped updates every Monday, and NewPipeExtractor updates at any time. It needs the [Renovate GitHub App](https://github.com/apps/renovate) installed on the repository by its owner.
- **NewPipeExtractor** is pinned in `android/variables.gradle` (`newPipeExtractorVersion`) to the commit the NewPipe app ships. When YouTube breaks playback, updating it is usually the fix; the daily canary opens a `youtube-breakage` issue when that happens.
- **GitHub Actions** are pinned to full commit SHAs with a `# vX.Y.Z` comment. Keep it that way when adding one: `git ls-remote --tags https://github.com/<owner>/<action>` gives the SHA.
- **Gradle dependency verification:** run **Actions → Gradle verification metadata**, download the `verification-metadata` artifact and commit it as `android/gradle/verification-metadata.xml`. From then on, Gradle checks every dependency's SHA-256, and dependency updates need the file regenerated (the same workflow, or `./gradlew --write-verification-metadata sha256 help assembleDebug assemblePreview assembleRelease testDebugUnitTest`).
- The Gradle wrapper JAR is validated in CI, and `distributionSha256Sum` pins the Gradle distribution. When upgrading Gradle, take the checksum from <https://gradle.org/release-checksums/>.
- **TypeScript 7** has no JavaScript API yet, so ESLint's TypeScript parser runs on `@typescript/typescript6` (see the comment in `eslint.config.js`).

## Commit style

Look at `git log` for the tone. In short:

- Subject: `Area: what changed`, in the imperative or as a short description, under about 72 characters. Areas in use: `Player`, `Data`, `Stores`, `UI`, `Android`, `Tests`, `CI`, `Build`, `Release`, `Docs`, `F-Droid`, `Repo`, or a screen name (`Artist page`, `Settings`).
- Body: why, and anything a reviewer wouldn't see from the diff. Wrap at about 72 characters.
- One logical change per commit; keep `npm run check` passing on each.
- Don't commit build outputs, screenshots (`test-results/`), keystores or `google-services.json`.

## License

By contributing you agree that your contribution is licensed under the [GPL-3.0](LICENSE), like the rest of CyberJuke.
