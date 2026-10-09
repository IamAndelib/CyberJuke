#!/usr/bin/env bash
# One-time publishing setup for CyberJuke, run on the maintainer's own computer.
# See docs/PUBLISHING.md.
#
# It creates the preview and release signing keys (only if they don't exist yet), sets up
# the protected "preview" and "release" GitHub environments, stores the keys in them as
# secrets, prints the release certificate fingerprint F-Droid needs, and starts the
# "CyberJuke Preview" test build. Safe to run again: whatever is done already is skipped.
#
# Needs: bash, Java's keytool (JDK 17+), the GitHub CLI (gh) logged in as the repo owner.
#
# Usage: bash scripts/setup-publishing.sh [--repo OWNER/NAME] [--keys-dir DIR] [--yes]
#                                         [--no-build]
set -euo pipefail

REPO="IamAndelib/CyberJuke"
KEYS_DIR="$HOME/cyberjuke-keys"
ASSUME_YES=false
BUILD=true

while (( $# > 0 )); do
  case "$1" in
    --repo) REPO="${2:?--repo needs OWNER/NAME}"; shift 2 ;;
    --keys-dir) KEYS_DIR="${2:?--keys-dir needs a directory}"; shift 2 ;;
    --yes|-y) ASSUME_YES=true; shift ;;
    --no-build) BUILD=false; shift ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

# ---- Output helpers ---------------------------------------------------------------------

if [[ -t 1 ]]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else B=; G=; Y=; R=; N=; fi
step() { printf '\n%s== %s%s\n' "$B" "$1" "$N"; }
ok()   { printf '%s  ok%s  %s\n' "$G" "$N" "$1"; }
skip() { printf '      %s (already done)\n' "$1"; }
warn() { printf '%s  !!%s  %s\n' "$Y" "$N" "$1"; }
die()  { printf '\n%sError:%s %s\n' "$R" "$N" "$1" >&2; exit 1; }

# Yes/no question; --yes answers yes. Default yes.
confirm() {
  $ASSUME_YES && return 0
  local a
  read -r -p "  $1 [Y/n] " a || true
  [[ -z "$a" || "$a" =~ ^[Yy] ]]
}

