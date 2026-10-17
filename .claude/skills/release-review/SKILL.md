---
name: release-review
description: Prepare a CyberJuke stable release. Run the whole-app review (UI/UX in all themes, native lifecycle, privacy/security, dead code and docs) with the project reviewer agents, verify the findings, run the gates and draft the CHANGELOG section. Also covers the after-publish checks and the F-Droid recipe bump. Pass the target version, or "after vX.Y.Z" for the post-publish steps.
---

Follow **§6 Release runbook** in `.claude/skills/steward/SKILL.md`, under its §0 guardrails. The maintainer runs the Release workflow, never Claude.

**Before release** (`$ARGUMENTS` = target version, e.g. `1.2.0`):
1. Prepare the review:
   - `git fetch origin main`, then `git log v<last>..origin/main` and the CHANGELOG `[Unreleased]` section;
   - `npm run screenshots` (it renders every screen in every theme into `test-results/screenshots/`).
2. Launch these agents **in parallel**, each on the whole app, not just the diff:
   - `web-reviewer` (with the screenshot directory);
   - `android-reviewer`;
   - `privacy-security-reviewer`;
   - `release-auditor` (with the target version).
3. Verify every finding yourself. Drop what doesn't hold up, and say why in the summary.
4. Group the confirmed findings into focused PRs (§3). Each bug gets a test that fails without the fix.
5. Run the gates:
   - `npm run check`;
   - `npm run e2e` twice (both must pass);
   - CI green on `main`, including android-unit and emulator.
6. Open a PR that moves `[Unreleased]` into `## [<version>] - <date>`, in the CHANGELOG's own user-facing tone.
7. Tell the maintainer what's left:
   - try a Preview on a phone (docs/TESTING.md);
   - merge the PRs;
   - run **Actions → Release** with `<version>`.

**After publishing** (`$ARGUMENTS` = `after vX.Y.Z`):
1. Verify the release (§6 "After publishing", step 1).
2. Ask the maintainer to run **Actions → Reproducible build check** on the tag.
3. Open the F-Droid recipe PR for `docs/fdroid/io.github.iamandelib.cyberjuke.yml`:
   - versionName, versionCode and commit for the new tag;
   - rewritemeta format, no comments, only the newest build.
