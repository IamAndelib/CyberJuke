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
# Phase 1 plays the latest live track (a YouTube bot check on the runner IP is only a warning).
# Phase 2 plays a bundled test tone (debug builds) and must reach PLAYING and keep playing in
# the background; otherwise the exit code is non-zero.
set -uo pipefail

PKG="io.github.iamandelib.cyberjuke"
APK_ARG="${1:-apk}"
OUT="${2:-smoke}"
TIMEOUT="${SMOKE_TIMEOUT:-90}"
BACKGROUND_WAIT="${SMOKE_BACKGROUND_WAIT:-30}"
# Android prints the media session state as e.g. "state=PlaybackState {state=3, position=..."
# but the exact rendering has changed between releases, so accept the known shapes.
PLAYING_REGEX='state=(PlaybackState \{state=)?(3|PLAYING)[,)} ]'

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

# Capture first, then grep: with `set -o pipefail`, `producer | grep -q` reports failure when
# grep exits early on a match and the producer dies of SIGPIPE.
is_playing() {
  local dump
  dump="$(session_dump)"
  grep -qE "$PLAYING_REGEX" <<<"$dump"
}

# Print a block into the job log AND as a GitHub annotation (artifacts are not always
# reachable, so failures must be readable from the annotation alone).
annotate_file() { # $1 = title, $2 = file
  local msg
  msg=$(sed -e 's/%/%25/g' -e 's/\r//g' "$2" | sed -e ':a;N;$!ba;s/\n/%0A/g')
  echo "::error title=$1::$msg"
}

diagnostics() { # collect the state that explains a playback failure
  local f="$LOGS/diagnostics.txt"
  {
    echo "--- media session state lines"
    session_dump | grep -E "state=|package=|active=" | head -n 12
    echo "--- services"
    adb shell dumpsys activity services "$PKG" 2>&1 | grep -E "ServiceRecord|started=|foreground" | head -n 8
    echo "--- app logcat (tail)"
    adb logcat -d -v brief 2>/dev/null \
      | grep -E 'CyberJuke|ExoPlayer|MediaSession|MediaCodec|AudioTrack|Capacitor|chromium|AndroidRuntime|FATAL' \
      | tail -n 45
  } > "$f" 2>&1
  cat "$f"
  annotate_file "Playback diagnostics" "$f"
}

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
    echo "::notice title=YouTube bot check::$msg"
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

wait_playing() { # $1 = timeout seconds; returns 0 once PLAYING
  local t=$1 i
  for ((i = 1; i <= t; i++)); do
    if is_playing; then log "PLAYING after ${i}s"; return 0; fi
    if ((i % 15 == 0)); then
      log "still waiting (${i}s); current session state:"
      session_dump | grep -E "state=PlaybackState|metadata" | head -n 3 | sed 's/^/    /'
    fi
    sleep 1
  done
  return 1
}

# ---- Phase 1: live path (web UI -> plugin -> NewPipeExtractor -> YouTube) -----------------
# YouTube often answers GitHub runner IPs with "Sign in to confirm you're not a bot", so this
# phase only fails the job if the app itself is broken (no resolve attempt, crash, or a
# non-bot-check error). A bot check is reported as a warning.
log "Phase 1: launching with autoplay=latest (live YouTube)"
adb shell am start -W -n "$PKG/.MainActivity" --es autoplay latest
live="fail"
if wait_playing "$TIMEOUT"; then live="pass"; fi
shot 01-live
adb logcat -d -v threadtime > "$LOGS/logcat-phase1.txt" 2>&1 || true
P1="$LOGS/logcat-phase1.txt"
if grep -q "FATAL EXCEPTION" "$P1"; then
  grep -A 20 "FATAL EXCEPTION" "$P1" | head -n 40
  finish 1 "App crashed during the live phase"
fi
if [[ $live != "pass" ]]; then
  if ! grep -q "resolve(" "$P1"; then
    finish 1 "Live phase: the web UI never asked the native player to resolve a track (autoplay wiring broken?)"
  elif grep -qE "BOT_CHECK|SignInConfirmNotBot|not a bot|reCaptcha" "$P1"; then
    live="bot-check"
    msg="YouTube answered this runner with a bot check, so live playback could not be verified here. The web -> native -> resolver path did run (see logs)."
    echo "::warning title=Live YouTube playback not verified::$msg"
    summary "### :robot: Live YouTube: bot check (runner IP), not verified"
    grep -E "resolve\(|BOT_CHECK" "$P1" | head -n 3 | sed 's/^/    /'
  else
    diagnostics
    finish 1 "Live phase: playback never reached PLAYING and it was not a YouTube bot check"
  fi
else
  summary "### :white_check_mark: Live YouTube playback reached PLAYING"
fi

# ---- Phase 2: playback pipeline with the bundled CI tone (must pass) -----------------------
# The tone only exists in debug builds (src/debug/assets); if packaging dropped it, say so
# plainly rather than reporting a broken player.
unzip -l "$APK" > "$LOGS/apk-contents.txt" 2>&1 || true
if ! grep -q "assets/ci-tone.ogg" "$LOGS/apk-contents.txt"; then
  finish 1 "The APK does not contain assets/ci-tone.ogg (debug asset was not packaged)"
fi

log "Phase 2: restarting with autoplay=ci-tone (bundled test tone, debug builds only)"
adb shell am force-stop "$PKG"
sleep 2
adb shell am start -W -n "$PKG/.MainActivity" --es autoplay ci-tone
if ! wait_playing "$TIMEOUT"; then
  shot 02-ci-tone
  diagnostics
  finish 1 "CI tone never reached PLAYING (state=3) within ${TIMEOUT}s: playback service/session is broken"
fi
shot 02-ci-tone
session_dump | grep -E "metadata|description" | head -n 3 | sed 's/^/    /'

log "Pressing HOME and waiting ${BACKGROUND_WAIT}s"
adb shell input keyevent KEYCODE_HOME
sleep "$BACKGROUND_WAIT"
shot 03-home
background_ok=0
if is_playing; then background_ok=1; fi

log "Opening notification shade"
adb shell cmd statusbar expand-notifications >/dev/null 2>&1 || true
sleep 3
shot 04-notification
adb shell cmd statusbar collapse >/dev/null 2>&1 || true

if [[ $background_ok -ne 1 ]]; then
  diagnostics
  finish 1 "Playback stopped after ${BACKGROUND_WAIT}s in the background"
fi
finish 0 "Pipeline: PLAYING and still PLAYING after ${BACKGROUND_WAIT}s in the background. Live YouTube: ${live}"
