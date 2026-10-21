#!/usr/bin/env node
// Checks the versions of the library and its native scanner packages.
//   node scripts/check-versions.mjs                 source files only
//   node scripts/check-versions.mjs --packed <dir>  also every *.tgz in <dir> (from `pnpm pack`)
// Two version groups:
//   native  native/package.json, native/npm/*/package.json, native/Cargo.toml and the versions napi hard-codes
//           into native/index.js must all be equal (the loader and the six binaries are released together).
//   library the root package.json may be ahead of native by patch only (same major.minor, higher or equal patch),
//           so a JS-only fix ships as one library release without republishing unchanged binaries.
// Packed: each tarball's own version and its rn-material-symbols-scanner-native* optionalDependencies, which pnpm
// rewrites from workspace:* to the native version on pack.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NATIVE = 'rn-material-symbols-scanner-native';
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const library = readJson(path.join(ROOT, 'package.json')).version;
const native = readJson(path.join(ROOT, 'native/package.json')).version;
const errors = [];
const check = (where, actual, expected = native) => {
  if (actual !== expected) errors.push(`${where}: ${actual} (expected ${expected})`);
};

const parse = (v) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v ?? '')?.slice(1).map(Number);
const [lib, nat] = [parse(library), parse(native)];
if (!lib || !nat) {
  errors.push(`versions must be plain x.y.z: package.json ${library}, native/package.json ${native}`);
} else if (lib[0] !== nat[0] || lib[1] !== nat[1] || lib[2] < nat[2]) {
  errors.push(`package.json ${library} must have the same major.minor as native ${native} and a patch >= ${nat[2]}`);
}

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
    check(`${file} version`, pkg.version, pkg.name === 'rn-material-symbols' ? library : native);
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
const label = library === native ? library : `library ${library}, native ${native}`;
console.log(`versions agree: ${label}${packedIdx !== -1 ? ' (sources and packed tarballs)' : ' (sources)'}`);
