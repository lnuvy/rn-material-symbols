# E2E: consumer install, bundles, Jest, Expo, Linux

Run on 2026-10-02, macOS (Darwin 25.5, arm64) for consumer and Expo, `node:22` Docker container (Linux 6.12.76-linuxkit) for Linux.
Tools: node v24.18.0, npm 11.16.0, pnpm 10.19.0, yarn 1.22.22, Docker 29.6.1 (container node v22.23.3).
The library is built (`pnpm build`) and packed once with `npm pack` (0.1.0, 1448 KB tarball). Every app installs that tarball, never the workspace.

## Matrix

| Target | install | ios bundle | android bundle | exact set | jest |
|---|---|---|---|---|---|
| npm (RN 0.78.3) | ok (14 s + 7 s) | exit 0 (8 s) | exit 0 (5 s) | ok, 9 icons, both bundles | 1 passed (2 s) |
| pnpm (RN 0.78.3) | ok (7 s + 6 s) | exit 0 (8 s) | exit 0 (6 s) | ok, 9 icons, both bundles | 1 passed (2 s), needs `transformIgnorePatterns` |
| yarn 1 (RN 0.78.3) | ok (15 s + 22 s) | exit 0 (8 s) | exit 0 (9 s) | ok, 9 icons, both bundles | 1 passed (3 s) |

Install timings are "app deps + library and `react-native-svg`". The bundle timings are `react-native bundle --dev false`.

| Target | ios export (Hermes bytecode) | web export | exact set |
|---|---|---|---|
| Expo SDK 57 (expo 57.0.26, RN 0.86.3, svg 15.15.4) | ok, 695 modules, 1.6 MB .hbc | ok, 398 KB | web: exact, 9 icons. ios: 9 icons found, `check_box_outline_blank` unconfirmed (see below) |
| `shouldWatch(['node','expo','start'], {})` | `true` (unit level, no dev server started) | `export` gives `false`, env `RN_MATERIAL_SYMBOLS_WATCH=0` gives `false` | |

| Target | result |
|---|---|
| Linux (`node:22`): `pnpm install --frozen-lockfile`, `build:icons`, `typecheck`, `test` | 13 suites, 95 tests passed (7.2 s). The first run had 1 failure (see Findings), fixed in the test. |

Expected icon set in every case (9): `info`, `home`, `check_box`, `check_box_outline_blank`, `expand_less`, `expand_more`, `settings`, `schedule`, `cloud_download`.
Source shapes used: literal, filled (`home`), ternary, template literal with a conditional (`expand_less` / `expand_more`), a name from a config object in another file (`settings`), alias (`access_time` resolves to `schedule`), safelist (`include: ['cloud_download']`).
Names-list leak check (limit 200): 52 hits in the bare bundles, 48 in the Expo web bundle, 13 in the Expo bytecode (names of 10+ characters only).

## Commands

```bash
pnpm e2e:consumer    # bash e2e/consumer.sh: npm, pnpm and yarn; PMS="npm" selects a subset; KEEP=1 keeps the temp dir
pnpm e2e:expo        # bash e2e/expo.sh: installs example-expo/, exports, asserts, checks shouldWatch
pnpm e2e:linux       # bash e2e/linux.sh: git archive HEAD into a temp dir, docker run node:22
node e2e/assert-bundle.mjs <bundle> --expect a,b,c [--pkg <installed rn-material-symbols>]
```

What `consumer.sh` runs per package manager:

```bash
npx @react-native-community/cli@latest init E2eApp --version 0.78.3 --skip-install --skip-git-init --directory <dir>
<pm> install ; <pm> add react-native-svg@15.13.0 <tarball>      # npm install ... / pnpm add ... / yarn add ...
npx react-native bundle --platform ios --dev false --entry-file index.js --bundle-output <f> --assets-dest <d>
npx react-native bundle --platform android --dev false ...
node e2e/assert-bundle.mjs <bundle> --expect info,home,check_box,check_box_outline_blank,expand_less,expand_more,settings,schedule,cloud_download
<pm> test
```

`metro.config.js` is the README minimal setup plus `{ include: ['cloud_download'] }`, with default sources (project root, no `watchFolders`). No pod install was run.

`expo.sh` runs `npx expo export --platform ios --platform web --output-dir <tmp>` with `CI=1`, then the assert on `_expo/static/js/ios/*.hbc` and `_expo/static/js/web/*.js`.
`example-expo/` was created with `npx create-expo-app@latest example-expo --template blank-typescript`, then `npx expo install react-native-svg react-dom react-native-web` (the last two are needed for the web export). The tarball is installed with `--no-save`, so no local path lands in `package.json`.

## Findings

1. **README was wrong about Jest under pnpm.** With the README's Jest config, pnpm fails before any test runs: `SyntaxError: Unexpected identifier 'ErrorHandler'` in `@react-native/js-polyfills/error-guard.js`, because the preset's default `transformIgnorePatterns` skips `node_modules/.pnpm`. The cause is the pnpm layout plus the React Native preset, not this library. The README now documents the `.pnpm` pattern (verified passing). The previous "if Jest fails to parse `react-native-svg`" note did not match what happened: real `react-native-svg` needed no transform under npm and Yarn 1.
2. **Hermes bytecode cannot confirm every icon separately.** Searching the raw `.hbc` for each icon path first reported 5 unexpected icons (`circle`, `brightness_1`, `crop_square`, `radio_button_unchecked`, `square`), and a stricter occurrence-count version then reported `check_box_outline_blank` missing. Both come from one fact: Hermes stores a string that is a substring of another inside it. The `circle` path is inside the `info` path, and the `check_box_outline_blank` path exists in the file only inside the `check_box` path (its count in the file is 1). `assert-bundle.mjs` therefore treats a path covered by a longer present path as embedded: it can satisfy an expected name, is never reported as unexpected, and the name is listed as "unconfirmed". The consequence is that the bytecode check is blind to an extra icon whose path is embedded in another present icon. The web bundle of the same export is a plain text bundle and is exact, and it comes from the same Metro graph and the same registry.
3. **A test failed on Linux.** `src/metro/scanProject.test.ts` ("an unwritable cacheFile does not fail the scan, and unchanged cache is not rewritten") compared `mtimeMs` for exact equality. Linux returned `1790935168815.999` for a time set to `...816`. The test now allows 1 s of tolerance (a rewrite would be 60 s away). No library change.

No library bug was found. The `withMaterialSymbols` behaviour matched the README in every run.

## Not verified

- Rendering on a simulator, emulator or device, for bare React Native and for Expo. Only JS bundles, Hermes bytecode (Expo only) and Jest renders were checked.
- Dev mode: HMR, `react-native start`, `expo start` end to end. The watch decision was checked as a unit (`shouldWatch`), no dev server was started.
- Expo Go, EAS builds, Expo Web in a browser (the bundle was inspected, the page was not loaded).
- Hermes bytecode of the bare React Native bundles. The consumer script bundles with `react-native bundle` without `--hermes`-style post-processing, so the bare assert ran on text bundles.
- CodePush or any OTA path.
- New Architecture turned off. Both apps used the template defaults.
- React Native below 0.78.3, React below 19, `react-native-svg` below 15.13, Yarn Berry, Bun, Windows.
- Linux watcher branch against a real Linux host filesystem. The container used a macOS bind mount; the watch tests passed there, but a native ext4 run was not done.
- pnpm `node-linker=hoisted` and other pnpm layouts. The default isolated layout was tested.
