---
name: deps
description: Review CyberJuke dependency update PRs (Renovate groups, lockfile maintenance, NewPipeExtractor, GitHub Actions, Android toolchain) and leave one verdict comment each. Pass a PR number, or nothing to review every open PR labelled dependencies.
---

Follow **§4 Dependency updates** in `.claude/skills/steward/SKILL.md`, under its §0 guardrails. Never merge or approve.

Scope: `$ARGUMENTS` if given (a PR number). Otherwise, every open PR labelled `dependencies`.

For each PR:
1. Read the diff (`pull_request_read`) and work out the group and the version jumps.
2. Read the upstream release notes for each bumped package (WebFetch on the GitHub release or changelog). Note breaking changes, deprecations and security fixes that touch code this repo uses (`Grep` for the APIs).
3. Check CI on the head commit: web, e2e shards, android-unit, android, emulator. For a red job, read `get_job_logs` and find the root cause.
4. Apply the rules for the group from the §4 table: SHA ↔ tag for Actions, the Gradle checksum, Capacitor in lockstep, OkHttp on 4.x, and NewPipeExtractor matching what NewPipe ships.
5. If a fix is small and mechanical (e.g. an API rename), check out the branch, fix it, run `npm run check`, and push to the Renovate branch. Otherwise describe the fix.
6. Leave **one** verdict comment: **safe to merge** / **needs changes** / **hold**, with the evidence. End with the Claude Code footer.

Finish with a table: PR, group, verdict, reason.
