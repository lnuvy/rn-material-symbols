# Publishing to npm

A maintainer runbook for releasing the eight packages. The short form is README
[Before publishing](../README.md#before-publishing); this file has the exact commands, the checks
between them, and what to do when a step fails.

Status: written for 0.2.0, the first version to reach npm (0.1.0 was never published). Run so
far: steps 2–4 (2026-10-11 and 2026-10-15; `e2e/registry.sh` ran the step 5 order and commands
against a local Verdaccio), and the pre-release stop of step 6. Unverified: steps 0, 1, 5 and 7, and
the install path of step 6, all of which need registry.npmjs.org.

## The eight packages

| Order | Package | Directory |
| --- | --- | --- |
| 1–6 | `rn-material-symbols-scanner-native-{darwin-arm64, darwin-x64, linux-arm64-gnu, linux-x64-gnu, linux-x64-musl, win32-x64-msvc}` | `native/npm/<platform>/` |
| 7 | `rn-material-symbols-scanner-native` (loader) | `native/` |
| 8 | `rn-material-symbols` (library) | repository root |

Publish in this order and never the library before the loader, nor the loader before all six
platform packages. Yarn 1 and Yarn Berry refuse to install a package whose optional dependency is
missing from the registry, so a library published too early is uninstallable with Yarn.

Always use `pnpm publish`, never `npm publish`: pnpm rewrites `workspace:*` in
`optionalDependencies` to the real version, npm ships `workspace:*` and every install fails.

## 0. One-time setup

```bash
npm login                          # opens the browser; the account that will own the packages
npm whoami                         # must print that account
pnpm config get registry           # must print https://registry.npmjs.org/
```

npm requires two-factor authentication to publish. Each `pnpm publish` asks for a one-time
password, or pass it with `--otp=<code>` (codes expire in about 30 seconds, so get a fresh one per
package). Eight publishes means eight codes.

Check that every name is still free (each must print `E404`):

```bash
for n in rn-material-symbols rn-material-symbols-scanner-native \
  rn-material-symbols-scanner-native-{darwin-arm64,darwin-x64,linux-arm64-gnu,linux-x64-gnu,linux-x64-musl,win32-x64-msvc}; do
  printf '%s ' "$n"; npm view "$n" version 2>&1 | grep -oE 'E404|^[0-9.]+$'
done
```

## 1. Freeze the commit

```bash
git switch main && git pull                 # the commit you release must be the one CI built
git status --short                          # empty (the assembled .node files are gitignored)
node scripts/check-versions.mjs             # "versions agree: <version> (sources)"
```

For a new version, bump `package.json`, `native/package.json` and `native/Cargo.toml` first and
follow README step 1 (`napi version`, rebuild, check-versions), commit, push, and wait for the
`native` workflow to pass on that commit.

## 2. Assemble the six binaries from that commit's CI run

```bash
RUN=$(gh run list -w native.yml -b main -L 1 --json databaseId -q '.[0].databaseId')
gh run view "$RUN" --json headSha,conclusion -q '.headSha + " " + .conclusion'   # = git rev-parse HEAD, success
rm -rf native/artifacts && gh run download "$RUN" -p 'bindings-*' -D native/artifacts
(cd native && pnpm exec napi artifacts -o artifacts && pnpm exec napi pre-publish -t npm --dry-run)
shasum -a 256 native/npm/*/scanner.*.node   # keep this list; step 6 compares against it
```

If `headSha` is not `HEAD`, stop: the binaries would not match the source being published.

## 3. Release gates

```bash
PMS="npm-native npm-js" bash e2e/consumer.sh   # ends with the summary table, no "FAILED steps above"
bash e2e/registry.sh                           # same, all five package managers
```

Both must pass on the exact tree you are about to publish. `e2e/registry.sh` publishes only to a
throwaway Verdaccio on 127.0.0.1 (it does not read `~/.npmrc` and every publish passes
`--registry`), so it is safe to run while logged in.

## 4. Inspect what will be uploaded

```bash
for d in native/npm/*/ native .; do (cd "$d" && pnpm publish --dry-run --no-git-checks 2>&1 | tail -n 15); done
```

Each platform tarball must contain its `scanner.<platform>.node`; the loader must not contain any
`.node`; the library must not contain `native/`. CI's `assemble` job checks the same and keeps the
tarballs as the `npm-tarballs` artifact.

## 5. Publish

Platform packages, one at a time, each confirmed before the next:

```bash
V=$(node -p "require('./package.json').version")
for p in darwin-arm64 darwin-x64 linux-arm64-gnu linux-x64-gnu linux-x64-musl win32-x64-msvc; do
  (cd "native/npm/$p" && pnpm publish --access public) || break
  npm view "rn-material-symbols-scanner-native-$p@$V" version
done
```

Check that all six print the version before going on:

```bash
for p in darwin-arm64 darwin-x64 linux-arm64-gnu linux-x64-gnu linux-x64-musl win32-x64-msvc; do
  npm view "rn-material-symbols-scanner-native-$p@$V" version || echo "MISSING $p"
done
```

Then the loader, then the library:

```bash
(cd native && pnpm publish --access public)
npm view "rn-material-symbols-scanner-native@$V" optionalDependencies   # concrete versions, no workspace:
pnpm publish --access public                                            # at the root; prepack runs pnpm build
npm view "rn-material-symbols@$V" version
```

`pnpm publish` runs git checks (on `main`, clean, up to date with the remote). If fetching the
remote fails, fix the connection rather than adding `--no-git-checks`; the check is what ties the
upload to the pushed commit.

### Alternative: publish the tarballs CI packed

The `assemble` job uploads the eight tarballs it checked as the `npm-tarballs` artifact (packed with
pnpm, so `workspace:*` is already rewritten). Publishing those files uploads exactly what CI
verified, with no local rebuild in between. `npm publish <file>.tgz` is safe here; only
`npm publish` run inside a source directory ships `workspace:*`.

```bash
D=$(mktemp -d) && gh run download "$RUN" -n npm-tarballs -D "$D"
node scripts/check-versions.mjs --packed "$D"
for p in darwin-arm64 darwin-x64 linux-arm64-gnu linux-x64-gnu linux-x64-musl win32-x64-msvc; do
  npm publish "$D/rn-material-symbols-scanner-native-$p-$V.tgz" --access public || break
  npm view "rn-material-symbols-scanner-native-$p@$V" version
done
npm publish "$D/rn-material-symbols-scanner-native-$V.tgz" --access public
npm publish "$D/rn-material-symbols-$V.tgz" --access public
```

Same order, same `npm view` check after each. For 0.2.0 these tarballs (run 37218352303) were
already downloaded to `~/personal/rnms-release-0.2.0/tarballs/`; their names match the commands
above, `check-versions --packed` passes on them, and the darwin-arm64 binary inside has the same
sha256 as the one assembled in step 2 (checked 2026-10-15). Unverified: `e2e/registry.sh`
rehearses the `pnpm publish` route above, not this one.

## 6. Verify from the real registry

The registry's CDN can lag a minute behind `npm view`.

```bash
PUBLISHED=1 bash e2e/registry.sh
```

Same checks as step 3, without Verdaccio and without publishing: it confirms all eight versions are
on registry.npmjs.org and the loader names no `workspace:` version, then installs
`rn-material-symbols@<version>` by name with npm, pnpm, Yarn 1, Yarn Berry and Bun. The installed
binary for this machine must be byte-identical to the one assembled in step 2. The temp npm config
holds no token, so this run cannot publish. Before the release it stops at the first check with
`FAILED steps above` (that path was run on 2026-10-15; the install path against npmjs has not been).

## 7. Record the release

- `CHANGELOG.md`: replace `unreleased` with the date.
- `git tag v$V && git push origin main v$V`, then a GitHub release from the tag with the changelog
  section.
- README "Verification status": move "installs from the public npm registry" out of "Not yet
  verified" once step 6 passed.

## When something goes wrong

- **A version number can never be reused**, even after unpublishing. A bad tarball is fixed with a
  new patch version, never by republishing the same one.
- **Stopped partway through step 5:** the order keeps the registry usable. Platform packages alone
  are harmless (nothing depends on them yet); a loader without the library is harmless too. Fix the
  cause and continue from the first unpublished package with the same version.
- **Published a broken library or loader:** publish a fixed patch version, then
  `npm deprecate <package>@<bad-version> "<reason>; use <good-version>"`. Prefer deprecate over
  `npm unpublish`: npm allows unpublishing only shortly after publishing and only without
  dependents, and the version stays burned either way (check npm's current unpublish policy before
  relying on it).
- **OTP rejected:** codes expire quickly; generate a new one and rerun only that package.

## Later: publishing from CI

Publishing from GitHub Actions with npm trusted publishing (OIDC, no stored token) and provenance
would remove the local OTP loop and the "is this the commit CI built" check. It needs each package
to be configured on npmjs.com, which is easiest after the first manual release. Not set up yet.
