#!/usr/bin/env bash
# JitPack builds a commit the first time anyone asks for it, and until that build is done
# Gradle gets "not found" (and may cache it). Ask for the pinned NewPipeExtractor POM first
# and wait for it, so a fresh pin (e.g. a Renovate bump) doesn't fail the first CI run.
set -euo pipefail
cd "$(dirname "$0")/.."
ver=$(sed -n "s/^ *newPipeExtractorVersion = '\([^']*\)'.*/\1/p" android/variables.gradle)
[ -n "$ver" ] || { echo "::error::newPipeExtractorVersion not found in android/variables.gradle"; exit 1; }
url="https://jitpack.io/com/github/TeamNewPipe/NewPipeExtractor/$ver/NewPipeExtractor-$ver.pom"
for i in $(seq 1 20); do
  if curl -sSf -o /dev/null -m 120 "$url"; then
    echo "JitPack has NewPipeExtractor $ver"
    exit 0
  fi
  echo "JitPack is still building NewPipeExtractor $ver (try $i/20)"
  sleep 30
done
echo "::warning::JitPack did not serve NewPipeExtractor $ver in time; Gradle will try anyway"
