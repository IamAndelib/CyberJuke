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
# Phase 3 (soft, debug builds) runs one YouTube Music search through NewPipeExtractor via
# `--es ci_music_search "<query>"` and reports the logged result count. It never fails the job.
# Phase 4 (soft, debug builds) resolves artist candidates (`--es ci_artist`) and looks up one
# song's lyrics (`--es ci_lyrics "artist|title|durationSec"`). Annotations only, never fails.
# Phase 5 (soft, debug builds) loads one YouTube Music artist page (`--es ci_artist_page
# "<channel id>"`) and reports its counts per shelf (songs, albums, live, EPs, singles).
#
# Also checked (debug builds log these at info/verbose level; R8 strips them from release):
# - Web -> native bridge (hard): the web UI's boot call to JukePlayer.getLaunchOptions must
#   reach native code (`BRIDGE getLaunchOptions`). This is what breaks if the CSP in
#   index.html ever blocks Capacitor's bridge injection (old WebViews inject it inline).
# - No state ticks in the background (soft): the plugin's 1 s state ticker logs `tick` under
#   CyberJukeTick; while the app is in the background (HOME) the count must not grow.
# - MediaSession controllers (soft): lists who connected and with which access (FULL or
#   TRANSPORT, see SessionPolicy). A second app's controller is not exercised: that needs a
#   separate test APK, which this repo does not build.
set -uo pipefail

PKG="io.github.iamandelib.cyberjuke"
APK_ARG="${1:-apk}"
OUT="${2:-smoke}"
TIMEOUT="${SMOKE_TIMEOUT:-90}"
BACKGROUND_WAIT="${SMOKE_BACKGROUND_WAIT:-30}"
# Android prints the media session state as e.g. "state=PlaybackState {state=3, position=..."
# but the exact rendering has changed between releases, so accept the known shapes.
PLAYING_REGEX='state=(PlaybackState \{state=)?(3|PLAYING)[(,)} ]'

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
# The web UI calls getLaunchOptions at boot: if that never reaches native code, the Capacitor
# bridge is broken (e.g. the CSP blocked its injected script). Debug builds only (Log.i).
if grep -q "BRIDGE getLaunchOptions" "$P1"; then
  log "Bridge: web -> native call received (getLaunchOptions)"
  summary "### :white_check_mark: Web -> native bridge works (getLaunchOptions reached native code)"
else
  diagnostics
  finish 1 "The web UI never called JukePlayer.getLaunchOptions: the Capacitor bridge is not working (CSP blocking the bridge script? JS crash at boot?)"
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

tick_count() { # state ticks logged so far (capture, then count)
  local t
  t="$(adb logcat -d -v brief -s CyberJukeTick:V 2>/dev/null)"
  grep -c "tick" <<<"$t" || true
}
sleep 5
ticks_fg="$(tick_count)"
log "Pressing HOME and waiting ${BACKGROUND_WAIT}s"
adb shell input keyevent KEYCODE_HOME
sleep 3 # let onPause land; a tick already queued may still fire
ticks_bg_start="$(tick_count)"
sleep "$BACKGROUND_WAIT"
ticks_bg_end="$(tick_count)"
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

# ---- Soft: no state ticks while backgrounded (P1) ------------------------------------------
ticks_bg=$((ticks_bg_end - ticks_bg_start))
ticker="not verified"
if ((ticks_fg == 0)); then
  echo "::warning title=Background ticks not verified::No foreground state ticks were logged (is this a debug build?)"
  summary "### :warning: Background ticks: not verified (no foreground ticks logged)"
elif ((ticks_bg == 0)); then
  ticker="pass"
  echo "::notice title=No background ticks::${ticks_fg} ticks in the foreground, 0 during ${BACKGROUND_WAIT}s in the background"
  summary "### :white_check_mark: No state ticks while in the background (${ticks_fg} in the foreground)"
else
  ticker="failed"
  echo "::warning title=State ticks in the background::${ticks_bg} ticks during ${BACKGROUND_WAIT}s in the background (expected 0)"
  summary "### :warning: ${ticks_bg} state ticks while in the background (expected 0)"
fi
log "Background ticks: ${ticker} (foreground ${ticks_fg}, background ${ticks_bg})"

