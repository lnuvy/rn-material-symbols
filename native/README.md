# rn-material-symbols-scanner-native

The optional native (Rust) source scanner for `rn-material-symbols`.

You do not need to install or import this package. `rn-material-symbols` lists it under `optionalDependencies`, and its Metro plugin (`withMaterialSymbols` from `rn-material-symbols/metro`) uses it when a prebuilt binary for your platform is available. If none is, the JS scanner runs instead. The scanner to use is chosen with the `scanner` option (`'auto'`, `'js'` or `'native'`) or the `RN_MATERIAL_SYMBOLS_SCANNER` environment variable.

This package is only a loader: it pulls in one platform package with the prebuilt binary (macOS arm64 and x64, Linux x64 glibc and musl, Linux arm64 glibc, Windows x64). Nothing is compiled on install. Its API is internal to `rn-material-symbols` and may change in any release; keep the two packages on the same major.minor version.

See the `rn-material-symbols` README ("Performance and the native scanner") for details and known differences from the JS scanner.

License: Apache-2.0.
