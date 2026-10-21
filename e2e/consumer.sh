#!/usr/bin/env bash
# Consumer E2E: pack the library, create a bare React Native 0.78.3 app, install the tarball with
# npm / pnpm / yarn, bundle for iOS and Android, assert the exact icon set, and run Jest.
#   bash e2e/consumer.sh              all three package managers
#   PMS="npm" bash e2e/consumer.sh    a subset
#   yarn is skipped (and says so) while rn-material-symbols-scanner-native@<version> is not on the registry.
#   KEEP=1 bash e2e/consumer.sh       keep the temp dir (path is printed)
#
# Native release gate (run before publishing): PMS="npm-native npm-js" bash e2e/consumer.sh
#   npm-native  npm-installs three tarballs: the platform package for this machine, the native loader
#               and the library. The Metro report line must end with ' · native'.
#   npm-js      the same without the platform tarball. The report line must end with ' · js'.
#   The platform package is packed from a temp copy of native/npm/<platform>/; the script never writes into native/npm/.
#   - native/npm/<platform>/scanner.<platform>.node exists (assembled by CI, README "Before publishing" step 2):
#     it is used untouched and the gate verifies exactly that file ("using assembled artifact ... sha256").
#   - otherwise (clean checkout, needs a Rust toolchain): `pnpm build:native` (incremental) and
#     native/scanner.<platform>.node goes into the temp copy only ("using local build").
#   Only this machine's platform is exercised; all six are covered by README "Before publishing".
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PMS="${PMS:-npm pnpm yarn}"

for tool in npm pnpm yarn node; do
  command -v "$tool" >/dev/null || { echo "error: '$tool' not found in PATH (consumer.sh needs npm, pnpm, yarn and node)" >&2; exit 1; }
done

WORK="$(mktemp -d)"
RESULTS="$WORK/results.txt"
: > "$RESULTS"
cleanup() {
  if [ "${KEEP:-0}" = 1 ]; then echo "kept: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT
# shellcheck source=e2e/app.sh
. "$REPO/e2e/app.sh"

echo "node $(node -v) · npm $(npm -v) · pnpm $(pnpm -v) · yarn $(cd "$WORK" && yarn -v) · $(date +%F)"

echo "== pack"
cd "$REPO"
pnpm build >"$WORK/build.log" 2>&1 || { tail -30 "$WORK/build.log"; exit 1; }
# pnpm pack (not npm pack): it rewrites the `workspace:*` optional dependency on the native
# scanner to a real version; npm pack would ship `workspace:*` and npm install would reject it.
TARBALL="$(pnpm pack --pack-destination "$WORK" | tail -n 1)"
echo "tarball: $TARBALL ($(du -k "$TARBALL" | cut -f1) KB)"

case " $PMS " in
  *" npm-native "*|*" npm-js "*)
    # napi platform suffix for this machine (the targets in native/package.json "napi.targets").
    HOST="$(node -p 'process.platform + "-" + process.arch')"
    case "$HOST" in
      darwin-*) PLAT="$HOST" ;;
      linux-*)
        # musl's ldd prints its banner to stderr and exits 1, hence `|| true` under pipefail.
        LIBC=gnu
        case "$(ldd --version 2>&1 || true)" in *musl*) LIBC=musl ;; esac
        PLAT="$HOST-$LIBC" ;;
      win32-x64) PLAT=win32-x64-msvc ;;
      *) echo "error: no native target for $HOST" >&2; exit 1 ;;
    esac
    [ -d "$REPO/native/npm/$PLAT" ] || { echo "error: no native package for $PLAT (native/npm/$PLAT)" >&2; exit 1; }
    # The platform package is packed from a copy in $WORK; nothing is ever written into native/npm/.
    PLAT_SRC="$REPO/native/npm/$PLAT"
    PLAT_COPY="$WORK/plat-pkg/$PLAT"
    mkdir -p "$WORK/plat-pkg"
    cp -R "$PLAT_SRC" "$PLAT_COPY"
    ASSEMBLED="$PLAT_SRC/scanner.$PLAT.node"
    if [ -f "$ASSEMBLED" ]; then
      echo "using assembled artifact: native/npm/$PLAT/scanner.$PLAT.node (sha256 $(shasum -a 256 "$ASSEMBLED" | cut -d' ' -f1))"
    else
      command -v cargo >/dev/null || { echo "error: no assembled artifact and no Rust toolchain ('cargo' not in PATH) to build one" >&2; exit 1; }
      echo "== build:native ($PLAT)"
      pnpm build:native >"$WORK/build-native.log" 2>&1 || { tail -30 "$WORK/build-native.log"; echo "error: pnpm build:native failed (log above)" >&2; exit 1; }
      BUILT="$REPO/native/scanner.$PLAT.node"
      [ -f "$BUILT" ] || { echo "error: pnpm build:native did not produce $BUILT" >&2; exit 1; }
      cp "$BUILT" "$PLAT_COPY/scanner.$PLAT.node"
      echo "using local build: native/scanner.$PLAT.node ($(du -k "$BUILT" | cut -f1) KB, sha256 $(shasum -a 256 "$BUILT" | cut -d' ' -f1)), copied into the temp package only"
    fi
    # pnpm pack for the loader: it rewrites the workspace:* platform optionalDependencies to versions.
    PLAT_TARBALL="$(cd "$PLAT_COPY" && pnpm pack --pack-destination "$WORK" | tail -n 1)"
    LOADER_TARBALL="$(cd "$REPO/native" && pnpm pack --pack-destination "$WORK" | tail -n 1)"
    echo "platform tarball: $PLAT_TARBALL ($(du -k "$PLAT_TARBALL" | cut -f1) KB)"
    echo "loader tarball: $LOADER_TARBALL ($(du -k "$LOADER_TARBALL" | cut -f1) KB)"
    ;;
