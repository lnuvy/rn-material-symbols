import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const [bundlePath] = process.argv.slice(2);
const bundle = readFileSync(bundlePath, 'utf8');
const pkgRoot = path.dirname(require.resolve('rn-material-symbols/package.json'));

// Every string literal in the bundle (double or single quoted, escapes handled), collected once.
const strings = new Set();
for (const m of bundle.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g)) strings.add(m[1] ?? m[2]);

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

const expected = ['info', 'chevron_right', 'schedule', 'cloud_download', 'check_box', 'check_box_outline_blank', 'home', 'settings'];
const forbidden = ['devices_wearables', 'backspace', 'share'];
const failures = [];

// Exact-set check. A path shared by several icon names counts as a hit for each of them, but is only
// reported as an extra if none of the expected names owns it.
const found = new Set();
for (const s of strings) {
  const names = pathToNames.get(s);
  if (!names) continue;
  const owned = [...names].filter((n) => expected.includes(n));
  for (const n of owned.length ? owned : names) found.add(n);
}
const missing = expected.filter((n) => !found.has(n));
const extra = [...found].filter((n) => !expected.includes(n)).sort();
for (const n of missing) failures.push(`missing ${n}`);
for (const n of extra) failures.push(`unexpected ${n}`);
for (const n of forbidden) if (found.has(n)) failures.push(`forbidden ${n} present`);

// Names-list leak: how many symbol names appear as standalone strings in the bundle.
const { MATERIAL_SYMBOL_NAMES } = require(path.join(pkgRoot, 'lib', 'generated', 'names.js'));
const nameHits = MATERIAL_SYMBOL_NAMES.filter((n) => strings.has(n)).length;
if (nameHits > 200) failures.push(`name list leaked into bundle (${nameHits} names present, limit 200)`);

console.log(`bundle ${(bundle.length / 1024).toFixed(0)} KB · exact icon set [${[...found].sort().join(', ')}] (${found.size}) · names-list hits ${nameHits}`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('OK');
