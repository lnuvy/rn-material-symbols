#!/usr/bin/env bash
# Expo E2E: install the packed library into example-expo/, run `expo export` for iOS (Hermes bytecode)
# and web, assert the exact icon set in both bundles, and check the `expo start` watch decision.
#   bash e2e/expo.sh            KEEP=1 keeps example-expo/node_modules afterwards
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$REPO/example-expo"
EXPECTED="info,home,check_box,check_box_outline_blank,expand_less,expand_more,settings,schedule,cloud_download"

WORK="$(mktemp -d)"
cleanup() {
  rm -rf "$WORK"
  if [ "${KEEP:-0}" != 1 ]; then rm -rf "$APP/node_modules" "$APP/.expo" "$APP/package-lock.json"; fi
}
trap cleanup EXIT

echo "node $(node -v) · npm $(npm -v) · $(date +%F)"

echo "== pack"
cd "$REPO"
pnpm build >"$WORK/build.log" 2>&1 || { tail -30 "$WORK/build.log"; exit 1; }
# pnpm pack rewrites `workspace:*` (see e2e/consumer.sh); it prints the absolute tarball path last.
TARBALL="$(pnpm pack --pack-destination "$WORK" | tail -n 1)"

echo "== install example-expo"
cd "$APP"
npm install >"$WORK/install.log" 2>&1 || { tail -30 "$WORK/install.log"; exit 1; }
# --no-save keeps the machine-specific tarball path out of package.json.
npm install --no-save "$TARBALL" >>"$WORK/install.log" 2>&1 || { tail -30 "$WORK/install.log"; exit 1; }
echo "expo $(node -p "require('expo/package.json').version") · react-native $(node -p "require('react-native/package.json').version") · react-native-svg $(node -p "require('react-native-svg/package.json').version")"

echo "== expo export (ios + web)"
OUT="$WORK/dist"
CI=1 npx expo export --platform ios --platform web --output-dir "$OUT" 2>&1 | tail -n 15
IOS="$(ls "$OUT"/_expo/static/js/ios/*)"
WEB="$(ls "$OUT"/_expo/static/js/web/*.js)"

echo "== assert ios ($(basename "$IOS"))"
node "$REPO/e2e/assert-bundle.mjs" "$IOS" --expect "$EXPECTED"
echo "== assert web ($(basename "$WEB"))"
node "$REPO/e2e/assert-bundle.mjs" "$WEB" --expect "$EXPECTED"

echo "== shouldWatch (unit level; no dev server is started)"
node -e "
const { shouldWatch } = require('rn-material-symbols/metro');
const cases = [
  [['node', 'expo', 'start'], {}, true],
  [['node', 'expo', 'export'], {}, false],
  [['node', 'expo', 'start'], { RN_MATERIAL_SYMBOLS_WATCH: '0' }, false],
];
let bad = 0;
for (const [argv, env, want] of cases) {
  const got = shouldWatch(argv, env);
  console.log(argv.join(' '), JSON.stringify(env), '->', got, got === want ? 'ok' : 'WRONG (want ' + want + ')');
  if (got !== want) bad++;
}
process.exit(bad ? 1 : 0);
"
echo "ALL OK"