# ---- Soft: who connected to the MediaSession, with which access (S1) -----------------------
controllers="$(adb logcat -d -v brief -s CyberJukeService:V 2>/dev/null | grep -oE "Controller [^ ]+ uid=[0-9-]+ access=[A-Z]+" | sort -u)"
if [[ -n "$controllers" ]]; then
  log "MediaSession controllers:"
  sed 's/^/    /' <<<"$controllers"
  summary "### MediaSession controllers"
  while IFS= read -r line; do summary "- \`$line\`"; done <<<"$controllers"
  full_others="$(grep -E "access=FULL" <<<"$controllers" | grep -vE "Controller ($PKG|com\.android\.systemui|android|com\.android\.shell) " || true)"
  if [[ -n "$full_others" ]]; then
    echo "::notice title=MediaSession access::Another package got FULL access (check it is a system controller): ${full_others//$'\n'/; }"
  fi
else
  summary "### :warning: MediaSession controllers: no connection logged (is this a debug build?)"
fi

# ---- Phase 3 (soft): YouTube Music search (MusicPlugin CI hook, debug builds only) ----------
# Annotations only: a bot check, an error or a timeout is a warning, never a failure.
MUSIC_QUERY="${SMOKE_MUSIC_QUERY:-daft punk}"
MUSIC_TIMEOUT="${SMOKE_MUSIC_TIMEOUT:-30}"
music="not verified"
log "Phase 3 (soft): YouTube Music search '$MUSIC_QUERY'"
adb shell am force-stop "$PKG" >/dev/null 2>&1 || true
sleep 2
# adb shell re-parses the command on the device, so quote the query for the remote shell.
adb shell am start -W -n "$PKG/.MainActivity" --es ci_music_search "\"$MUSIC_QUERY\"" >/dev/null 2>&1 || true
music_line=""
for ((i = 1; i <= MUSIC_TIMEOUT; i++)); do
  music_logs="$(adb logcat -d -v brief -s CyberJukeMusic:V 2>/dev/null)"
  music_line="$(grep -E "CI search '.*' (->|failed)" <<<"$music_logs" | tail -n 1)"
  [[ -n "$music_line" ]] && break
  sleep 1
done
music_line="${music_line//$'\r'/}"
music_msg="${music_line#*CyberJukeMusic*: }"
if [[ -z "$music_line" ]]; then
  echo "::warning title=YouTube Music search not verified::No 'CI search' log line within ${MUSIC_TIMEOUT}s (is this a debug build?)"
  summary "### :warning: YouTube Music search: no result within ${MUSIC_TIMEOUT}s"
elif [[ "$music_line" =~ \-\>\ ([0-9]+)\ items ]]; then
  n="${BASH_REMATCH[1]}"
  if ((n > 0)); then
    music="pass ($n items)"
    echo "::notice title=YouTube Music search::$music_msg"
    summary "### :white_check_mark: YouTube Music search: $n items"
  else
    music="0 items"
    echo "::warning title=YouTube Music search returned nothing::$music_msg"
    summary "### :warning: YouTube Music search returned 0 items"
  fi
elif [[ "$music_line" == *BOT_CHECK* ]]; then
  music="bot-check"
  echo "::warning title=YouTube Music search: bot check::$music_msg"
  summary "### :robot: YouTube Music search: bot check (runner IP), not verified"
else
  music="failed"
  echo "::warning title=YouTube Music search failed::$music_msg"
  summary "### :warning: YouTube Music search failed"
  summary "$music_msg"
fi
log "Phase 3: ${music}${music_line:+ ($music_line)}"

# ---- Phase 4 (soft): artist channel resolution + lyrics (MusicPlugin CI hooks) -------------
# Annotations only: ::notice on success, ::warning otherwise; never fails the job.
# Waits for the first `CI <kind> '...' (->|failed)` line of tag CyberJukeMusic; capture, then grep.
ci_hook_line() { # <kind> <timeout>
  local kind="$1" timeout="$2" logs line=""
  for ((i = 1; i <= timeout; i++)); do
    logs="$(adb logcat -d -v brief -s CyberJukeMusic:V 2>/dev/null)"
    line="$(grep -E "CI $kind '.*' (->|failed)" <<<"$logs" | tail -n 1)"
    [[ -n "$line" ]] && break
    sleep 1
  done
  line="${line//$'\r'/}"
  printf '%s' "$line"
}

ARTIST_QUERY="${SMOKE_ARTIST_QUERY:-Queen}"
LYRICS_QUERY="${SMOKE_LYRICS_QUERY:-Queen|Bohemian Rhapsody|354}"
SOFT_TIMEOUT="${SMOKE_SOFT_TIMEOUT:-45}"
artist_res="not verified"
lyrics_res="not verified"
log "Phase 4 (soft): artist '$ARTIST_QUERY', lyrics '$LYRICS_QUERY'"
adb shell am force-stop "$PKG" >/dev/null 2>&1 || true
sleep 2
adb shell am start -W -n "$PKG/.MainActivity" --es ci_artist "\"$ARTIST_QUERY\"" \
  --es ci_lyrics "\"$LYRICS_QUERY\"" >/dev/null 2>&1 || true

