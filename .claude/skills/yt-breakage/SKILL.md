---
name: yt-breakage
description: Runbook for when YouTube playback, Global search, artist pages or lyrics break. The daily canary reports "broken", or a youtube-breakage issue arrives. Confirms the failure, bumps NewPipeExtractor to what the NewPipe app ships, and adapts YtCompat/YtMusic in a PR.
---

Follow **§5 YouTube breakage runbook** in `.claude/skills/steward/SKILL.md`, under its §0 guardrails.

Input: `$ARGUMENTS` can be an issue number or a canary run id. Otherwise, start from the open `youtube-breakage` issue and the latest `YouTube canary` run (`actions_list` on `canary.yml`).

1. Get the canary's classification first. `inconclusive` (bot-checked runner) and `infra` are not breakages: report and stop.
2. Pin down what broke: the failing test case in `YouTubeCanaryTest`, and the call it makes.
3. Find the NewPipeExtractor commit the latest NewPipe app release ships, and compare it with `newPipeExtractorVersion` in `android/variables.gradle`.
4. If an open Renovate NewPipeExtractor PR exists, review and extend it via `/deps`. Otherwise open a PR from a `claude/*` branch that:
   - bumps the pin;
   - adapts only `yt/YtCompat.kt` / `yt/YtMusic.kt` (and our own InnerTube parsing in `yt/` when that's what broke);
   - updates or adds the JVM tests and fixtures in `android/app/src/test/`;
   - adds a CHANGELOG `[Unreleased]` "Fixed" line.
5. Drive CI to green. Kotlin only builds in CI, so read the job logs carefully.
6. Tell the maintainer exactly what to run next:
   - **Actions → YouTube canary** (manually);
   - a Preview on a phone using docs/TESTING.md;
   - after merge, a patch release.

Comment on the breakage issue once, with the PR link.
