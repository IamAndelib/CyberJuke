#!/usr/bin/env bash
# Runs ./gradlew (from android/) and retries when only a JitPack artifact couldn't be found.
# JitPack builds a commit on first request and its edges can answer "not found" for a while;
# Gradle then remembers the miss, so the retry also passes --refresh-dependencies.
# Usage (from android/): bash ../scripts/gradlew-retry.sh <gradle args...>
set -uo pipefail
log=$(mktemp)
for attempt in 1 2 3; do
  extra=()
  [ "$attempt" -gt 1 ] && extra=(--refresh-dependencies)
  ./gradlew "$@" "${extra[@]}" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  [ "$status" -eq 0 ] && exit 0
  grep -q 'Could not find com\.github\.' "$log" || exit "$status"
  [ "$attempt" -lt 3 ] && { echo "::warning::JitPack artifact not found (attempt $attempt); retrying in 90s"; sleep 90; }
done
exit "$status"
