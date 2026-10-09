#!/usr/bin/env bash
# Signs an unsigned release APK so that F-Droid can reproduce it: the zip layout AGP wrote is
# kept as is (--alignment-preserved), so its own unsigned build of the same tag plus this
# signature is byte for byte this APK. (By default apksigner re-pads stored entries, like
# assets/dexopt/baseline.prof, its own way, and the comparison fails.)
# Usage: KEYSTORE=... KEYSTORE_PASSWORD=... KEY_ALIAS=... KEY_PASSWORD=... sign-apk.sh IN OUT
set -euo pipefail
in=$1 out=$2
bt="$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)/"
# AGP aligns its output; re-aligning here would make a layout F-Droid's build doesn't have.
if ! "${bt}zipalign" -c -p 4 "$in" >/dev/null; then
  echo "::error::$in is not aligned: signing it as is would not be reproducible"; exit 1
fi
"${bt}apksigner" sign --alignment-preserved \
  --ks "$KEYSTORE" \
  --ks-pass env:KEYSTORE_PASSWORD \
  --ks-key-alias "$KEY_ALIAS" \
  --key-pass env:KEY_PASSWORD \
  --out "$out" \
  "$in"
"${bt}apksigner" verify --verbose --print-certs "$out"
