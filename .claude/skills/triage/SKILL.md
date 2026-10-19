---
name: triage
description: Triage CyberJuke GitHub issues. Classify, dedupe, reproduce, and decide fix / needs-info / upstream / maintainer call. Pass an issue number, or nothing to triage every open issue with no comment from the maintainer or Claude yet.
---

Follow **§2 Intake and triage** in `.claude/skills/steward/SKILL.md`, under its §0 guardrails.

Scope: `$ARGUMENTS` if given (an issue number). Otherwise, every open issue that has no reply from the maintainer or from a Claude-generated comment.

For each issue:
1. Read the issue and all its comments (`issue_read`). Check for duplicates with `search_issues`, and check `## [Unreleased]` in CHANGELOG.md.
2. Reproduce it, or explain why it can't be reproduced here (device-only, needs the Android SDK).
3. Act on the decision table in §2:
   - a confirmed bug goes into the §3 change workflow;
   - a `youtube-breakage` issue goes to `/yt-breakage`;
   - anything security-like is never discussed publicly.
4. Comment only when it moves the issue forward, and end with the Claude Code footer.

Finish with a table for the maintainer: issue, classification, decision, next action or PR link, and anything waiting on them.
