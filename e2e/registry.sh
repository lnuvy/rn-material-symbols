#!/usr/bin/env bash
# Registry rehearsal (README "Before publishing" step 4): start a throwaway Verdaccio on 127.0.0.1,
# publish all eight packages to it in release order (six platform packages, loader, library), then
# install the library by name, as a user would, into a fresh bare React Native app with each package
# manager: bundle for iOS and Android, assert the exact icon set and the `· native` report line,
# check that the installed binary is byte-identical to the assembled one, and run Jest.
#   bash e2e/registry.sh                      npm pnpm yarn berry bun
#   PMS="npm berry" bash e2e/registry.sh      a subset
#   KEEP=1 bash e2e/registry.sh               keep the temp dir (Verdaccio storage and logs included)
#   PORT=4874 bash e2e/registry.sh            if 4873 is taken
#   PUBLISHED=1 bash e2e/registry.sh          after a real release (docs/PUBLISHING.md step 6): no Verdaccio,
#                                             no publish; installs the released version from registry.npmjs.org
#
# Needs all six native/npm/<platform>/scanner.<platform>.node (README "Before publishing" step 2);
# it refuses to start without them. Nothing reaches registry.npmjs.org except Verdaccio's read-only
# proxy for third-party packages: npm config is isolated to a temp file (your ~/.npmrc and its tokens
# are not read), every publish passes --registry with the local URL, and the eight package names are
# not proxied, so an install can only resolve them from what this script published.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PMS="${PMS:-npm pnpm yarn berry bun}"
PORT="${PORT:-4873}"
VERDACCIO_VERSION=6.10.4
BERRY_VERSION=4.14.1
BUN_VERSION=1.4.2
PUBLISHED="${PUBLISHED:-0}"
if [ "$PUBLISHED" = 1 ]; then REG="https://registry.npmjs.org/"; else REG="http://127.0.0.1:$PORT/"; fi
PLATFORMS="darwin-arm64 darwin-x64 linux-arm64-gnu linux-x64-gnu linux-x64-musl win32-x64-msvc"

for tool in npm pnpm yarn node corepack curl; do
  command -v "$tool" >/dev/null || { echo "error: '$tool' not found in PATH" >&2; exit 1; }
done
for p in $PLATFORMS; do
  [ -f "$REPO/native/npm/$p/scanner.$p.node" ] || {
    echo "error: native/npm/$p/scanner.$p.node is missing; assemble all six first (README \"Before publishing\" step 2)" >&2; exit 1; }
done
if [ "$PUBLISHED" != 1 ] && curl -s -o /dev/null "$REG-/ping"; then
  echo "error: something already listens on $REG; stop it or set PORT (a reused registry may hold stale packages)" >&2; exit 1
fi

WORK="$(mktemp -d)"
RESULTS="$WORK/results.txt"
: > "$RESULTS"
VERDACCIO_PID=""
cleanup() {
  if [ -n "$VERDACCIO_PID" ]; then kill "$VERDACCIO_PID" 2>/dev/null || true; fi
  if [ "${KEEP:-0}" = 1 ]; then echo "kept: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT
# shellcheck source=e2e/app.sh
. "$REPO/e2e/app.sh"

VERSION="$(node -p "require('$REPO/package.json').version")"
HOST="$(node -p 'process.platform + "-" + process.arch')"
case "$HOST" in
  darwin-*) PLAT="$HOST" ;;
  linux-*)
    LIBC=gnu
    case "$(ldd --version 2>&1 || true)" in *musl*) LIBC=musl ;; esac
    PLAT="$HOST-$LIBC" ;;
  win32-x64) PLAT=win32-x64-msvc ;;
  *) echo "error: no native target for $HOST" >&2; exit 1 ;;
