#!/usr/bin/env bash
# Poll the public npm registry until PACKAGE@VERSION is visible.
#
# Run 39886755826 published @wzrd_sol/eliza-plugin@0.8.1, then this check
# failed: 18 attempts, 10 seconds apart, ended 2026-10-23T01:59:31Z with
# "Registry still does not show 0.8.1 after 3 minutes". The registry's own
# time for 0.8.1 is 2026-10-23T02:00:32Z, about one minute after the poll
# gave up. The default window is 36 attempts (about 6 minutes) so that lag
# still counts as success. A version the registry does not have still
# exits non-zero.
#
# VERIFY_ATTEMPTS and VERIFY_INTERVAL_SECONDS override the window. The
# publish workflow uses the defaults.
set -euo pipefail

PKG="${1:?package name}"
EXPECTED="${2:?version}"
ATTEMPTS="${VERIFY_ATTEMPTS:-36}"
INTERVAL="${VERIFY_INTERVAL_SECONDS:-10}"

for i in $(seq 1 "$ATTEMPTS"); do
  # A fresh cache per attempt: a cached miss must not hide a version that
  # replicated after the previous lookup.
  CACHE="$(mktemp -d)"
  LIVE="$(npm view "${PKG}@${EXPECTED}" version --prefer-online --cache "$CACHE" 2>/dev/null || true)"
  rm -rf "$CACHE"
  # Command substitution already drops trailing newlines. Drop any other space.
  LIVE="${LIVE//[[:space:]]/}"
  if [ "$LIVE" = "$EXPECTED" ]; then
    echo "Verified live: ${PKG}@${LIVE} (attempt ${i})"
    exit 0
  fi
  echo "Attempt ${i}/${ATTEMPTS}: registry does not show ${EXPECTED} yet"
  if [ "$i" -lt "$ATTEMPTS" ]; then
    sleep "$INTERVAL"
  fi
done

echo "::error::Registry still does not show ${PKG}@${EXPECTED} after ${ATTEMPTS} attempts."
exit 1
