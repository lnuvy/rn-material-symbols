# Shared by e2e/consumer.sh and e2e/registry.sh (sourced, not run). The caller sets REPO, WORK and
# RESULTS before sourcing; the functions below write into $WORK and record steps in $RESULTS.

RN_VERSION=0.78.3
SVG_VERSION=15.13.0
EXPECTED="info,home,check_box,check_box_outline_blank,expand_less,expand_more,settings,schedule,cloud_download"

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

# make_template: a bare React Native $RN_VERSION app in $WORK/template, dependencies not installed.
make_template() {
  echo "react-native CLI $(npx --yes @react-native-community/cli@latest --version 2>/dev/null | tail -n 1)"
  echo "== template (react-native $RN_VERSION)"
  npx --yes @react-native-community/cli@latest init E2eApp --version "$RN_VERSION" \
    --skip-install --skip-git-init --directory "$WORK/template" >"$WORK/init.log" 2>&1 || { tail -30 "$WORK/init.log"; exit 1; }
  rm -rf "$WORK/template/__tests__"
}

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
  // icon-shaped strings that are not icons: the usage collection (0.3.0) must leave them out of the bundle
  const keyboard = { returnKeyType: 'search', mode: 'home' };
  void keyboard;
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

// the package's icon data (icons/<variant>.json since 0.3.0); package.json is an exported subpath
const info = require(require('path').join(require('path').dirname(require.resolve('rn-material-symbols/package.json')), 'icons', 'rounded.json')).info;

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

# check_app <pm> <engine> <runner>: in the current app dir, bundle for iOS and Android, assert the
# exact icon set, run Jest with <runner> test, and print the report and result lines.
#   engine  native | js | any: the final field the Metro report line must end with (any: not checked)
check_app() {
  local pm="$1" engine="$2" runner="$3"
  step "$pm" bundle-ios npx react-native bundle --platform ios --dev false --entry-file index.js \
    --bundle-output "$WORK/$pm-ios.jsbundle" --assets-dest "$WORK/$pm-ios-assets"
  if [ "$engine" != any ]; then
    # The report line is the last thing the scan prints; its final field names the engine that ran.
    step "$pm" engine grep -E "^\[rn-material-symbols\] .* · $engine\$" "$WORK/$pm-bundle-ios.log"
    # A missing platform package is the expected case for js: JS runs silently, no failure line.
    step "$pm" no-native-warning bash -c '! grep -E "native scanner failed|warning: rn-material-symbols-scanner-native" "$1"' _ "$WORK/$pm-bundle-ios.log"
  fi
  step "$pm" assert-ios node "$REPO/e2e/assert-bundle.mjs" "$WORK/$pm-ios.jsbundle" --expect "$EXPECTED"
  step "$pm" bundle-android npx react-native bundle --platform android --dev false --entry-file index.js \
    --bundle-output "$WORK/$pm-android.bundle" --assets-dest "$WORK/$pm-android-assets"
  step "$pm" assert-android node "$REPO/e2e/assert-bundle.mjs" "$WORK/$pm-android.bundle" --expect "$EXPECTED"
  step "$pm" jest $runner test
  grep -h "^\[rn-material-symbols\] " "$WORK/$pm-bundle-ios.log" 2>/dev/null | sed "s/^/  [$pm] /" || true
  grep -h "exact icon set" "$WORK/$pm-assert-ios.log" "$WORK/$pm-assert-android.log" 2>/dev/null | sed "s/^/  [$pm] /" || true
  grep -hE "^(Tests|Test Suites):" "$WORK/$pm-jest.log" 2>/dev/null | sed "s/^/  [$pm] /" || true
}

# summary: print the step table; exit 1 if any step failed.
summary() {
  echo "== summary (pm|step|exit|seconds)"
  cat "$RESULTS"
  if grep -qE '\|[1-9][0-9]*\|[0-9]+$' "$RESULTS"; then
    echo "FAILED steps above"
    exit 1
  fi
}
