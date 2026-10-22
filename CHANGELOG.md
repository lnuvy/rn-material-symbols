# Changelog

## 0.3.0 — 2026-10-22

All eight packages; the native scanner changed (it reports marker strings per file). Includes the unreleased 0.2.1 fixes.

- **Only what you render is bundled.** The new default `collect: 'usage'` traces `MaterialIcon` uses (literals, conditionals, `const` and object/array maps across files, import aliases, namespace imports, barrels, `createElement`, and wrapper components that pass their props on) instead of collecting every icon-shaped string. Strings like `returnKeyType: 'search'` are no longer icons. A use that cannot be traced bundles the icon names written in that file and the files it imports, and prints the file and line. `collect: 'literals'` keeps the 0.2 behavior.
- **Only the shapes you render are bundled.** Each icon ships its unfilled path, its filled path, or both, following `filled`. Rendering a shape that was not bundled shows a blank icon and reports it like a missing icon.
- **Smaller paths.** Coordinates are snapped to the integer grid of the 960-unit box (largest point shift 2 units, 0.05 px at 24 px): about 14% fewer characters and 22% less after gzip over all rounded paths.
- **One module.** The generated registry inlines the paths it uses (no module per icon). Variants written in source (`variant="outlined"`) are bundled automatically.
- **Package layout (breaking).** Icon data is one file per variant, `icons/<variant>.json`, instead of 11,874 modules; the `rn-material-symbols/icons/*` export is removed. Package files: 11,910 → 12 (approximately; see `npm pack`).
- `MaterialIcon` never throws on a bad lookup (malformed registry, non-string `name`/`variant`, keys like `constructor`); release builds log misses with `console.error`; reporting never throws.
- Native scanner: per-file markers; cache revision 2 (old caches are discarded).
- Versioning: the library may be ahead of the native packages by patch (`scripts/check-versions.mjs`), for later JS-only fixes.

## 0.2.0 — 2026-10-16

- Optional native (Rust) source scanner, `rn-material-symbols-scanner-native`, installed through `optionalDependencies` with one prebuilt binary package per platform (macOS arm64/x64, Linux x64 glibc/musl, Linux arm64 glibc, Windows x64). About 3–4x faster than the JS scanner on a 49,332-file source tree (cold 1.55 s vs 5.73 s, warm 0.48 s vs 1.44 s, macOS arm64). It finds every name the JS scanner finds in value positions; the JS scanner stays the reference, and the known differences (all in type positions or extra names) are listed in the README.
- New option `scanner: 'auto' | 'js' | 'native'` (default `'auto'`) and env var `RN_MATERIAL_SYMBOLS_SCANNER`. `'auto'` falls back to the JS scanner when no binary exists for the platform (silently) or when the binary fails to load or throws (with one log line). `'native'` fails with a clear error instead.
- The Metro report line now ends with the scanner that ran: `· js` or `· native`.
- The native scanner keeps its own cache file, `scan-cache.native.json`, next to `scan-cache.json`.
- Fix: no false "was not found as a string literal" dev warning when an icon is added during HMR. The missing-icon warning now waits 2 s and re-checks the current registry first (dev only).
- Publishing: the packages must be packed by pnpm (`pnpm publish`, or `npm publish` of the tarballs CI packs), platform packages first, then the loader, then this package (`docs/PUBLISHING.md`).

## 0.1.0 — 2026-10-02

First release (v1). Never published to npm; 0.2.0 is the first npm release. See README for usage and the full verification status.

- Verification status: verified on bare React Native 0.78.3 production bundles (iOS and Android) and a scanner benchmark. Not yet verified: simulator rendering/HMR, Expo and Expo Web, CodePush OTA, New Architecture off, Hermes bytecode, react-native-web, Windows.
- `MaterialIcon` component: `name`, `size` (24), `color` ('black'), `filled` (false), `rotate` (0), `variant` ('rounded'), plus `SvgProps`.
- `rn-material-symbols/metro`: `withMaterialSymbols(config, options)` scans your source for icon names and bundles only those icons.
- Options: `variants`, `sources`, `exclude`, `includeTests`, `include`, `watch`, `warnAboveIcons`, `cacheDir`.
- `rn-material-symbols/jest`: `moduleNameMapper` that resolves every icon in tests.
- Data: Google Material Symbols, opsz 24, w400, GRAD 0, FILL 0/1, three styles (rounded, outlined, sharp) x w400 x fill; 3,927 symbols, 255 legacy aliases, 31 standalone legacy names.

### Before publishing

- add `repository`, `bugs`, `homepage` once the GitHub repo exists
