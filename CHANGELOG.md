# Changelog

## 0.2.0 — unreleased

- Optional native (Rust) source scanner, `rn-material-symbols-scanner-native`, installed through `optionalDependencies` with one prebuilt binary package per platform (macOS arm64/x64, Linux x64 glibc/musl, Linux arm64 glibc, Windows x64). About 3–4x faster than the JS scanner on a 49,332-file source tree (cold 1.55 s vs 5.73 s, warm 0.48 s vs 1.44 s, macOS arm64). It finds every name the JS scanner finds in value positions; the JS scanner stays the reference, and the known differences (all in type positions or extra names) are listed in the README.
- New option `scanner: 'auto' | 'js' | 'native'` (default `'auto'`) and env var `RN_MATERIAL_SYMBOLS_SCANNER`. `'auto'` falls back to the JS scanner when no binary exists for the platform (silently) or when the binary fails to load or throws (with one log line). `'native'` fails with a clear error instead.
- The Metro report line now ends with the scanner that ran: `· js` or `· native`.
- The native scanner keeps its own cache file, `scan-cache.native.json`, next to `scan-cache.json`.
- Publishing: the packages must be published with pnpm, platform packages first, then the loader, then this package (README "Before publishing").

## 0.1.0 — 2026-10-02

First release (v1). See README for usage and the full verification status.

- Verification status: verified on bare React Native 0.78.3 production bundles (iOS and Android) and a scanner benchmark. Not yet verified: simulator rendering/HMR, Expo and Expo Web, CodePush OTA, New Architecture off, Hermes bytecode, react-native-web, Windows.
- `MaterialIcon` component: `name`, `size` (24), `color` ('black'), `filled` (false), `rotate` (0), `variant` ('rounded'), plus `SvgProps`.
- `rn-material-symbols/metro`: `withMaterialSymbols(config, options)` scans your source for icon names and bundles only those icons.
- Options: `variants`, `sources`, `exclude`, `includeTests`, `include`, `watch`, `warnAboveIcons`, `cacheDir`.
- `rn-material-symbols/jest`: `moduleNameMapper` that resolves every icon in tests.
- Data: Google Material Symbols, opsz 24, w400, GRAD 0, FILL 0/1, three styles (rounded, outlined, sharp) x w400 x fill; 3,927 symbols, 255 legacy aliases, 31 standalone legacy names.

### Before publishing

- add `repository`, `bugs`, `homepage` once the GitHub repo exists
