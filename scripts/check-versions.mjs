#!/usr/bin/env node
// Checks that every version of the library and its native scanner packages agrees.
//   node scripts/check-versions.mjs                 source files only
//   node scripts/check-versions.mjs --packed <dir>  also every *.tgz in <dir> (from `pnpm pack`)
// Source: root package.json, native/package.json, native/npm/*/package.json, native/Cargo.toml and
// the versions napi hard-codes into native/index.js. Packed: each tarball's own version and its
// rn-material-symbols-scanner-native* optionalDependencies (pnpm rewrites workspace:* on pack).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NATIVE = 'rn-material-symbols-scanner-native';
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const expected = readJson(path.join(ROOT, 'package.json')).version;
const errors = [];
const check = (where, actual) => {
  if (actual !== expected) errors.push(`${where}: ${actual} (expected ${expected})`);
};

check('native/package.json', readJson(path.join(ROOT, 'native/package.json')).version);
const platformDirs = readdirSync(path.join(ROOT, 'native/npm'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
if (platformDirs.length === 0) errors.push('native/npm: no platform packages');
for (const dir of platformDirs) check(`native/npm/${dir}/package.json`, readJson(path.join(ROOT, 'native/npm', dir, 'package.json')).version);

const cargo = readFileSync(path.join(ROOT, 'native/Cargo.toml'), 'utf8').match(/^\[package\][^[]*?^version\s*=\s*"([^"]+)"/m);
check('native/Cargo.toml [package] version', cargo?.[1]);

const loader = readFileSync(path.join(ROOT, 'native/index.js'), 'utf8');
const pinned = [...loader.matchAll(/bindingPackageVersion !== '([^']+)'/g)].map((m) => m[1]);
if (pinned.length === 0) errors.push('native/index.js: no pinned binding version found (loader format changed?)');
for (const v of new Set(pinned)) check('native/index.js pinned binding version', v);

const packedIdx = process.argv.indexOf('--packed');
if (packedIdx !== -1) {
  const dir = path.resolve(process.argv[packedIdx + 1] ?? '.');
  const tarballs = readdirSync(dir).filter((f) => f.endsWith('.tgz'));
  if (tarballs.length === 0) errors.push(`${dir}: no .tgz files`);
  for (const file of tarballs) {
    const pkg = JSON.parse(execFileSync('tar', ['-xOzf', path.join(dir, file), 'package/package.json'], { encoding: 'utf8' }));
    check(`${file} version`, pkg.version);
    const optional = pkg.optionalDependencies ?? {};
    for (const [name, range] of Object.entries(optional)) {
      if (name.startsWith(NATIVE)) check(`${file} optionalDependencies.${name}`, range);
    }
    if (pkg.name === NATIVE) {
      for (const p of platformDirs) {
        if (!(`${NATIVE}-${p}` in optional)) errors.push(`${file}: optionalDependencies lacks ${NATIVE}-${p}`);
      }
    }
    if (pkg.name === 'rn-material-symbols' && !(NATIVE in optional)) errors.push(`${file}: optionalDependencies lacks ${NATIVE}`);
  }
}

if (errors.length > 0) {
  console.error(`version check failed:\n  ${errors.join('\n  ')}`);
  process.exit(1);
}
console.log(`versions agree: ${expected}${packedIdx !== -1 ? ' (sources and packed tarballs)' : ' (sources)'}`);
