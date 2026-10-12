#!/bin/bash
# SessionStart hook for Claude Code cloud sessions: makes `npm run check` and
# `npm run e2e` work as soon as the session starts. Local sessions are left alone.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

# Reinstall only when package-lock.json changed since the last install, so a
# cached container starts at once. `npm ci --ignore-scripts` as in CI: no
# dependency needs an install script, and the lockfile is never rewritten.
stamp=node_modules/.cyberjuke-lock.sha256
want=$(sha256sum package-lock.json | cut -d' ' -f1)
if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$want" ]; then
  npm ci --ignore-scripts --no-audit --no-fund >&2
  echo "$want" > "$stamp"
fi

# playwright.config.ts picks up the sandbox Chromium in /opt/pw-browsers by itself.
if [ ! -x /opt/pw-browsers/chromium-1194/chrome-linux/chrome ] && [ -z "${PW_CHROMIUM_PATH:-}" ]; then
  echo "Note: no sandbox Chromium found; npm run e2e may need PW_CHROMIUM_PATH."
fi

if [ -z "${ANDROID_HOME:-}${ANDROID_SDK_ROOT:-}" ]; then
  echo "Note: no Android SDK here. Gradle builds, Kotlin tests and the emulator smoke test run in CI only."
fi
