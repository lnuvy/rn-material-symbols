#!/usr/bin/env bash
# Linux E2E: run install, icon build, typecheck and the full test suite inside a node:22 container,
# which exercises the Linux per-directory watcher branch of the watch tests.
#   bash e2e/linux.sh            (waits up to 3 minutes for the Docker daemon)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

for _ in $(seq 1 36); do
  docker info >/dev/null 2>&1 && break
  sleep 5
done
docker info >/dev/null 2>&1 || { echo "BLOCKER: Docker daemon did not start within 3 minutes"; exit 1; }

cd "$REPO"
git archive HEAD | tar -x -C "$WORK"   # tracked files at HEAD only: no node_modules, no generated lib/icons
docker run --rm -v "$WORK:/app" -w /app node:22 bash -lc \
  'node -v && uname -sr && corepack enable && pnpm -v && pnpm install --frozen-lockfile && pnpm build:icons && pnpm typecheck && pnpm test'
