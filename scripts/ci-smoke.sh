#!/usr/bin/env bash
# CI smoke test for CyberJuke on an Android emulator.
#
# Usage: scripts/ci-smoke.sh <apk file or directory containing it> [output dir]
#
# 1. installs the APK and grants POST_NOTIFICATIONS
# 2. launches MainActivity with `--es autoplay latest` (web UI plays the latest track)
# 3. waits up to SMOKE_TIMEOUT seconds for the media session to report PLAYING (state=3)
# 4. screenshots, presses HOME, waits 30s, checks it is still PLAYING, screenshots the
#    notification shade
# 5. dumps logcat (full + filtered) into <output dir>/logs
#
# Exit code is non-zero if playback never reached PLAYING or stopped in the background.
set -uo pipefail

PKG="io.github.iamandelib.cyberjuke"
APK_ARG="${1:-apk}"
OUT="${2:-smoke}"
TIMEOUT="${SMOKE_TIMEOUT:-90}"
BACKGROUND_WAIT="${SMOKE_BACKGROUND_WAIT:-30}"
PLAYING_PATTERN='state=PlaybackState {state=3'

SHOTS="$OUT/shots"
LOGS="$OUT/logs"
mkdir -p "$SHOTS" "$LOGS"

log() { echo "[smoke $(date +%H:%M:%S)] $*"; }

summary() {
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then echo "$*" >> "$GITHUB_STEP_SUMMARY"; fi
}

if [[ -d "$APK_ARG" ]]; then
  APK="$(find "$APK_ARG" -name '*.apk' | sort | head -n 1)"
else
  APK="$APK_ARG"
fi
if [[ -z "$APK" || ! -f "$APK" ]]; then
  echo "::error::No APK found at '$APK_ARG'"
  exit 2
fi

# Our session's block of `dumpsys media_session` (falls back to the whole dump).
session_dump() {
  local dump
  dump="$(adb shell dumpsys media_session 2>/dev/null)"
  local ours
  ours="$(printf '%s\n' "$dump" | awk -v pkg="$PKG" '
    /package=/ { inpkg = index($0, "package=" pkg) > 0 }
    inpkg { print }')"
  if [[ -n "$ours" ]]; then printf '%s\n' "$ours"; else printf '%s\n' "$dump"; fi
}

is_playing() { session_dump | grep -qF "$PLAYING_PATTERN"; }

shot() {
  adb exec-out screencap -p > "$SHOTS/$1.png" 2>/dev/null || log "screenshot $1 failed"
}

collect_logs() {
  log "Collecting logs"
  adb shell dumpsys media_session > "$LOGS/dumpsys-media_session.txt" 2>&1 || true
  adb shell dumpsys activity services "$PKG" > "$LOGS/dumpsys-services.txt" 2>&1 || true
  adb logcat -d -v threadtime > "$LOGS/logcat-full.txt" 2>&1 || true
  grep -E 'CyberJuke|ExoPlayer|MediaCodec|AudioTrack|MediaSession|MediaController|NewPipe|schabi|Capacitor|chromium|Console|AndroidRuntime|FATAL|okhttp' \
    "$LOGS/logcat-full.txt" > "$LOGS/logcat-app.txt" || true
}

diagnose() {
  local f="$LOGS/logcat-full.txt"
  if grep -qE "BOT_CHECK|SignInConfirmNotBot|confirm you.?re not a bot|reCaptcha" "$f"; then
    local msg="YouTube blocked this runner as a bot ('Sign in to confirm you're not a bot' / reCAPTCHA). This is an IP block of GitHub runners, not necessarily an app bug."
    echo "::error title=YouTube bot check::$msg"
    summary "### :robot: YouTube bot check"
    summary "$msg"
    grep -E "BOT_CHECK|SignInConfirmNotBot|not a bot|reCaptcha" "$f" | head -n 5 | sed 's/^/    /'
  fi
  if grep -q "TRACK_ERROR" "$f"; then
    log "Track errors:"
    grep "TRACK_ERROR" "$f" | head -n 10 | sed 's/^/    /'
  fi
  if grep -q "FATAL EXCEPTION" "$f"; then
    echo "::error title=App crashed::FATAL EXCEPTION in logcat (see logs/logcat-full.txt)"
    grep -A 20 "FATAL EXCEPTION" "$f" | head -n 40
  fi
}

finish() {
  local code=$1 reason=$2
  collect_logs
  diagnose
  if [[ $code -eq 0 ]]; then
    log "PASS: $reason"
    summary "### :white_check_mark: Smoke test passed"
  else
    echo "::error title=Smoke test failed::$reason"
    summary "### :x: Smoke test failed"
  fi
  summary "$reason"
  exit "$code"
}

log "Waiting for device"
adb wait-for-device
for _ in $(seq 1 120); do
  [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]] && break
  sleep 1
done
adb shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
adb shell wm dismiss-keyguard >/dev/null 2>&1 || true
adb logcat -c || true

log "Installing $APK"
if ! adb install -r -g "$APK"; then
  finish 1 "adb install failed for $APK"
fi
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true

log "Launching with autoplay=latest"
adb shell am start -W -n "$PKG/.MainActivity" --es autoplay latest

log "Waiting up to ${TIMEOUT}s for PLAYING"
reached=0
for ((i = 1; i <= TIMEOUT; i++)); do
  if is_playing; then
    reached=1
    log "PLAYING after ${i}s"
    break
  fi
  if ((i % 15 == 0)); then
    log "still waiting (${i}s); current session state:"
    session_dump | grep -E "state=PlaybackState|metadata" | head -n 3 | sed 's/^/    /'
  fi
  sleep 1
done

shot 01-playing
if [[ $reached -ne 1 ]]; then
  finish 1 "Playback never reached PLAYING (state=3) within ${TIMEOUT}s"
fi

session_dump | grep -E "metadata|description" | head -n 3 | sed 's/^/    /'

log "Pressing HOME and waiting ${BACKGROUND_WAIT}s"
adb shell input keyevent KEYCODE_HOME
sleep "$BACKGROUND_WAIT"
shot 02-home
background_ok=0
if is_playing; then background_ok=1; fi

log "Opening notification shade"
adb shell cmd statusbar expand-notifications >/dev/null 2>&1 || true
sleep 3
shot 03-notification
adb shell cmd statusbar collapse >/dev/null 2>&1 || true

if [[ $background_ok -ne 1 ]]; then
  finish 1 "Playback stopped after ${BACKGROUND_WAIT}s in the background"
fi
finish 0 "Reached PLAYING and kept playing ${BACKGROUND_WAIT}s in the background"