artist_line="$(ci_hook_line artist "$SOFT_TIMEOUT")"
artist_msg="${artist_line#*CyberJukeMusic*: }"
if [[ -z "$artist_line" ]]; then
  echo "::warning title=Artist resolution not verified::No 'CI artist' log line within ${SOFT_TIMEOUT}s (is this a debug build?)"
  summary "### :warning: Artist resolution: no result within ${SOFT_TIMEOUT}s"
elif [[ "$artist_line" =~ \-\>\ ([0-9]+)\ candidates ]] && ((BASH_REMATCH[1] > 0)); then
  artist_res="pass (${BASH_REMATCH[1]} candidates)"
  echo "::notice title=Artist resolution::$artist_msg"
  summary "### :white_check_mark: Artist resolution: $artist_msg"
else
  artist_res="failed"
  echo "::warning title=Artist resolution not verified::$artist_msg"
  summary "### :warning: Artist resolution: $artist_msg"
fi
log "Phase 4 artist: ${artist_res}${artist_line:+ ($artist_line)}"

lyrics_line="$(ci_hook_line lyrics "$SOFT_TIMEOUT")"
lyrics_msg="${lyrics_line#*CyberJukeMusic*: }"
if [[ -z "$lyrics_line" ]]; then
  echo "::warning title=Lyrics not verified::No 'CI lyrics' log line within ${SOFT_TIMEOUT}s (is this a debug build?)"
  summary "### :warning: Lyrics: no result within ${SOFT_TIMEOUT}s"
elif [[ "$lyrics_line" == *"-> source="* ]]; then
  lyrics_res="pass"
  echo "::notice title=Lyrics::$lyrics_msg"
  summary "### :white_check_mark: Lyrics: $lyrics_msg"
else
  lyrics_res="failed"
  echo "::warning title=Lyrics not verified::$lyrics_msg"
  summary "### :warning: Lyrics: $lyrics_msg"
fi
log "Phase 4 lyrics: ${lyrics_res}${lyrics_line:+ ($lyrics_line)}"

# ---- Phase 5 (soft): artist page (InnerTube browse, MusicPlugin CI hook) ------------------
# Annotations only: ::notice when the page has songs or releases, ::warning otherwise.
ARTIST_PAGE_ID="${SMOKE_ARTIST_PAGE_ID:-UCEPMVbUzImPl4p8k4LkGevA}"
artist_page_res="not verified"
log "Phase 5 (soft): artist page '$ARTIST_PAGE_ID'"
adb shell am force-stop "$PKG" >/dev/null 2>&1 || true
sleep 2
adb shell am start -W -n "$PKG/.MainActivity" --es ci_artist_page "\"$ARTIST_PAGE_ID\"" >/dev/null 2>&1 || true

page_line="$(ci_hook_line artistPage "$SOFT_TIMEOUT")"
page_msg="${page_line#*CyberJukeMusic*: }"
page_total=0
for k in songs album live ep single; do
  if [[ "$page_line" =~ [[:space:]]$k=([0-9]+) ]]; then page_total=$((page_total + BASH_REMATCH[1])); fi
done
if [[ -z "$page_line" ]]; then
  echo "::warning title=Artist page not verified::No 'CI artistPage' log line within ${SOFT_TIMEOUT}s (is this a debug build?)"
  summary "### :warning: Artist page: no result within ${SOFT_TIMEOUT}s"
elif [[ "$page_line" == *"' -> "* ]] && ((page_total > 0)); then
  artist_page_res="pass"
  echo "::notice title=Artist page::$page_msg"
  summary "### :white_check_mark: Artist page: $page_msg"
else
  artist_page_res="failed"
  echo "::warning title=Artist page not verified::$page_msg"
  summary "### :warning: Artist page: $page_msg"
fi
log "Phase 5 artist page: ${artist_page_res}${page_line:+ ($page_line)}"

finish 0 "Pipeline: PLAYING and still PLAYING after ${BACKGROUND_WAIT}s in the background. Bridge: ok. Background ticks: ${ticker}. Live YouTube: ${live}. YouTube Music search: ${music}. Artist: ${artist_res}. Lyrics: ${lyrics_res}. Artist page: ${artist_page_res}"
