---
name: steward
description: CyberJuke maintenance protocol. Use for any maintenance work on this repo, including triaging issues, fixing bugs, reviewing Renovate/dependency PRs, YouTube breakage, preparing or following up a release, and driving a PR to green. Defines the guardrails, the change workflow, the runbooks and the cadence.
---

# CyberJuke maintenance protocol

Project facts and invariants are in `CLAUDE.md`. This file says **how** maintenance is done. The task skills `/triage`, `/deps`, `/yt-breakage`, `/release-review` and `/sweep` each run one section of it.

## §0 Guardrails

- **PRs only.**
  - Work on a `claude/*` branch, or the branch the session assigns.
  - Never push to `main`. Never merge or approve a PR. Never force-push a branch someone else owns.
- **The maintainer only:**
  - running **Release**, **Preview**, **Reproducible build check** or **Gradle verification metadata**;
  - anything touching signing keys, environments or repository secrets;
  - closing issues as won't-fix;
  - publishing a security advisory.

  Prepare the work and ask.
- **Never weaken the gates:**
  - no skipped, deleted or loosened tests;
  - no `--max-warnings` changes;
  - no `continue-on-error` added to CI;
  - no hand-edited `verification-metadata.xml` or wrapper checksums.
- **Cross-boundary changes go together:**
  - the `src/player/native.ts` contract and `JukePlayerPlugin.kt`/`StateEncoder.kt`;
  - `tests/spec/queue-rules.json` and both queue implementations;
  - the two backup XMLs.
- **Security reports** never go into public issues, PR text or commit messages. Point reporters to SECURITY.md, and tell the maintainer privately in the session.
- **Verify before acting.** Treat every finding (yours, a bot's, a reviewer agent's) as a claim. Confirm it from code or a repro before changing anything.

## §1 Session start

1. Sync: `git fetch origin main`. Branch from `origin/main` unless continuing a PR branch.
2. Baseline: `npm run check`. If it is red on `main`, that is the first finding: report it and fix it in its own PR.
3. Look at the repo through the GitHub MCP tools:
   - open issues, newest first, and any open `youtube-breakage` issue;
   - open PRs, Renovate's included (label `dependencies`);
   - the last `ci.yml` run on `main` and the last few `canary.yml` runs (`actions_list`).
4. Decide what to work on from §2–§6. Tell the maintainer in one or two lines.

## §2 Intake and triage (`/triage`)

For each new or updated issue:

1. **Classify it** by its template label:
   - `bug`;
   - `enhancement`;
   - `youtube-breakage` (go to §5);
   - security, or anything that looks like one (§0).
2. **Check for duplicates** with `search_issues` (open and closed), and check whether it's already fixed on `main` (CHANGELOG `[Unreleased]`, `git log`).
3. **Reproduce:**
   - Web/UI: write a failing Vitest or Playwright test, or use `npm run dev` / `npm run screenshots`.
   - Native: read the Kotlin path and look for an existing JVM test to extend. Device-only symptoms go to the maintainer with a docs/TESTING.md step to try.
4. **Decide**, and leave one comment with the footer:

   | Outcome | Action |
   |---|---|
   | Confirmed, in scope | Fix via §3 and link the PR. |
   | Missing info | Ask for exactly what's missing: app version (Settings → About), the Connection line, IPv4 setting, network, steps. |
   | Upstream | Say where it belongs (NewPipe/NewPipeExtractor, Cyberspace) and why. |
   | Feature idea | Check it against the scope (Jukebox first, no "YouTube Music" branding, no tracking). Summarise it for the maintainer, who decides. |

Don't comment just to acknowledge. Comment only when it moves the issue forward.

## §3 Change workflow

1. **Branch** from `origin/main`.
2. **Write a failing test first** where possible:
   - Vitest next to the code;
   - Playwright in `tests/e2e/` using `tests/fixtures`;
   - Kotlin in `android/app/src/test/` (proved by CI).