# Reads a password twice without echoing it. Result in the variable named by $2.
read_new_password() {
  local label="$1" __var="$2" p1 p2
  while true; do
    read -r -s -p "  New password for the $label key (8+ characters): " p1 || true; echo
    if (( ${#p1} < 8 )); then warn "Too short."; continue; fi
    read -r -s -p "  Repeat it: " p2 || true; echo
    if [[ "$p1" != "$p2" ]]; then warn "They don't match."; continue; fi
    printf -v "$__var" '%s' "$p1"
    return 0
  done
}

# Reads the password of an existing keystore and checks it opens the store.
read_existing_password() {
  local label="$1" file="$2" __var="$3" p
  while true; do
    read -r -s -p "  Password of the existing $label key ($file): " p || true; echo
    if KS_PW="$p" keytool -list -keystore "$file" -storepass:env KS_PW >/dev/null 2>&1; then
      printf -v "$__var" '%s' "$p"
      return 0
    fi
    warn "That password doesn't open $file. Try again (Ctrl+C to stop)."
  done
}

sha256_hex() { if command -v sha256sum >/dev/null; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }
b64_oneline() { base64 < "$1" | tr -d '\n\r'; }

# ---- 1. Tools and login -------------------------------------------------------------------

step "1/7  Checking tools and GitHub login"
command -v keytool >/dev/null || die "keytool not found. Install a JDK 17 or newer (see docs/PUBLISHING.md, step 1)."
command -v gh >/dev/null || die "The GitHub CLI (gh) is not installed. See https://cli.github.com and docs/PUBLISHING.md, step 1."
command -v base64 >/dev/null || die "base64 not found."
gh auth status >/dev/null 2>&1 || die "gh is not logged in. Run: gh auth login"
ME_LOGIN=$(gh api user --jq .login) || die "Couldn't read your GitHub account (gh api user)."
ME_ID=$(gh api user --jq .id)
REPO_JSON=$(gh api "repos/$REPO" --jq '[.owner.login, .permissions.admin] | @tsv' 2>/dev/null) \
  || die "Can't see the repository $REPO with this login ($ME_LOGIN)."
REPO_OWNER=${REPO_JSON%%$'\t'*}
IS_ADMIN=${REPO_JSON##*$'\t'}
[[ "$IS_ADMIN" == "true" ]] || die "$ME_LOGIN is not an admin of $REPO; log in as $REPO_OWNER (gh auth login)."
ok "keytool, gh; logged in as $ME_LOGIN, admin of $REPO"

# ---- 2. Signing keys ----------------------------------------------------------------------

step "2/7  Signing keys in $KEYS_DIR"
mkdir -p "$KEYS_DIR"
chmod 700 "$KEYS_DIR" 2>/dev/null || true

env_secrets() { gh secret list --env "$1" --repo "$REPO" --json name --jq '.[].name' 2>/dev/null || true; }

# make_or_load_key LABEL FILE ALIAS DNAME ENV PASSWORD_VAR NEW_VAR
#   Creates FILE if missing (asking for a new password), else asks for its password.
#   Refuses to make a new key when the environment already holds one: that would replace
#   the signing key, and every installed copy would have to be uninstalled.
make_or_load_key() {
  local label="$1" file="$2" alias="$3" dname="$4" env="$5" __pw="$6" __new="$7" pw
  if [[ -f "$file" ]]; then
    read_existing_password "$label" "$file" pw
    printf -v "$__new" '%s' false
    skip "$label key: $file"
  else
    if env_secrets "$env" | grep -Eqx '(PREVIEW_)?KEYSTORE_FILE'; then
      die "The '$env' environment already has a $label key, but $file is missing.
       Copy your backup of it to $file and run this again. (Making a new key would force
       everyone to uninstall and reinstall the app.)"
    fi
    echo "  Creating the $label key. Choose a strong password and keep it with the key file."
    read_new_password "$label" pw
    KS_PW="$pw" keytool -genkeypair -keystore "$file" -storetype PKCS12 \
      -alias "$alias" -keyalg RSA -keysize 4096 -validity 10000 -dname "$dname" \
      -storepass:env KS_PW -keypass:env KS_PW >/dev/null 2>&1 \
      || die "keytool couldn't create $file."
    chmod 600 "$file" 2>/dev/null || true
    printf -v "$__new" '%s' true
    ok "$label key created: $file"
  fi
  printf -v "$__pw" '%s' "$pw"
}

PREVIEW_JKS="$KEYS_DIR/preview.jks"
RELEASE_JKS="$KEYS_DIR/release.jks"
PREVIEW_ALIAS=cyberjuke-preview
RELEASE_ALIAS=cyberjuke
make_or_load_key "preview" "$PREVIEW_JKS" "$PREVIEW_ALIAS" "CN=CyberJuke Preview" preview PREVIEW_PW PREVIEW_NEW
make_or_load_key "release" "$RELEASE_JKS" "$RELEASE_ALIAS" "CN=CyberJuke" release RELEASE_PW RELEASE_NEW

# ---- 3. Environments ----------------------------------------------------------------------

step "3/7  Protected environments (deploy from main only)"

# ensure_env NAME WITH_REVIEWER
ensure_env() {
  local name="$1" reviewer="$2" body
  local exists=false
  gh api "repos/$REPO/environments/$name" >/dev/null 2>&1 && exists=true
  local has_policy=false
  if $exists && [[ "$(gh api "repos/$REPO/environments/$name" --jq '.deployment_branch_policy.custom_branch_policies // false')" == "true" ]]; then
    has_policy=true
  fi
  local has_reviewer=false
  if $exists && gh api "repos/$REPO/environments/$name" --jq '[.protection_rules[]? | select(.type=="required_reviewers")] | length' | grep -qv '^0$'; then
    has_reviewer=true
  fi
  if $exists && $has_policy && { [[ "$reviewer" == false ]] || $has_reviewer; }; then
    skip "'$name' environment"
  else
    local what="deploy from main only"
    [[ "$reviewer" == true ]] && what="$what, you approve each run"
    if confirm "Set up the '$name' environment ($what)?"; then
      if [[ "$reviewer" == true ]]; then
        body=$(printf '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true},"reviewers":[{"type":"User","id":%s}],"prevent_self_review":false}' "$ME_ID")
      else
        body='{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
      fi
      printf '%s' "$body" | gh api -X PUT "repos/$REPO/environments/$name" --input - >/dev/null \
        || die "Couldn't create the '$name' environment."
      ok "'$name' environment"
    else
      warn "Skipped the '$name' environment."
      return 0
    fi
  fi
  if gh api "repos/$REPO/environments/$name/deployment-branch-policies" --jq '.branch_policies[].name' 2>/dev/null | grep -qx main; then
    skip "'$name' allows main"
  else
    printf '{"name":"main","type":"branch"}' | gh api -X POST "repos/$REPO/environments/$name/deployment-branch-policies" --input - >/dev/null \
      || die "Couldn't allow main in the '$name' environment."
    ok "'$name' deploys from main only"
  fi
}
ensure_env preview false
ensure_env release true

# ---- 4. Secrets ---------------------------------------------------------------------------

step "4/7  Key secrets in the environments"

# put_secret ENV NAME VALUE   (the value goes through stdin, never the command line)
put_secret() { printf '%s' "$3" | gh secret set "$2" --env "$1" --repo "$REPO" >/dev/null || die "Couldn't set $2 in '$1'."; }

# store_key_secrets ENV PREFIX FILE ALIAS PASSWORD IS_NEW
store_key_secrets() {
  local env="$1" p="$2" file="$3" alias="$4" pw="$5" new="$6" have
  have=$(env_secrets "$env")
  local missing=false n
  for n in KEYSTORE_FILE KEYSTORE_PASSWORD KEY_ALIAS KEY_PASSWORD; do
    grep -qx "$p$n" <<<"$have" || missing=true
  done
  if [[ "$new" == false && "$missing" == false ]]; then
    skip "$env secrets (${p}KEYSTORE_FILE, ...)"
    return 0
  fi
  put_secret "$env" "${p}KEYSTORE_FILE" "$(b64_oneline "$file")"
  put_secret "$env" "${p}KEYSTORE_PASSWORD" "$pw"
  put_secret "$env" "${p}KEY_ALIAS" "$alias"
  put_secret "$env" "${p}KEY_PASSWORD" "$pw" # PKCS12: the key password is the store password
  ok "$env secrets: ${p}KEYSTORE_FILE, ${p}KEYSTORE_PASSWORD, ${p}KEY_ALIAS, ${p}KEY_PASSWORD"
}
store_key_secrets preview PREVIEW_ "$PREVIEW_JKS" "$PREVIEW_ALIAS" "$PREVIEW_PW" "$PREVIEW_NEW"
store_key_secrets release "" "$RELEASE_JKS" "$RELEASE_ALIAS" "$RELEASE_PW" "$RELEASE_NEW"

# Older setups put the preview key in repository secrets, which every workflow can read.
OLD=$(gh secret list --repo "$REPO" --json name --jq '.[].name' 2>/dev/null | grep -E '^(PREVIEW_)?(KEYSTORE_FILE|KEYSTORE_PASSWORD|KEY_ALIAS|KEY_PASSWORD)$' || true)
if [[ -n "$OLD" ]]; then
  warn "Repository-level key secrets found: $(echo "$OLD" | tr '\n' ' ')"
  if confirm "Delete them, so the keys live only in the protected environments?"; then
    while read -r n; do gh secret delete "$n" --repo "$REPO" >/dev/null && ok "deleted repository secret $n"; done <<<"$OLD"
  fi
fi

# ---- 5. What the Release workflow needs ---------------------------------------------------

step "5/7  Release workflow: pushing the version bump to main"
BLOCKED=false
if gh api "repos/$REPO/branches/main/protection" >/dev/null 2>&1; then BLOCKED=true; fi
if [[ "$(gh api "repos/$REPO/rules/branches/main" --jq 'length' 2>/dev/null || echo 0)" != "0" ]]; then BLOCKED=true; fi
if $BLOCKED; then
  warn "main has branch protection or rules. The Release workflow commits the version bump"
  warn "to main as github-actions[bot]; allow that (bypass list) or the release stops at 'prepare'."
else
  ok "main has no protection rules; the Release workflow can push its version bump"
fi

# ---- 6. Fingerprint for F-Droid -----------------------------------------------------------

step "6/7  Release certificate fingerprint (for F-Droid)"
FP=$(KS_PW="$RELEASE_PW" keytool -exportcert -keystore "$RELEASE_JKS" -alias "$RELEASE_ALIAS" -storepass:env KS_PW 2>/dev/null | sha256_hex)
[[ ${#FP} == 64 ]] || die "Couldn't read the release certificate."
printf '%s\n' "$FP" > "$KEYS_DIR/release-cert-sha256.txt"
ok "SHA-256: $FP"
echo "      Saved to $KEYS_DIR/release-cert-sha256.txt. F-Droid's AllowedAPKSigningKeys needs it;"
echo "      send it to whoever prepares the F-Droid recipe (it is public, not a secret)."

# ---- 7. The test build --------------------------------------------------------------------

step "7/7  CyberJuke Preview test build"
if $BUILD && confirm "Start the Preview build now (about 15 minutes)?"; then
  BEFORE=$(gh run list --repo "$REPO" --workflow preview.yml --limit 1 --json databaseId --jq '.[0].databaseId // 0')
  gh workflow run preview.yml --repo "$REPO" --ref main >/dev/null || die "Couldn't start the Preview workflow."
  RUN=""
  for _ in $(seq 1 30); do
    sleep 4
    RUN=$(gh run list --repo "$REPO" --workflow preview.yml --limit 1 --json databaseId --jq '.[0].databaseId // 0')
    [[ "$RUN" != "$BEFORE" && "$RUN" != 0 ]] && break
    RUN=""
  done
  [[ -n "$RUN" ]] || die "The Preview run didn't show up; check https://github.com/$REPO/actions"
  echo "  Watching https://github.com/$REPO/actions/runs/$RUN (Ctrl+C stops watching, not the build)"
  if gh run watch "$RUN" --repo "$REPO" --exit-status >/dev/null; then
    ok "Test build published: https://github.com/$REPO/releases/tag/preview"
  else
    warn "The Preview run failed: https://github.com/$REPO/actions/runs/$RUN"
  fi
else
  echo "  Skipped. Start it later from https://github.com/$REPO/actions/workflows/preview.yml"
fi

# ---- Done ---------------------------------------------------------------------------------

printf '\n%sDone.%s Back up NOW, to two places (e.g. a password manager and an offline drive):\n' "$B" "$N"
echo "  - $PREVIEW_JKS and its password"
echo "  - $RELEASE_JKS and its password"
echo "Losing the release key means no one can update the app without reinstalling it."
echo "Next: docs/TESTING.md (test the preview), then docs/PUBLISHING.md step 6 (release)."
