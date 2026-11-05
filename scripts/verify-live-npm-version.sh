#!/usr/bin/env bash
# Poll the public npm registry until PACKAGE@VERSION is visible on every
# surface we check. Fail closed if the window ends without a match.
#
# Why this is not a single `npm view`:
# - Run 39886755826 published @wzrd_sol/eliza-plugin@0.8.1, then an 18×10s
#   poll ended 2026-10-23T01:59:31Z. The registry recorded 0.8.1 at
#   2026-10-23T02:00:32Z, about one minute later.
# - Run 41740588074 published twzrd-x402-gate@0.16.1 at 23:38:20Z
#   (npm: "may take a few minutes to become available"). The gate workflow's
#   inline 18×10s poll ended 23:41:25Z. The registry recorded 0.16.1 at
#   23:41:29Z, four seconds later. A cached miss can hide a later replica.
#
# Each attempt:
#   1. clears an isolated npm cache (a cached 404 must not stick)
#   2. `npm view PACKAGE@VERSION` for version + dist.tarball, and
#      `npm view PACKAGE dist-tags`
#   3. GET the registry packument and require versions[VERSION].dist.tarball
#      plus a non-empty dist-tags object
#   4. HEAD the packument tarball URL and require HTTP 200
#
# Default window: 600s wall clock, 10s initial sleep, 1.5× backoff, 60s cap.
# VERIFY_DEADLINE_SECONDS, VERIFY_INITIAL_INTERVAL_SECONDS (or
# VERIFY_INTERVAL_SECONDS), VERIFY_MAX_INTERVAL_SECONDS, and optional
# VERIFY_ATTEMPTS override that. VERIFY_NPM_REGISTRY / NPM_CONFIG_REGISTRY
# select the registry (default https://registry.npmjs.org). This script
# never publishes, never writes dist-tags, and never runs `npm publish`.
set -euo pipefail

PKG="${1:?package name}"
EXPECTED="${2:?version}"

if ! printf '%s' "$PKG" | grep -Eq '^(@[A-Za-z0-9._~-]+/)?[A-Za-z0-9._~-]+$'; then
  echo "::error::invalid package name: $PKG"
  exit 1
fi
if ! printf '%s' "$EXPECTED" | grep -Eq '^[A-Za-z0-9._+-]+$'; then
  echo "::error::invalid version: $EXPECTED"
  exit 1
fi

positive_int() {
  case "${1:-}" in
    ''|*[!0-9]*) return 1 ;;
    0) return 1 ;;
    *) return 0 ;;
  esac
}

DEADLINE="${VERIFY_DEADLINE_SECONDS:-600}"
INITIAL="${VERIFY_INITIAL_INTERVAL_SECONDS:-${VERIFY_INTERVAL_SECONDS:-10}}"
MAX_INTERVAL="${VERIFY_MAX_INTERVAL_SECONDS:-60}"
MAX_ATTEMPTS="${VERIFY_ATTEMPTS:-}"

if ! positive_int "$DEADLINE" || ! positive_int "$INITIAL" || ! positive_int "$MAX_INTERVAL"; then
  echo "::error::VERIFY_DEADLINE_SECONDS, VERIFY_INITIAL_INTERVAL_SECONDS, and VERIFY_MAX_INTERVAL_SECONDS must be positive integers."
  exit 1
fi
if [ -n "$MAX_ATTEMPTS" ] && ! positive_int "$MAX_ATTEMPTS"; then
  echo "::error::VERIFY_ATTEMPTS must be a positive integer when set."
  exit 1
fi

REGISTRY="${VERIFY_NPM_REGISTRY:-${NPM_CONFIG_REGISTRY:-https://registry.npmjs.org}}"
REGISTRY="${REGISTRY%/}"

# @scope/name -> @scope%2fname (npm's packument URL). Unscoped names unchanged.
ENCODED_PKG="$(printf '%s' "$PKG" | sed 's|/|%2f|g')"
PACKUMENT_URL="${REGISTRY}/${ENCODED_PKG}"

STARTED_AT="$(date +%s)"
DEADLINE_AT="$((STARTED_AT + DEADLINE))"

# stdin = JSON. Prints the tarball URL on success (exit 0).
# Packuments are passed on stdin so a multi-version document cannot blow ARG_MAX.
packument_tarball() {
  EXPECTED_VERSION="$EXPECTED" node --input-type=commonjs -e '
const fs = require("fs");
const expected = process.env.EXPECTED_VERSION;
let parsed;
try { parsed = JSON.parse(fs.readFileSync(0, "utf8")); }
catch { process.exit(2); }
if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) process.exit(3);
const tags = parsed["dist-tags"];
if (!tags || typeof tags !== "object" || Array.isArray(tags) || Object.keys(tags).length === 0) {
  process.exit(4);
}
const versionDoc = parsed.versions && parsed.versions[expected];
if (!versionDoc || typeof versionDoc !== "object") process.exit(5);
const tarball = versionDoc.dist && versionDoc.dist.tarball;
if (typeof tarball !== "string" || !/^https?:\/\//.test(tarball)) process.exit(6);
process.stdout.write(tarball);
'
}