esac

make_template

run_pm() {
  local pm="$1" dir="$WORK/$1"
  echo "== $pm"
  cp -R "$WORK/template" "$dir"
  write_app "$dir" "$pm"
  cd "$dir"
  case "$pm" in
    npm)
      step npm install npm install
      step npm install-lib npm install "react-native-svg@$SVG_VERSION" "$TARBALL"
      ;;
    pnpm)
      step pnpm install pnpm install
      step pnpm install-lib pnpm add "react-native-svg@$SVG_VERSION" "$TARBALL"
      ;;
    yarn)
      step yarn install yarn install
      step yarn install-lib yarn add "react-native-svg@$SVG_VERSION" "$TARBALL"
      ;;
    npm-native)
      step "$pm" install npm install
      step "$pm" install-lib npm install "react-native-svg@$SVG_VERSION" "$PLAT_TARBALL" "$LOADER_TARBALL" "$TARBALL"
      ;;
    npm-js)
      step "$pm" install npm install
      step "$pm" install-lib npm install "react-native-svg@$SVG_VERSION" "$LOADER_TARBALL" "$TARBALL"
      ;;
    *) echo "error: unknown package manager '$pm'" >&2; exit 1 ;;
  esac
  case "$pm" in
    npm-native) check_app "$pm" native npm ;;
    npm-js) check_app "$pm" js npm ;;
    *) check_app "$pm" any "$pm" ;;
  esac
  cd "$REPO"
}

NATIVE_VERSION="$(node -p "require('$REPO/native/package.json').version")"
for pm in $PMS; do
  # Yarn 1 aborts when an optional dependency is missing from the registry, so before the native
  # loader of this version is published it cannot install the library at all. Skip, loudly.
  if [ "$pm" = yarn ] && ! npm view "rn-material-symbols-scanner-native@$NATIVE_VERSION" version >/dev/null 2>&1; then
    echo "== yarn: SKIPPED (rn-material-symbols-scanner-native@$NATIVE_VERSION is not on the registry yet; Yarn 1 fails on a missing optional dependency)"
    echo "yarn|skipped-unpublished-native|0|0" >> "$RESULTS"
    continue
  fi
  run_pm "$pm"
done

summary
