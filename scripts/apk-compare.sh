#!/usr/bin/env bash
# F-Droid's reproducibility check: copies SIGNED's signature onto UNSIGNED and verifies the
# result (apksigcopier), which only passes when the two are the same APK apart from it.
# Usage: apk-compare.sh SIGNED UNSIGNED
set -euo pipefail
bt="$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)"
PATH="$bt:$PATH" pipx run 'apksigcopier==1.1.1' compare "$1" --unsigned "$2"