esac
ASSEMBLED_SHA="$(shasum -a 256 "$REPO/native/npm/$PLAT/scanner.$PLAT.node" | cut -d' ' -f1)"
echo "node $(node -v) · npm $(npm -v) · pnpm $(pnpm -v) · yarn $(cd "$WORK" && yarn -v) · registry $REG · $(date +%F)"
echo "version $VERSION · host $PLAT · assembled scanner.$PLAT.node sha256 $ASSEMBLED_SHA"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

if [ "$PUBLISHED" = 1 ]; then
  # Read-only: no token in the temp config, so nothing here can publish.
  printf 'registry=%s\n' "$REG" > "$WORK/npmrc"
  export NPM_CONFIG_USERCONFIG="$WORK/npmrc" npm_config_userconfig="$WORK/npmrc"
  echo "== released packages on $REG"
  for p in $PLATFORMS; do
    step registry "view-rn-material-symbols-scanner-native-$p" npm view "rn-material-symbols-scanner-native-$p@$VERSION" version
  done
  step registry view-rn-material-symbols-scanner-native npm view "rn-material-symbols-scanner-native@$VERSION" version
  step registry view-rn-material-symbols npm view "rn-material-symbols@$VERSION" version
  step registry loader-deps bash -c 'deps="$(npm view "rn-material-symbols-scanner-native@$1" optionalDependencies --json)" && echo "$deps" && ! grep -F "workspace:" <<<"$deps"' _ "$VERSION"
  if grep -qE '^registry\|.*\|[1-9][0-9]*\|[0-9]+$' "$RESULTS"; then summary; fi
else
# --- default: Verdaccio rehearsal (left unindented for the heredoc) ---

echo "== verdaccio $VERDACCIO_VERSION ($REG)"
mkdir -p "$WORK/verdaccio"
cat > "$WORK/verdaccio/config.yaml" <<YAML
storage: $WORK/verdaccio/storage
auth:
  htpasswd:
    file: $WORK/verdaccio/htpasswd
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  # No proxy: these resolve only from what this script publishes.
  'rn-material-symbols':
    access: \$all
    publish: \$authenticated
  'rn-material-symbols-scanner-native':
    access: \$all
    publish: \$authenticated
  'rn-material-symbols-scanner-native-*':
    access: \$all
    publish: \$authenticated
  '**':
    access: \$all
    proxy: npmjs
log: { type: stdout, format: pretty, level: warn }
YAML
npx --yes "verdaccio@$VERDACCIO_VERSION" --config "$WORK/verdaccio/config.yaml" --listen "127.0.0.1:$PORT" \
  >"$WORK/verdaccio.log" 2>&1 &
VERDACCIO_PID=$!
for _ in $(seq 1 120); do
  curl -s -o /dev/null "$REG-/ping" && break
  kill -0 "$VERDACCIO_PID" 2>/dev/null || { tail -30 "$WORK/verdaccio.log"; echo "error: verdaccio exited" >&2; exit 1; }
  sleep 1
done
curl -s -o /dev/null "$REG-/ping" || { tail -30 "$WORK/verdaccio.log"; echo "error: verdaccio did not answer within 120 s" >&2; exit 1; }

# A throwaway user; the token goes only into the temp npm config below.
TOKEN="$(curl -s -X PUT -H 'content-type: application/json' \
  -d '{"name":"e2e","password":"e2e-rehearsal"}' "$REG-/user/org.couchdb.user:e2e" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).token;if(!t)process.exit(1);process.stdout.write(t)})')" \
  || { echo "error: could not create a verdaccio user" >&2; exit 1; }
printf 'registry=%s\n//127.0.0.1:%s/:_authToken=%s\n' "$REG" "$PORT" "$TOKEN" > "$WORK/npmrc"
export NPM_CONFIG_USERCONFIG="$WORK/npmrc" npm_config_userconfig="$WORK/npmrc"