3. **Research, then make the minimal fix.** First look for how others already solve it (Media3/Android docs and samples, NewPipe and other open-source players, established web patterns) and follow the proven approach; keep it simple and don't reinvent the wheel. Name the source in the PR. Respect the layers, the invariants in CLAUDE.md, and the style of the surrounding code (comment density, naming).
4. **Run the local gates:**
   - always `npm run check`;
   - `npm run e2e` when UI, stores, player or data change;
   - `npm run screenshots` and a look at the result for visual changes (8 themes; 360 and 412 px matter).
5. **Self-review.** Run `/code-review` on the diff. For larger changes, also use the project agents:
   - `web-reviewer` for `src/`;
   - `android-reviewer` for `android/`;
   - `privacy-security-reviewer` for data flows, storage, logging, auth, WebView, workflows or scripts.

   Verify their findings (§0) before acting.
6. **Update the docs:**
   - user-visible change: a line in CHANGELOG `## [Unreleased]`;
   - data-flow change: the README privacy/network tables;
   - build/release change: CONTRIBUTING and docs/.
7. **Commit** in house style (`Area: what changed`, the body says why). Push with `git push -u origin <branch>`.
8. **Open the PR** with the template's sections filled honestly:
   - tick only what was actually run;
   - say plainly that Android builds and the smoke test are left to CI.
9. **Subscribe** to PR activity and drive CI to green. Read failing job logs (`get_job_logs`) and fix the root cause. Flakes get at most one re-run.

## §4 Dependency updates (`/deps`)

Renovate opens grouped PRs early on Monday (UTC), lockfile maintenance on the 1st of each month, and NewPipeExtractor at any time. For each PR:

1. Read the upstream release notes for every bumped package, looking for breaking changes, deprecations and security fixes.
2. Check CI on the PR head: web, e2e shards, android-unit, android, **emulator smoke**.
3. Apply the rules for the group:

   | Group | Rules |
   |---|---|
   | Capacitor | Core, CLI, android and plugins stay on the same minor. Check the generated `android/` files still match a `cap sync` (CI's `npx cap sync android` covers this). Read the Capacitor Android upgrade guide for majors. |
   | Preact / ESLint / Web build tooling | Majors need a code read for API changes. ESLint: when typescript-eslint supports TS 7, propose removing the `@typescript/typescript6` resolve hook (eslint.config.js header, issue typescript-eslint#10940). |
   | GitHub Actions | The SHA must match the tag (`git ls-remote --tags`), with the `# vX.Y.Z` comment kept. |
   | Android toolchain (AGP, Kotlin, Gradle) | These move together. Gradle's `distributionSha256Sum` must equal gradle.org's published checksum. compileSdk changes affect the OkHttp pin (stays on 4.x until compileSdk 37 is supported). |
   | Media3 / AndroidX | Read the release notes for playback, session and notification behaviour changes. The emulator smoke test must pass. |
   | NewPipeExtractor | §5 rules: the commit must be one the NewPipe app ships. |

4. Leave **one** verdict comment, using the footer:
   - safe to merge;
   - needs changes, then push the fix to the Renovate branch only if it's small and mechanical, otherwise describe it;
   - hold, with the reason.

   The maintainer merges.

If `android/gradle/verification-metadata.xml` is ever committed, dependency PRs also need it regenerated. Ask the maintainer to run **Actions → Gradle verification metadata** and commit the artifact.

## §5 YouTube breakage runbook (`/yt-breakage`)

**Triggers:**
- the daily canary (`canary.yml`, 05:17 UTC) classifies `broken` and opens or updates a `youtube-breakage` issue;
- a user files "Tracks stopped playing".

`inconclusive` (the runner was bot-checked) and `infra` are **not** breakages: note them and don't open a fix PR.

1. **Confirm the failure** from the canary run's `canary-report` artifact or job log: which call broke (stream resolve, music search, artist page, lyrics).
2. **Find what NewPipe ships.** Look up the NewPipeExtractor commit or tag the current NewPipe app release uses (its `app/build.gradle` or version catalog on GitHub). Prefer that over the extractor's latest `dev`.
3. **Branch and bump** `newPipeExtractorVersion` in `android/variables.gradle`. If a Renovate PR already does this, review it under §4 instead.
4. **Adapt only `yt/YtCompat.kt` / `yt/YtMusic.kt`** to API changes, plus `InnerTube*`/`ArtistPage` for our own InnerTube parsing. Extend the JVM tests with the new fixture shape.
5. **CI proves it:** android-unit and android jobs, and the emulator smoke test, which uses a bundled tone and so doesn't prove YouTube.
6. **Ask the maintainer** to:
   - run **Actions → YouTube canary** on the branch, or after merge;
   - try a Preview on a phone (docs/TESTING.md, playback and Global sections).
7. **After merge, a patch release is usually warranted** (§6, with a lighter review scope agreed with the maintainer). Close the breakage issue once the release is out.

## §6 Release runbook (`/release-review`)

**Before a stable release**, run a whole-app review, not just a diff (CONTRIBUTING → "Before every stable release"):

1. Fan out in parallel to the project agents:
   - `web-reviewer`: every screen and flow; a11y; 8 themes at 360/412 px from `npm run screenshots`;
   - `android-reviewer`: playback service, plugins, process/renderer death, Android 7–15, R8;
   - `privacy-security-reviewer`;
   - `release-auditor`: dead code, redundancy, docs, README, privacy tables, fastlane, F-Droid recipe.
2. Verify every finding. Each confirmed bug gets a fix and a failing-first test, in focused PRs (§3).
3. Gates:
   - `npm run check`;
   - `npm run e2e` **twice**;
   - CI green including android-unit and the emulator smoke test;
   - the maintainer has tried a Preview on a phone.
4. Draft the `## [x.y.z] - YYYY-MM-DD` CHANGELOG section from `[Unreleased]`, in a PR. The fastlane changelog is written by the Release workflow; it has a 500-character limit, so keep the section's essence short enough.

**Publishing:** the maintainer runs **Actions → Release** with the version. versionCode = major×1,000,000 + minor×1,000 + patch.

**After publishing:**
1. Verify the release:
   - download it with `gh release download`; the APK's `.sha256` must match;
   - versionName and versionCode must be right;
   - the signing certificate digest must equal the one in README → "Verifying a release APK".

   `apksigner` needs Android build-tools, so if it isn't available, ask the maintainer for that one check.
2. Ask the maintainer to run **Actions → Reproducible build check** on the tag.
3. Open a PR moving `docs/fdroid/io.github.iamandelib.cyberjuke.yml` to the new version, versionCode and commit. Keep the `fdroid rewritemeta` format with no comments and only the newest build.

## §7 Cadence

| When | What | How |
|---|---|---|
| Daily | The YouTube canary runs and opens or updates `youtube-breakage` | Automatic; §5 when it fires |
| Weekly, Monday after Renovate | §1 → §2 → §4, then a status report | `/sweep`, run by the weekly routine |
| Monthly | Lockfile maintenance PR (§4); a dead-code / redundancy pass with `release-auditor` | `/deps`, then the agent |
| Per release | §6 | `/release-review` |
| Per PR event | Drive to green; answer reviews | §3 step 9 |

## §8 Known follow-ups

Backlog, each to be done as its own PR when the maintainer agrees:

- `android/gradle/verification-metadata.xml` isn't committed, so Gradle dependency verification is off. Generating it needs the maintainer to run the workflow.
- Rule tags in code comments (R1, S1, P1, L4/L5/L7, K1, C2, H1, Y3/Y4, AP3) have no index. A short `docs/RULES.md` would help reviewers.
- The canary, gradle-verification and screenshots workflows use Node `'22'`, while the others pin `22.22.0`.

Remove items here as they're done.
