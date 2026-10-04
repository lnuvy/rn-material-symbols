# rn-material-symbols

Google Material Symbols for React Native, by name. Only the icons your source code uses end up in the bundle.

```tsx
<MaterialIcon name='info' />
```

## Why

- **Metro (as used by bare React Native) does not tree-shake unused entries out of an icon map, and Expo's tree shaking is experimental and opt-in.** Importing a package that exposes thousands of icons ships all of them. This library generates a small registry at Metro start-up that contains only the icons your source mentions.
- **Name-based API.** No per-icon imports or registration step. 3,927 symbols plus legacy names, type-checked.
- **Pure JS plus `react-native-svg`** at runtime — no font files and no native code in your app — so it should work with OTA updates such as CodePush: two release bundles that differ by one added icon differ only in the JS bundle, with identical assets (a real CodePush deployment is not verified). The optional native scanner (see [Performance and the native scanner](#performance-and-the-native-scanner)) runs only inside Metro, on your machine, and never ships in the app.

## Install

```bash
npm install rn-material-symbols react-native-svg
```

- iOS (bare React Native): run `cd ios && pod install` after adding `react-native-svg`.
- Expo: use `npx expo install react-native-svg` so the version matches your SDK.

Peer dependencies: `react >= 18`, `react-native >= 0.72`, `react-native-svg >= 13`. Node >= 20 for the Metro plugin.

## Metro setup

```js
// metro.config.js
const { getDefaultConfig } = require('@react-native/metro-config');
const { withMaterialSymbols } = require('rn-material-symbols/metro');
module.exports = withMaterialSymbols(getDefaultConfig(__dirname));
```

### Expo (Metro)

```js
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');
const { withMaterialSymbols } = require('rn-material-symbols/metro');
module.exports = withMaterialSymbols(getDefaultConfig(__dirname));
```

Verified with Expo SDK 57 (`expo` 57.0.26, React Native 0.86.3, `react-native-svg` 15.15.4 from `npx expo install`): `npx expo export --platform ios --platform web` bundles exactly the icons used in source, in both the iOS Hermes bytecode and the web JavaScript bundle (`example-expo/`, `pnpm e2e:expo`). In Hermes bytecode, an icon path that is a substring of another icon's path cannot be told apart, so the bytecode check can miss an extra or missing icon in that case; the web bundle from the same export is checked exactly. On the iOS simulator, the dev build renders and picks up an added icon through HMR in about 0.54 s, Expo Go 57.0.9 renders, and Expo web renders in Chromium with SVG paths that match the package's icons. Not verified: Expo on Android, real devices, HMR in Expo Go or on the web. See [Verification status](#verification-status).

## Usage

```tsx
import { MaterialIcon } from 'rn-material-symbols';

<MaterialIcon name='info' />                         // rounded, 24, black, unfilled
<MaterialIcon name='info' size={16} color='#1C7ED6' filled />
<MaterialIcon name='chevron_right' rotate={90} />
<MaterialIcon name='home' variant='outlined' />      // 'outlined' must be listed in `variants`
<MaterialIcon name='access_time' />                  // legacy name, same shape as 'schedule'
```

| Prop | Default | Notes |
|---|---|---|
| `name` | required | `MaterialSymbolName \| MaterialSymbolAlias`. A typo is a type error. A `string` from a server needs `as MaterialSymbolName`. |
| `size` | `24` | px |
| `color` | `'black'` | any `ColorValue` |
| `filled` | `false` | FILL axis |
| `rotate` | `0` | degrees. `style.transform` wins when both are given |
| `variant` | `'rounded'` | `'rounded' \| 'outlined' \| 'sharp'`. Must be listed in `variants` |

Any other `SvgProps` are passed to the underlying `Svg`. Under the hood it renders `<Svg viewBox="0 -960 960 960">` with one `<Path>`.

If an icon is missing from the registry, the component does not crash. It renders an empty `Svg` of the same size and, in development, warns once per icon with a hint (see [Troubleshooting](#troubleshooting)). The warning comes about 2 s after the first render and only if the icon is still missing then: during HMR, the file you saved can render once before the regenerated registry arrives.

## Options

```js
withMaterialSymbols(config, options)
```

| Option | Default | Description |
|---|---|---|
| `variants` | `['rounded']` | Styles to bundle: `'rounded'`, `'outlined'`, `'sharp'`. Each extra style multiplies the bundled size. Unknown values throw. |
| `sources` | `[projectRoot]` | Files or directories to scan, resolved against `projectRoot`. |
| `exclude` | `[]` | Extra globs to skip, appended to the default excludes. Matched relative to each source root. Absolute-path globs are not supported. |
| `includeTests` | `false` | Drop the default excludes (scan stories and tests too). Useful for Storybook apps. |
| `include` | `[]` | Safelist of names (or legacy names) to always bundle. Unknown names throw. |
| `watch` | auto | Rescan when files change. Auto: on for `start` and `run-*`, off for `bundle` and `export`. The env var `RN_MATERIAL_SYMBOLS_WATCH=1\|0` overrides this. |
| `warnAboveIcons` | `800` | Print a warning with the top offending files when more icons than this are found. |
| `cacheDir` | `<projectRoot>/node_modules/.cache/rn-material-symbols` | Where the generated registry and the scan cache live. |
| `scanner` | `'auto'` | `'auto' \| 'js' \| 'native'`. Which source scanner runs. `'auto'` uses the native scanner when its binary is installed and loads, else the JS scanner. `'native'` fails with a clear error when the binary is missing or broken. The env var `RN_MATERIAL_SYMBOLS_SCANNER=auto\|js\|native` overrides this. Unknown values throw. See [Performance and the native scanner](#performance-and-the-native-scanner). |

Default excludes: `**/*.stories.*`, `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`, `dist/**`, `web-build/**` (the last two are anchored at each source root and cover Expo web export output).

Each Metro start prints one line, for example:

```
[rn-material-symbols] rounded 8 icons · 5.4 KB · aliases 1 · safelist 1 · 2 files (8ms) · js
```

The last field is the scanner that ran: `js` or `native`.

## Dynamic names

The scanner reads your source with a parser (JS scanner: Babel; native: oxc) and collects string literals that are Material Symbols names. So this works, because the literals appear in your source:

```tsx
const TABS = [{ icon: 'home' }, { icon: 'settings' }];
// ...
<MaterialIcon name={tab.icon} />
```

Template literals work too when the names are literals inside the expressions: `` `${open ? 'expand_less' : 'expand_more'}` `` finds both. A name built by concatenation (`` `${base}_filled` ``) cannot be found.

Names that only exist at runtime (for example a value from your server) cannot be found. Add them to the safelist:

```js
module.exports = withMaterialSymbols(config, { include: ['cloud_download'] });
```

## Monorepos

Add shared packages to `sources`:

```js
withMaterialSymbols(config, { sources: ['src', '../../packages/ui/src'] });
```

## Type unions and name lists

Any file that contains many icon names as string literals (a union type, a list of names for a picker) is scanned like any other file, and all of those icons get bundled. When more than `warnAboveIcons` icons are found, Metro prints the top files:

```
[rn-material-symbols] warning: more than 800 icons. A type union or a list of icon names may have been scanned. Top files:
  src/types/icons.ts (3927)
```

Exclude them if they are not used at runtime. Globs are relative to each source root. A pattern starting with `**/` matches at any depth; any other pattern is anchored at the root, so `src/types/icons.ts` does not match `lib/src/types/icons.ts`:

```js
withMaterialSymbols(config, { exclude: ['src/types/icons.ts', '**/icon-names.*'] });
```

## Jest

```js
// jest.config.js
module.exports = {
  preset: 'react-native',
  moduleNameMapper: { ...require('rn-material-symbols/jest').moduleNameMapper },
};
```

Tests then resolve every icon, with no Metro involved.

With npm, Yarn 1 and Bun the `react-native` preset works as is (verified with a bare React Native 0.78.3 app, real `react-native-svg`, no mocks).

With pnpm, the preset's default `transformIgnorePatterns` skips everything under `node_modules/.pnpm`, so React Native's own Jest setup fails with `SyntaxError: Unexpected identifier 'ErrorHandler'` before any test runs. This is a pnpm and React Native preset issue, not specific to this library. Allow `.pnpm` through:

```js
// jest.config.js (pnpm)
module.exports = {
  preset: 'react-native',
  moduleNameMapper: { ...require('rn-material-symbols/jest').moduleNameMapper },
  transformIgnorePatterns: ['node_modules/(?!(\\.pnpm|(jest-)?react-native|@react-native(-community)?)/)'],
};
```

## Using outside Metro (webpack, Vite, Next)

The registry is built by the Metro plugin. Without Metro, `rn-material-symbols/registry` resolves to an empty stub: every icon renders blank and the dev warning says `withMaterialSymbols is not configured`. Icons render only when `rn-material-symbols/registry` is aliased to the full registry at `<package root>/lib/registry/all.js` (an absolute path, as `rn-material-symbols/jest` does; `lib/` is not in the package `exports`). That registry has no pruning, and it loads icon files from disk with `fs` and a runtime `require`, the way Jest needs. It was checked only in Node (react-native-web 0.20 `renderToString` produced the correct path). A browser build with a real web bundler is not verified, and the `fs`-based loading is not expected to work there.

## Troubleshooting

**An icon renders as blank space.** The dev warning says why:

- `withMaterialSymbols is not configured` — wrap your Metro config as shown above, then restart Metro with `--reset-cache`.
- `variant 'x' is not bundled` — add it to `variants`.
- `'x' (variant) was not found as a string literal in your sources, or is not a Material Symbols name` — check the spelling. If the name comes from a server, add it to `include`. If it lives in a folder outside the project, add that folder to `sources`.

**A new folder is not picked up (Linux).** Directories created while Metro is running are not watched on Linux. Restart Metro.

### Known limitations

- Common words that are also icon names (`ios`, `android`, `error`, `label`, `start`) are included whenever they appear as string literals anywhere in scanned sources. Expect some extra icons, roughly 1 KB each.
- Moving or renaming a directory while Metro runs is not picked up until the next file change or a restart.
- Symlinked directories are not followed. List the real path in `sources`.
- A bare string statement at the top of a file is a directive and is not scanned.
- Icons whose paths are identical (some legacy aliases share a shape with their target) are indistinguishable in the bundle.

## Data source and versions

Paths come from the Google Fonts CDN (`fonts.gstatic.com`) at opsz 24, weight 400, GRAD 0, FILL 0 and 1, in the rounded, outlined and sharp styles. The snapshot contains 3,927 symbols, 255 legacy aliases (old names that map to a current symbol) and 31 standalone legacy names. It was fetched on 2026-10-02 (`data/meta.json`, `fetchedAt`).

Measured on a monorepo-sized app (4,111 source files, no `node_modules`, Babel parser, macOS): a cold scan takes about 0.5 s and a warm scan about 0.1 s with the JS scanner. For much larger source trees, see [Performance and the native scanner](#performance-and-the-native-scanner). See `docs/poc/` for the measurements.

## Performance and the native scanner

The native scanner is an optional dependency. If no prebuilt binary exists for your platform, the JS scanner is used automatically; the report line ends with `· js` or `· native`.

`rn-material-symbols` lists `rn-material-symbols-scanner-native` under `optionalDependencies`, and that package pulls in one prebuilt binary package for your platform: macOS arm64 and x64, Linux x64 (glibc and musl) and arm64 (glibc), Windows x64. Nothing is compiled on install. The native scanner is a Rust port of the JS scanner (the [oxc](https://oxc.rs) parser, files scanned in parallel) and finds every name the JS scanner finds (see [Known differences](#known-differences-from-the-js-scanner)); the JS scanner is the reference implementation. It keeps its own cache file next to the JS one (`scan-cache.native.json`).

- `scanner: 'auto'` (default): native when the binary loads, otherwise JS. If the binary is installed but fails to load, or the native scan throws, Metro logs one line (`native scanner failed, used JS: …`) and the JS scanner runs. A missing binary for your platform is silent. Metro never stops because of the native scanner in this mode.
- `scanner: 'js'`: always JS.
- `scanner: 'native'`: native or a clear error at Metro start.

If the major.minor versions of the two packages differ, Metro prints a warning and still uses the native scanner.

**Restart Metro after installing or building the native binary.** Whether it loads is decided once per Metro process.

### Measurements

Wall time around one `scanProject()` call, median of 5 runs, both engines on the same inputs. "Cold" deletes the engine's own scan cache before the run; "warm" is the next run with that cache. Names found, per-file results and fallback counts were identical between the engines on both corpora.

| Corpus | Files | Engine | Cold median | Warm median |
|---|---|---|---|---|
| 12 copies of a private 4,111-file app (49,332 files) | 49,332 | JS | 5.73 s | 1.44 s |
| 12 copies of a private 4,111-file app (49,332 files) | 49,332 | native | 1.55 s | 0.48 s |
| synthetic (`scripts/gen-corpus.ts --files=50000 --seed=42`) | 50,000 | JS | 3.64 s | 0.35 s |
| synthetic (`scripts/gen-corpus.ts --files=50000 --seed=42`) | 50,000 | native | 1.18 s | 0.16 s |

That is 3.7x (cold) and 3.0x (warm) faster on the private corpus, 3.1x and 2.3x on the synthetic corpus.

Conditions: Apple M5 Pro, 18 logical CPUs (6 performance + 12 efficiency cores), 48 GB, macOS (Darwin 25.5.0, arm64), Node 24.18.0, release build of the native scanner with its default thread pool (one thread per logical CPU). The OS file cache was warm for every run (no `purge`); only the scanner's own cache was removed for "cold". The first scan after a reboot can be slower. Linux and Windows were not measured.

The warm native result on the private corpus is 20 ms under the 0.5 s target (one of the 5 runs took 0.62 s). Most of it is walking about 18,800 directories (around 350 ms), which did not get faster with more than 8 threads. On a machine with 4 cores or fewer, expect warm scans of that size to take about 0.5–0.7 s (Estimated from 4-thread runs on the machine above; not measured on such a machine), which is still 2–3x faster than JS. Full numbers and method: `docs/poc/2026-10-native-g4.md`.

### Known differences from the JS scanner

Every icon the JS scanner finds in a value position (code that runs: JSX props, arguments, object values, …), the native scanner finds too. Files the native parser cannot handle fall back to regex scanning, and each of those is then scanned again with the JS extractor (on every run; they are never cached) and the names are merged in. The only names the native scanner can miss are strings in type positions (`x: 'home'`) that the JS scanner picks up when its own parser rejects a file that the native parser accepts and it falls back to the regex (see "Some invalid code" below); a type-position string never reaches a rendered icon. The differences:

- **Flow syntax in `.js` files.** The JS scanner parses Flow; the native parser cannot, so those files go through the regex fallback plus the JS re-scan. The result has every name the JS scanner finds, and may have a few extra icons (the regex does not skip string literals in type positions).
- **Very deep nesting.** Files with more than 300 nested brackets fall back to regex scanning (plus the JS re-scan), as do files that are too large for a safe stack bound (around 1 MB of punctuation). The JS scanner falls back on deep nesting too, at a similar depth (around 300–400 levels).
- **Escapes in the regex fallback.** The native regex fallback cannot decode escape sequences (`'\u0068ome'`). The JS re-scan of the same file recovers such names whenever the JS parser can parse the file; when neither parser can, both scanners use the regex and both miss them.
- The "files fell back to regex scanning" count only includes files that the JS extractor could not parse either.
- **Some invalid code.** For a few syntax errors that Babel rejects and oxc accepts (for example `override` in a class without a superclass, or a TypeScript `export { Undeclared }`), the JS scanner falls back to regex and includes names from type positions (`class C { override m(x: 'home') {} }` gives `home`), while the native scanner parses the file normally and skips them. Names in value positions are found by both.
- When several files cannot be read, the error message may name a different file than the JS scanner would.
- **Names written only as HTML entities.** An icon name written only with HTML entities in JSX (`name="ho&#109;e"`) is not detected by either scanner (the candidate prefilter looks for plain quoted names). Write the name plainly or add it to `include`.

### Developing the native scanner

- Build: `pnpm build:native` (needs a Rust toolchain and a C compiler). Tests: `pnpm test:native` and `cargo test --release --manifest-path native/Cargo.toml`; the stack-depth table is only exercised by the release run. `pnpm test` runs the JS↔Rust parity tests when a binary is present and skips them otherwise; set `RNMS_REQUIRE_NATIVE=1` to make a missing binary fail instead.
- After pulling the change that added `native/npm/*` to the workspace, delete and reinstall `node_modules` (`rm -rf node_modules native/node_modules && pnpm install`): the `hoistPattern` in `pnpm-workspace.yaml` only applies to a fresh install, and one test fails with a "reinstall node_modules" message until then.
- Android emulator rendering of the bare React Native 0.78.3 example (2026-10-05, Pixel 7 AVD, API 35, arm64-v8a, at commit 161546d, `example/` unmodified except `newArchEnabled` toggled for the Old Architecture run; logs and screenshots are not committed):
  - Debug build, New Architecture (`fabric: true` in logcat), native scanner: report line `2 files (5ms) · native`, all 8 icons render.
  - Dev-mode HMR, 3 saves per engine: save to rescan line 104-106 ms with both engines; save to icon visible median 745 ms (native) and 713 ms (JS), polled with `screencap` at about 350-400 ms resolution. No "was not found" warning in any of the 6 reps, while a control with a non-icon name did warn. This confirms the deferred missing-icon warning fix on a real HMR.
  - Release build (Hermes bytecode, Metro stopped): all 8 icons render. The bytecode holds the exact icon set, with the same substring caveat (`check_box_outline_blank` unconfirmed).
  - Old Architecture (`newArchEnabled=false`), debug: all 8 icons render.
  - Toggle tap works on both architectures (the checkbox toggles and returns to an identical screenshot on the second tap).
- Native scanner CI (GitHub Actions run 37217141591 at commit 161546d): all 6 targets build (aarch64 and x86_64 apple-darwin, x86_64 and aarch64 linux-gnu, x86_64 linux-musl, x86_64 windows-msvc). The parity suite with `RNMS_REQUIRE_NATIVE=1` passes against each CI-built binary on its own runner (Windows included; musl in an Alpine container), `cargo test --release` passes on macOS, Ubuntu and Windows, and the `assemble` job (packaging and version check) passes. The `ci` run 37217141572 passes on macOS and Ubuntu. Benchmarks were run only on macOS arm64.
- `node scripts/check-versions.mjs` checks that the root, loader, platform packages, `native/Cargo.toml` and the loader's pinned version agree; `--packed <dir>` also checks packed tarballs.
- When upgrading oxc, re-run the stack-headroom binary search: measure the depth at which each construct overflows a 2 MB thread with the stack guard bypassed, update `OVERFLOW_AT_2MB` and, if the 2x headroom no longer holds, `STACK_PER_PUNCT_BYTE` / `STACK_PER_OTHER_BYTE` / `MAX_NESTING` in `native/src/extract.rs`. A native stack overflow kills Metro and cannot be caught.
- Restart Metro after rebuilding the binary (see above).

### Before publishing

Run by a maintainer, in this order. Publish with pnpm: it rewrites the `workspace:*` dependencies to real versions, npm does not. (Unverified: nothing has been published yet.)

1. Bump the version in `package.json`, `native/package.json` and `native/Cargo.toml`, then `pnpm --filter rn-material-symbols-scanner-native exec napi version` to sync `native/npm/*/package.json`, rebuild so `native/index.js` pins the new version, and run `node scripts/check-versions.mjs`.
2. Get the six binaries from the `build` job of `.github/workflows/native.yml` (artifacts `bindings-<target>`), put them in `native/artifacts/`, and run `pnpm exec napi artifacts -o artifacts` in `native/`. Check with `pnpm exec napi pre-publish -t npm --dry-run` in `native/`: it fails if any platform package lacks its `.node` (the `assemble` job runs the same check and uploads the tarballs).
3. Release gate on a machine with a Rust toolchain: `PMS="npm-native npm-js" bash e2e/consumer.sh` verifies whatever is assembled for this machine: it packs a temp copy of the platform package (using the `.node` from step 2 untouched, printing `using assembled artifact … (sha256 …)`; only when none is assembled does it build one into the temp copy and print `using local build`; it never writes into `native/npm/`), installs the platform, loader and library tarballs into a fresh React Native app and asserts the report line ends with `· native`, and with `· js` without the platform tarball.
4. Recommended (Unverified): publish all eight packages to a local registry such as Verdaccio first, and install the library from it with npm, pnpm, Yarn 1, Yarn Berry and Bun.
5. Publish the six platform packages first (`pnpm publish` in each `native/npm/<platform>/`) and confirm each one with `npm view <package>@<version> version`. Only then publish the loader (`pnpm publish` in `native/`), confirm it the same way, and publish the library last (`pnpm publish` at the root). Order matters: Yarn 1 and Yarn Berry 4 refuse to install a package whose optional dependency is not on the registry (Yarn 1: `Couldn't find package "rn-material-symbols-scanner-native@…"`; Yarn Berry: `YN0035 … Package not found`, 404), so the library must not be published before the loader, nor the loader before all six platform packages.

## Verification status

Verified (details and commands in `docs/poc/2026-10-e2e-consumer.md`; the items dated 2026-10-03 were run from local clones, and their logs and screenshots are not committed):

- Bare React Native 0.78.3 installed from the packed tarball with npm, pnpm 10.19 and Yarn 1.22.22 (version 0.1.0; from 0.2.0 on, Yarn 1 and Yarn Berry can install the library only once the native packages of the same version are on the registry, so `e2e/consumer.sh` skips Yarn until then): production bundles for iOS and Android (`react-native bundle --dev false`). The bundled icon set exactly equals the icons used in source (literal, ternary, template literal, config object in another file, alias, `include` safelist), and the 3,927-name list does not leak into the bundle.
- Jest with the setup from this README (real `react-native-svg`, no mocks) renders the `info` path under npm, pnpm and Yarn 1. pnpm needs the `transformIgnorePatterns` shown above.
- Expo SDK 57: `expo export` for iOS (Hermes bytecode) and web. The exact set holds in the web bundle. In the bytecode the check is lenient for one case: Hermes stores a string that is a substring of another inside it, so an icon whose path is contained in another icon's path cannot be confirmed separately (`check_box_outline_blank` inside `check_box` here). That icon is reported as unconfirmed, and the web bundle from the same export confirms it.
- iOS simulator rendering of the bare React Native 0.78.3 example (`example/`, iPhone 17 simulator, iOS 26.5, details in `docs/poc/2026-10-e2e-ios.md`): all 8 icons render on the New Architecture (Fabric confirmed in the console) and with the New Architecture turned off (`RCT_NEW_ARCH_ENABLED=0`). Those first runs used an out-of-repo Metro config.
- Second iOS simulator round (2026-10-03, committed `example/metro.config.js` unmodified, New Architecture):
  - Native scanner: report line ending in `· native`, all 8 icons render.
  - Dev-mode HMR, 3 saves per engine, each adding an icon to `App.tsx`: median save to rescan line 108 ms (mostly the watcher's 100 ms debounce; the scan itself took 3–7 ms on this 2-file app), save to icon visible about 0.45 s with the native scanner and about 0.49 s with the JS scanner. Visibility was polled with simulator screenshots, which take about 250–300 ms each, so that is the resolution. Numbers from a 2-file app say nothing about scan cost in large projects.
  - Release configuration on the simulator: all 8 icons render with no Metro running. The Hermes bytecode (`main.jsbundle`) holds the exact icon set, with the substring caveat described for Expo above (`check_box_outline_blank` unconfirmed).
  - Not tested: the toggle tap (iOS), and the New Architecture turned off in this round. Under Xcode 26.6, React Native 0.78 needed a local `Pods/fmt` patch (a toolchain issue, not the library).
- Expo SDK 57 on the iOS simulator (2026-10-03): the dev build renders all 6 icons on screen; HMR, 3 saves, median save to rescan line 146 ms and save to icon visible about 0.54 s. Expo Go 57.0.9 renders the same icons (HMR in Expo Go not measured). Expo web from `expo start --web`, opened in Chromium: 6 `svg` elements whose `path d` values match the package's icon files, no console errors or warnings.
- Hermes bytecode of the bare React Native production bundles (iOS and Android, compiled with React Native's `hermesc -O`): the exact icon set, with the same substring caveat (`check_box_outline_blank` unconfirmed). The bytecode was not executed in this check (the Android release build was run on an emulator, see above).
- OTA-equivalent check (not a CodePush deployment): release bundles v1 and v2 (v2 adds one icon) built for iOS and Android. Each holds its exact icon set, and only the JS bundle file differs between them; the asset files are identical.
- Package managers on 0.2.0 tarballs (bare React Native 0.78.3, macOS arm64): Bun 1.4.2 installs the library alone (only 404 warnings for the unpublished native packages; report line `· js`) and with the native tarballs (`· native`); the iOS and Android bundles hold the exact icon set and Jest passes. Yarn Berry 4.14.1 (`nodeLinker: node-modules`) fails before the native packages are published, as Yarn 1 does; with `resolutions` pointing the optional packages to local tarballs (an emulation, not a normal install) bundles and Jest pass.
- react-native-web in Node: with `rn-material-symbols/registry` aliased to `lib/registry/all.js`, `renderToString` produces the correct `svg` and `path`; with the default stub it renders an empty `svg` and the "not configured" warning. See [Using outside Metro](#using-outside-metro-webpack-vite-next).
- Linux (`node:22` container, Linux 6.12): install, icon build, typecheck and the full test suite, including the Linux per-directory watcher branch.
- Scanner benchmark on a 4,111-file monorepo-sized app (G3).
- Native scanner (macOS arm64): the packed platform, loader and library tarballs installed with npm into a fresh bare React Native 0.78.3 app give a report line ending in `· native`, and without the platform tarball `· js` with no error or warning; both bundles hold the exact icon set and Jest passes (`PMS="npm-native npm-js" bash e2e/consumer.sh`). JS↔native parity on the test suite and on two 50,000-file corpora (`docs/poc/2026-10-native-g4.md`).
- Native scanner on Linux arm64 (Docker on an arm64 Mac; `node:22` Debian glibc 2.36 and `node:22-alpine` musl): built from source in the container, the parity suite with `RNMS_REQUIRE_NATIVE=1` and `cargo test --release` pass against that binary. Linux arm64 musl is not a published target.

Not yet verified:

- Real devices (iOS and Android), Expo on Android, Android ABIs other than arm64-v8a, an Android release build with the New Architecture off, and the iOS toggle tap
- HMR in Expo Go and on the web, and Expo web's static `expo export` output served in a browser (only the dev server page was opened)
- A real CodePush deployment (only the OTA-equivalent bundle comparison above)
- react-native-web in a browser with a real web bundler (webpack, Vite, Next)
- Windows and macOS file-watching of directories created at runtime
- Yarn Berry with the PnP linker, Bun running Metro on its own runtime (`bun --bun`), and installs from a published registry with any package manager
- Installing the native scanner from the registry with pnpm or Yarn 1 (only local tarballs with npm were tested; see [Before publishing](#before-publishing)). Benchmarks on platforms other than macOS arm64

The peer ranges (`react-native >=0.72`, `react >=18`, `react-native-svg >=13`) were tested only with React Native 0.78.3 / React 19.0.0 / react-native-svg 15.13.0 (bare) and React Native 0.86.3 / React 19.2.3 / react-native-svg 15.15.4 (Expo SDK 57). Nothing below those versions was run.

## Non-goals (v1)

- Weights other than 400, GRAD, and optical sizes other than 24 (the package would grow to tens of MB).
- Web bundler plugins (Vite, webpack). This library targets Metro.
- Bundling names that only a server knows. Use `include`.
- Runtime network fetching.
- Design-token resolution. `color` takes a `ColorValue`.
- Web-only props (`onClick`, `className`). Wrap the icon in `Pressable`.
- Multicolor icons and brand logos.
- A Babel plugin that rewrites JSX. Scanning the source is a superset.
- Dependency-graph-based collection.

## License

Apache-2.0. See `LICENSE` and `NOTICE`. Material Symbols are provided by Google under the Apache License 2.0.