echo "== publish (release order: platforms, loader, library)"
publish() {
  local name="$1" dir="$2"
  step publish "$name" bash -c 'cd "$1" && pnpm publish --registry "$2" --no-git-checks' _ "$dir" "$REG"
  step publish "view-$name" npm view "$name@$VERSION" version --registry "$REG"
}
for p in $PLATFORMS; do publish "rn-material-symbols-scanner-native-$p" "$REPO/native/npm/$p"; done
publish rn-material-symbols-scanner-native "$REPO/native"
publish rn-material-symbols "$REPO"
if grep -qE '^publish\|.*\|[1-9][0-9]*\|[0-9]+$' "$RESULTS"; then summary; fi
# The published loader must name concrete versions, not workspace:*.
step publish loader-deps bash -c 'deps="$(npm view "rn-material-symbols-scanner-native@$1" optionalDependencies --json --registry "$2")" && echo "$deps" && ! grep -F "workspace:" <<<"$deps"' _ "$VERSION" "$REG"
fi # --- end Verdaccio rehearsal ---

make_template

run_pm() {
  local pm="$1" dir="$WORK/$1" pmrun
  echo "== $pm"
  cp -R "$WORK/template" "$dir"
  write_app "$dir" "$pm"
  cd "$dir"
  # Project-level registry config for every client (the temp user config covers npm and pnpm too).
  printf 'registry=%s\n' "$REG" > .npmrc
  case "$pm" in
    npm)
      pmrun=npm
      step "$pm" install npm install
      step "$pm" install-lib npm install "rn-material-symbols@$VERSION" "react-native-svg@$SVG_VERSION"
      ;;
    pnpm)
      pmrun=pnpm
      step "$pm" install pnpm install
      step "$pm" install-lib pnpm add "rn-material-symbols@$VERSION" "react-native-svg@$SVG_VERSION"
      ;;
    yarn)
      pmrun=yarn
      printf 'registry "%s"\n' "$REG" > .yarnrc
      step "$pm" install yarn install
      step "$pm" install-lib yarn add "rn-material-symbols@$VERSION" "react-native-svg@$SVG_VERSION"
      ;;
    berry)
      pmrun="corepack yarn@$BERRY_VERSION"
      # nodeLinker node-modules: Metro does not run under PnP (README "Not yet verified").
      cat > .yarnrc.yml <<YML
nodeLinker: node-modules
npmRegistryServer: "$REG"
unsafeHttpWhitelist: ["127.0.0.1"]
enableImmutableInstalls: false
enableTelemetry: false
YML
      step "$pm" install $pmrun install
      step "$pm" install-lib $pmrun add "rn-material-symbols@$VERSION" "react-native-svg@$SVG_VERSION"
      ;;
    bun)
      pmrun="npx --yes bun@$BUN_VERSION run"
      printf '[install]\nregistry = "%s"\n' "$REG" > bunfig.toml
      step "$pm" install npx --yes "bun@$BUN_VERSION" install
      step "$pm" install-lib npx --yes "bun@$BUN_VERSION" add "rn-material-symbols@$VERSION" "react-native-svg@$SVG_VERSION"
      ;;
    *) echo "error: unknown package manager '$pm'" >&2; exit 1 ;;
  esac
  # The package manager must have picked the platform package for this machine from the registry,
  # and its binary must be the assembled one byte for byte. pnpm keeps it under node_modules/.pnpm.
  step "$pm" installed-binary bash -c '
    found="$(find node_modules -type f -name "scanner.$1.node" -path "*rn-material-symbols-scanner-native-$1*")"
    [ "$(printf "%s\n" "$found" | grep -c .)" = 1 ] || { echo "expected one scanner.$1.node, found: ${found:-none}"; exit 1; }
    sha="$(shasum -a 256 "$found" | cut -d" " -f1)"
    echo "$found sha256 $sha"
    [ "$sha" = "$2" ]' _ "$PLAT" "$ASSEMBLED_SHA"
  check_app "$pm" native "$pmrun"
  cd "$REPO"
}

for pm in $PMS; do run_pm "$pm"; done

summary