dist_tags_object_ok() {
  node --input-type=commonjs -e '
const fs = require("fs");
let parsed;
try { parsed = JSON.parse(fs.readFileSync(0, "utf8")); }
catch { process.exit(2); }
if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
  process.exit(3);
}
'
}

# One attempt. Echoes a reason on failure. Returns 0 only when every surface matches.
check_once() {
  local cache live view_tarball view_tags packument registry_tarball tarball_status

  cache="$(mktemp -d)"
  # Isolated cache per attempt, then wipe it. A cached miss must not hide a
  # version that replicated after the previous lookup.
  npm cache clean --force --cache "$cache" >/dev/null 2>&1 || true

  live="$(npm view "${PKG}@${EXPECTED}" version --prefer-online --cache "$cache" --registry "$REGISTRY" 2>/dev/null || true)"
  live="${live//[[:space:]]/}"
  view_tarball="$(npm view "${PKG}@${EXPECTED}" dist.tarball --prefer-online --cache "$cache" --registry "$REGISTRY" 2>/dev/null || true)"
  view_tarball="${view_tarball//[[:space:]]/}"
  view_tags="$(npm view "${PKG}" dist-tags --json --prefer-online --cache "$cache" --registry "$REGISTRY" 2>/dev/null || true)"
  rm -rf "$cache"

  if [ "$live" != "$EXPECTED" ]; then
    echo "npm view ${PKG}@${EXPECTED} version => '${live}'"
    return 1
  fi
  if ! printf '%s' "$view_tarball" | grep -Eq '^https?://'; then
    echo "npm view ${PKG}@${EXPECTED} dist.tarball missing"
    return 1
  fi
  if ! printf '%s' "$view_tags" | dist_tags_object_ok; then
    echo "npm view ${PKG} dist-tags missing or not an object"
    return 1
  fi

  packument="$(curl -fsS --max-time 20 \
    -H 'Accept: application/json' \
    -H 'Cache-Control: no-cache' \
    "$PACKUMENT_URL" 2>/dev/null || true)"
  if ! registry_tarball="$(printf '%s' "$packument" | packument_tarball)"; then
    echo "registry packument ${PACKUMENT_URL} missing versions[${EXPECTED}].dist.tarball or dist-tags"
    return 1
  fi
  if [ "$registry_tarball" != "$view_tarball" ]; then
    echo "tarball URL mismatch: npm view=${view_tarball} packument=${registry_tarball}"
    return 1
  fi

  tarball_status="$(curl -sS -o /dev/null -w '%{http_code}' -I -L --max-time 20 \
    -H 'Cache-Control: no-cache' \
    "$registry_tarball" 2>/dev/null || true)"
  if [ "$tarball_status" != "200" ]; then
    echo "registry tarball HEAD ${registry_tarball} => HTTP ${tarball_status:-000}"
    return 1
  fi

  echo "npm view ${PKG}@${EXPECTED} version=${live}"
  echo "npm view dist.tarball=${view_tarball}"
  echo "registry packument dist-tags + versions[${EXPECTED}].dist.tarball ok"
  echo "registry tarball HEAD 200 ${registry_tarball}"
  return 0
}

attempt=1
interval="$INITIAL"
while true; do
  if reason="$(check_once)"; then
    echo "Verified live: ${PKG}@${EXPECTED} (attempt ${attempt})"
    printf '%s\n' "$reason"
    exit 0
  fi

  now="$(date +%s)"
  remaining="$((DEADLINE_AT - now))"
  if [ "$remaining" -le 0 ]; then
    echo "Attempt ${attempt}: ${reason}"
    echo "::error::Registry still does not show ${PKG}@${EXPECTED} after ${DEADLINE}s -- publish may have failed. Check manually."
    exit 1
  fi
  if [ -n "$MAX_ATTEMPTS" ] && [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    echo "Attempt ${attempt}: ${reason}"
    echo "::error::Registry still does not show ${PKG}@${EXPECTED} after ${attempt} attempts -- publish may have failed. Check manually."
    exit 1
  fi

  sleep_for="$interval"
  if [ "$sleep_for" -gt "$remaining" ]; then
    sleep_for="$remaining"
  fi
  echo "Attempt ${attempt}: ${reason}; retrying in ${sleep_for}s (${remaining}s left in ${DEADLINE}s window)..."
  sleep "$sleep_for"

  next="$((interval * 3 / 2))"
  if [ "$next" -le "$interval" ]; then
    next="$((interval + 1))"
  fi
  if [ "$next" -gt "$MAX_INTERVAL" ]; then
    next="$MAX_INTERVAL"
  fi
  interval="$next"
  attempt="$((attempt + 1))"
done
