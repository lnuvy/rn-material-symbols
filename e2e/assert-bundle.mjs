#!/usr/bin/env node
// Exact-set bundle checker.
//   node e2e/assert-bundle.mjs <bundle> --expect a,b,c [--pkg <path to installed rn-material-symbols>]
// Text JS bundles: collect string literals and map icon paths (`d`/`f` of icons/*/*.js) to names.
// Binary bundles (Hermes bytecode, or any file that is not valid UTF-8): search the raw bytes for each
// icon path instead.
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const NAME_LEAK_LIMIT = 200;
// In raw bytecode a name is only a substring match, so short names ("add", "info") appear by chance.
// The leak signal therefore counts only names at least this long.
const BINARY_MIN_NAME_LENGTH = 10;

const argv = process.argv.slice(2);
let bundlePath;
let expectArg;
let pkgArg;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--expect') expectArg = argv[++i];
  else if (argv[i] === '--pkg') pkgArg = argv[++i];
  else if (!bundlePath) bundlePath = argv[i];
}
if (!bundlePath || expectArg === undefined) {
  console.error('usage: assert-bundle.mjs <bundle> --expect a,b,c [--pkg <path to installed rn-material-symbols>]');
  process.exit(2);
}
const expected = expectArg.split(',').map((s) => s.trim()).filter(Boolean);
const pkgRoot = pkgArg
  ? path.resolve(pkgArg)
  : path.dirname(require.resolve('rn-material-symbols/package.json', { paths: [process.cwd()] }));

const buf = readFileSync(bundlePath);
let text = null;
try {
  text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  if (text.includes('\0')) text = null;
} catch {
  text = null;
}
const binary = text === null;

// pathString -> icon names, from every generated icon module (both `d` and `f`).
const pathToNames = new Map();
for (const variant of ['rounded', 'outlined', 'sharp']) {
  const dir = path.join(pkgRoot, 'icons', variant);
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    const name = file.slice(0, -3);
    const mod = require(path.join(dir, file));
    for (const p of [mod.d, mod.f]) {
      if (typeof p !== 'string' || !p) continue;
      if (!pathToNames.has(p)) pathToNames.set(p, new Set());
      pathToNames.get(p).add(name);
    }
  }
}
const { MATERIAL_SYMBOL_NAMES } = require(path.join(pkgRoot, 'lib', 'generated', 'names.js'));

// Which icon paths are present in the bundle.
const presentPaths = [];
const embedded = new Set();
let nameHits;
if (binary) {
  // Hermes packs its string storage so that a string that is a substring of another is stored inside it
  // (measured: the `check_box_outline_blank` path exists only inside the `check_box` path in an Expo
  // hbc). Raw bytes therefore cannot tell "this path is its own string" from "this path is inside a
  // longer one". A path covered by a longer present path is treated as embedded: it can satisfy an
  // expected name but is never reported as unexpected, and it is listed as unconfirmed.
  const candidates = [...pathToNames.keys()].filter((p) => buf.includes(Buffer.from(p))).sort((a, b) => b.length - a.length);
  for (const p of candidates) {
    if (candidates.some((q) => q.length > p.length && q.includes(p))) embedded.add(p);
    presentPaths.push(p);
  }
  nameHits = MATERIAL_SYMBOL_NAMES.filter((n) => n.length >= BINARY_MIN_NAME_LENGTH && buf.includes(Buffer.from(n))).length;
} else {
  // Every string literal (double or single quoted, escapes handled), collected once.
  const strings = new Set();
  for (const m of text.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g)) strings.add(m[1] ?? m[2]);
  for (const s of strings) if (pathToNames.has(s)) presentPaths.push(s);
  nameHits = MATERIAL_SYMBOL_NAMES.filter((n) => strings.has(n)).length;
}

// Exact-set check. A path shared by several icon names counts as a hit for each of them, but is only
// reported as an extra if none of the expected names owns it.
const found = new Set();
const confirmed = new Set(); // names with at least one path that is not embedded in a longer path
for (const p of presentPaths) {
  const names = pathToNames.get(p);
  const owned = [...names].filter((n) => expected.includes(n));
  if (embedded.has(p) && !owned.length) continue; // embedded, belongs to no expected name: not an extra
  for (const n of owned.length ? owned : names) {
    found.add(n);
    if (!embedded.has(p)) confirmed.add(n);
  }
}
const unconfirmed = [...found].filter((n) => !confirmed.has(n)).sort();
const failures = [];
for (const n of expected.filter((n) => !found.has(n))) failures.push(`missing ${n}`);
for (const n of [...found].filter((n) => !expected.includes(n)).sort()) failures.push(`unexpected ${n}`);
if (nameHits > NAME_LEAK_LIMIT) failures.push(`name list leaked into bundle (${nameHits} names present, limit ${NAME_LEAK_LIMIT})`);

console.log(
  `${binary ? 'binary' : 'text'} bundle ${(buf.length / 1024).toFixed(0)} KB · exact icon set [${[...found].sort().join(', ')}] (${found.size}) · names-list hits ${nameHits}${binary ? ` (names >= ${BINARY_MIN_NAME_LENGTH} chars)` : ''}${binary && unconfirmed.length ? ` · unconfirmed (path only embedded in a longer icon path) [${unconfirmed.join(', ')}]` : ''}`,
);
if (binary && embedded.size) {
  console.log(`NOTE: ${embedded.size} icon path(s) are embedded in other paths and could not be confirmed individually`);
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('OK');
