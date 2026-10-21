#!/usr/bin/env bash
# Publish the eight tarballs CI packed (the `npm-tarballs` artifact) to registry.npmjs.org in release
# order: six platform packages, the loader, the library (docs/PUBLISHING.md step 5). Stops at the
# first failure, before anything later in the order is uploaded.
#   bash scripts/publish-tarballs.sh <dir-with-tarballs>
# The library publishes at the root package.json version and the seven native packages at native/package.json's,
# which may be lower by patch (scripts/check-versions.mjs); for a library-only patch the native packages are already
# on the registry and are skipped.
#
# Before uploading anything it checks: logged in (npm whoami), two-factor authentication enabled
# (npm rejects publishing without it: E403 "Two-factor authentication or granular access token with
# bypass 2fa enabled is required"), all eight tarballs present, versions agree
# (scripts/check-versions.mjs --packed), and every package@version not on the registry yet. A package
# already published at this version is skipped, so a rerun after a failure resumes where it stopped.
# npm asks for a one-time password on each publish (or opens the browser for a security key), which
# needs a TTY: do not pipe the output (e.g. through tee).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${1:?usage: bash scripts/publish-tarballs.sh <dir-with-tarballs>}"
DIR="$(cd "$DIR" && pwd)"
LIB_V="$(node -p "require('$REPO/package.json').version")"
NATIVE_V="$(node -p "require('$REPO/native/package.json').version")"
ver() { if [ "$1" = rn-material-symbols ]; then echo "$LIB_V"; else echo "$NATIVE_V"; fi; }
REG=https://registry.npmjs.org/
NAMES="rn-material-symbols-scanner-native-darwin-arm64 rn-material-symbols-scanner-native-darwin-x64
rn-material-symbols-scanner-native-linux-arm64-gnu rn-material-symbols-scanner-native-linux-x64-gnu
rn-material-symbols-scanner-native-linux-x64-musl rn-material-symbols-scanner-native-win32-x64-msvc
rn-material-symbols-scanner-native rn-material-symbols"

# npm asks for the second factor only when stdin and stdout are a terminal; piped (e.g. through
# tee) it fails at once with EOTP and a browser URL instead of waiting (seen 2026-10-16).
if [ ! -t 0 ] || [ ! -t 1 ]; then
  echo "error: run this in a terminal without piping or redirecting; npm needs a TTY to wait for the browser/passkey or OTP step" >&2; exit 1
fi
USER_NAME="$(npm whoami --registry "$REG" 2>/dev/null)" || { echo "error: not logged in; run npm login" >&2; exit 1; }
# tfa is false when off, otherwise {"mode":"auth-and-writes"|"auth-only","pending":bool}.
TFA="$(npm profile get --json --registry "$REG" 2>/dev/null | node -e '
  let s=""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const t = JSON.parse(s || "{}").tfa;
    process.stdout.write(!t ? "disabled" : t.pending ? "pending" : String(t.mode));
  })' || echo unknown)"
case "$TFA" in
  auth-and-writes) ;;
  auth-only) echo "warning: 2FA mode is auth-only; if npm rejects the publish with E403, switch to 'Authorization and writes'" >&2 ;;
  *) echo "error: two-factor authentication is '$TFA' for $USER_NAME; npm rejects publishing without it (E403). Enable it at https://www.npmjs.com/settings/$USER_NAME/tfa" >&2; exit 1 ;;
esac
for n in $NAMES; do
  [ -f "$DIR/$n-$(ver "$n").tgz" ] || { echo "error: missing $DIR/$n-$(ver "$n").tgz" >&2; exit 1; }
done
node "$REPO/scripts/check-versions.mjs" --packed "$DIR"
echo "publishing library $LIB_V, native $NATIVE_V as $USER_NAME (2FA: $TFA)"

published() { npm view "$1@$(ver "$1")" version --registry "$REG" >/dev/null 2>&1; }

for n in $NAMES; do
  V="$(ver "$n")"
  if published "$n"; then echo "== $n@$V already on the registry, skipped"; continue; fi
  echo "== $n@$V"
  npm publish "$DIR/$n-$V.tgz" --access public --registry "$REG"
  # A first publish of a new package can go through npm's staged publishing (a 0.0.0-stage
  # placeholder appears first) and the real version shows up only after approval; on 2026-10-15
  # took 1 to 3 minutes for the platform packages and the loader and about 11 minutes for the
  # library (1.5 MB, 11,910 files). Wait up to 30 minutes.
  waited=0
  until published "$n"; do
    [ "$waited" -ge 1800 ] && { echo "error: $n@$V not visible after 30 min; check https://www.npmjs.com/package/$n before rerunning" >&2; exit 1; }
    [ $((waited % 30)) = 0 ] && echo "   waiting for $n@$V to appear on the registry (${waited}s)"
    sleep 5; waited=$((waited + 5))
  done
  echo "   ok: $(npm view "$n@$V" version --registry "$REG")"
done
echo "all eight packages are on $REG (library $LIB_V, native $NATIVE_V)"
