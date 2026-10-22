import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type IconData, VARIANTS } from './lib/aliases';
import { quantizePath } from './lib/quantize';
import { renderNamesModule, renderVariantData } from './lib/render';

const ROOT = path.join(__dirname, '..');
const read = <T>(file: string): T => JSON.parse(readFileSync(path.join(ROOT, 'data', file), 'utf8')) as T;

const meta = read<{ icons: Record<string, number>; legacy: string[] }>('meta.json');
const aliases = read<Record<string, string>>('aliases.json');
const names = Object.keys(meta.icons);

const iconsDir = path.join(ROOT, 'icons');
rmSync(iconsDir, { recursive: true, force: true });

// One data file per variant: { name: { d, f? } } with paths snapped to the integer grid (scripts/lib/quantize.ts).
// The Metro plugin inlines only the names and shapes an app uses; the Jest registry reads the whole file.
mkdirSync(iconsDir, { recursive: true });
let icons = 0;
for (const variant of VARIANTS) {
  const data = read<Record<string, IconData>>(`${variant}.json`);
  const missing = names.filter((n) => !(n in data));
  if (missing.length > 0) throw new Error(`${variant}.json is missing: ${missing.join(', ')}`);
  const dangling = Object.values(aliases).filter((target) => !(target in data));
  if (dangling.length > 0) throw new Error(`${variant}: alias targets missing: ${dangling.join(', ')}`);
  const quantized: Record<string, IconData> = {};
  for (const [name, icon] of Object.entries(data)) {
    const d = quantizePath(icon.d);
    const f = icon.f === undefined ? undefined : quantizePath(icon.f);
    quantized[name] = f === undefined || f === d ? { d } : { d, f };
    icons += 1;
  }
  writeFileSync(path.join(iconsDir, `${variant}.json`), renderVariantData(quantized));
}

mkdirSync(path.join(ROOT, 'src', 'generated'), { recursive: true });
writeFileSync(path.join(ROOT, 'src', 'generated', 'names.ts'), renderNamesModule(names, aliases, meta.legacy));
console.log(`icons: ${icons} in ${VARIANTS.length} data files · names: ${names.length} · aliases: ${Object.keys(aliases).length} · legacy: ${meta.legacy.length}`);
