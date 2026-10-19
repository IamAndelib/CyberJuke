---
name: sweep
description: The weekly CyberJuke maintenance sweep (run by the Monday routine, or by hand). Baseline check, CI and canary health, issue triage, dependency PR review, then a short status report. Opens PRs, never merges.
---

Run these sections of `.claude/skills/steward/SKILL.md` in order, under its §0 guardrails:

1. **§1 Session start.**
   - Run `npm run check` on `origin/main`.
   - Read the last `CI` run on `main` and the last 7 `YouTube canary` runs (count broken / inconclusive / infra / ok).
   - List open issues and PRs.
2. **Fix a red `main`.** If `main` is red (locally or in CI), find the root cause and open a fix PR first.
3. **`/triage`** every issue opened or updated since the last sweep.
4. **`/deps`** every open `dependencies` PR.
5. **Breakage.** If the canary reported `broken`, or a `youtube-breakage` issue is open with no PR, run `/yt-breakage`.
6. **Housekeeping.** Check open `claude/*` PRs from earlier sessions and drive them (CI, review comments, merge conflicts). Push nothing to `main`.
7. **On the first Monday of a month**, also run the `release-auditor` agent for a dead-code / redundancy / docs-drift pass, and open PRs for confirmed items. Each item gets one PR.

**Report.** End with a short status, the session's final message, in this shape:

```
CyberJuke weekly sweep: <date>
main: check ✅/❌ · CI ✅/❌ · canary 7d: <ok>/<inconclusive>/<broken>/<infra>
Issues: <n> triaged (<links + one-line decision each>)
Dependency PRs: <PR link: verdict>
PRs opened/updated: <links>
Waiting on maintainer: <merges, workflow runs, decisions>, or "nothing"
```

If nothing changed since the last sweep and everything is green, say so in one line.
