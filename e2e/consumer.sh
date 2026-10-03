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
RN_VERSION=0.78.3
SVG_VERSION=15.13.0
EXPECTED="info,home,check_box,check_box_outline_blank,expand_less,expand_more,settings,schedule,cloud_download"

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

echo "node $(node -v) · npm $(npm -v) · pnpm $(pnpm -v) · yarn $(cd "$WORK" && yarn -v) · $(date +%F)"

# step <pm> <name> <cmd...>: run, log to $WORK/<pm>-<name>.log, record "pm|name|exit|seconds".
step() {
  local pm="$1" name="$2"; shift 2
  local start=$SECONDS code=0
  "$@" >"$WORK/$pm-$name.log" 2>&1 || code=$?
  echo "$pm|$name|$code|$((SECONDS - start))" >> "$RESULTS"
  echo "  [$pm] $name: exit $code ($((SECONDS - start))s)"
  if [ "$code" != 0 ]; then tail -n 25 "$WORK/$pm-$name.log" | sed 's/^/      /'; fi
  return 0
}

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

echo "react-native CLI $(npx --yes @react-native-community/cli@latest --version 2>/dev/null | tail -n 1)"
echo "== template (react-native $RN_VERSION)"
npx --yes @react-native-community/cli@latest init E2eApp --version "$RN_VERSION" \
  --skip-install --skip-git-init --directory "$WORK/template" >"$WORK/init.log" 2>&1 || { tail -30 "$WORK/init.log"; exit 1; }
rm -rf "$WORK/template/__tests__"

write_app() {
  local dir="$1" pm="$2"
  # README "Metro setup" plus the README "Dynamic names" safelist (include), default sources.
  cat > "$dir/metro.config.js" <<'JS'
const { getDefaultConfig } = require('@react-native/metro-config');
const { withMaterialSymbols } = require('rn-material-symbols/metro');
module.exports = withMaterialSymbols(getDefaultConfig(__dirname), { include: ['cloud_download'] });
JS
  mkdir -p "$dir/src" "$dir/__tests__"
  cat > "$dir/src/tabs.ts" <<'TS'
export const TABS = [{ key: 'settings', icon: 'settings' as const }];
TS
  cat > "$dir/App.tsx" <<'TSX'
import React, { useState } from 'react';
import { View } from 'react-native';
import { MaterialIcon, type MaterialSymbolName } from 'rn-material-symbols';
import { TABS } from './src/tabs';

export default function App() {
  const [checked] = useState(true);
  const [open] = useState(false);
  const toggle = `${open ? 'expand_less' : 'expand_more'}` as MaterialSymbolName;
  return (
    <View>
      <MaterialIcon name="info" />
      <MaterialIcon name="home" filled />
      <MaterialIcon name={checked ? 'check_box' : 'check_box_outline_blank'} />
      <MaterialIcon name={toggle} />
      <MaterialIcon name={TABS[0].icon} />
      <MaterialIcon name="access_time" />
    </View>
  );
}
TSX
  cat > "$dir/jest.config.js" <<'JS'
module.exports = {
  preset: 'react-native',
  moduleNameMapper: { ...require('rn-material-symbols/jest').moduleNameMapper },
};
JS
  if [ "$pm" = pnpm ]; then
    # README "Jest": pnpm keeps packages under node_modules/.pnpm, which the preset's default
    # transformIgnorePatterns skips, so react-native's own jest setup fails to parse without this.
    cat > "$dir/jest.config.js" <<'JS'
module.exports = {
  preset: 'react-native',
  moduleNameMapper: { ...require('rn-material-symbols/jest').moduleNameMapper },
  transformIgnorePatterns: ['node_modules/(?!(\\.pnpm|(jest-)?react-native|@react-native(-community)?)/)'],
};
JS
  fi
  cat > "$dir/__tests__/icon.test.tsx" <<'TSX'
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Path } from 'react-native-svg';
import { MaterialIcon } from 'rn-material-symbols';

const info = require('rn-material-symbols/icons/rounded/info');

test('renders the info path', () => {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<MaterialIcon name="info" />);
  });
  const paths = tree.root.findAllByType(Path);
  expect(paths).toHaveLength(1);
  expect(paths[0].props.d).toBe(info.d);
});
TSX
}

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
  step "$pm" bundle-ios npx react-native bundle --platform ios --dev false --entry-file index.js \
    --bundle-output "$WORK/$pm-ios.jsbundle" --assets-dest "$WORK/$pm-ios-assets"
  case "$pm" in
    # The report line is the last thing the scan prints; its final field names the engine that ran.
    npm-native) step "$pm" engine grep -E '^\[rn-material-symbols\] .* · native$' "$WORK/$pm-bundle-ios.log" ;;
    npm-js) step "$pm" engine grep -E '^\[rn-material-symbols\] .* · js$' "$WORK/$pm-bundle-ios.log" ;;
  esac
  case "$pm" in
    # A missing platform package is the expected case for npm-js: JS runs silently, no failure line.
    npm-native|npm-js) step "$pm" no-native-warning bash -c '! grep -E "native scanner failed|warning: rn-material-symbols-scanner-native" "$1"' _ "$WORK/$pm-bundle-ios.log" ;;
  esac
  step "$pm" assert-ios node "$REPO/e2e/assert-bundle.mjs" "$WORK/$pm-ios.jsbundle" --expect "$EXPECTED"
  step "$pm" bundle-android npx react-native bundle --platform android --dev false --entry-file index.js \
    --bundle-output "$WORK/$pm-android.bundle" --assets-dest "$WORK/$pm-android-assets"
  step "$pm" assert-android node "$REPO/e2e/assert-bundle.mjs" "$WORK/$pm-android.bundle" --expect "$EXPECTED"
  step "$pm" jest "${pm%%-*}" test   # npm-native / npm-js run Jest through npm
  grep -h "^\[rn-material-symbols\] " "$WORK/$pm-bundle-ios.log" 2>/dev/null | sed "s/^/  [$pm] /" || true
  grep -h "exact icon set" "$WORK/$pm-assert-ios.log" "$WORK/$pm-assert-android.log" 2>/dev/null | sed "s/^/  [$pm] /" || true
  grep -hE "^(Tests|Test Suites):" "$WORK/$pm-jest.log" 2>/dev/null | sed "s/^/  [$pm] /" || true
  cd "$REPO"
}

VERSION="$(node -p "require('$REPO/package.json').version")"
for pm in $PMS; do
  # Yarn 1 aborts when an optional dependency is missing from the registry, so before the native
  # loader of this version is published it cannot install the library at all. Skip, loudly.
  if [ "$pm" = yarn ] && ! npm view "rn-material-symbols-scanner-native@$VERSION" version >/dev/null 2>&1; then
    echo "== yarn: SKIPPED (rn-material-symbols-scanner-native@$VERSION is not on the registry yet; Yarn 1 fails on a missing optional dependency)"
    echo "yarn|skipped-unpublished-native|0|0" >> "$RESULTS"
    continue
  fi
  run_pm "$pm"
done

echo "== summary (pm|step|exit|seconds)"
cat "$RESULTS"
if grep -qE '\|[1-9][0-9]*\|[0-9]+$' "$RESULTS"; then
  echo "FAILED steps above"
  exit 1
fi
