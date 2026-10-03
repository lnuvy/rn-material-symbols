import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type IconData, VARIANTS } from './lib/aliases';
import { renderIconModule, renderNamesModule } from './lib/render';

const ROOT = path.join(__dirname, '..');
const read = <T>(file: string): T => JSON.parse(readFileSync(path.join(ROOT, 'data', file), 'utf8')) as T;

const meta = read<{ icons: Record<string, number>; legacy: string[] }>('meta.json');
const aliases = read<Record<string, string>>('aliases.json');
const names = Object.keys(meta.icons);

const iconsDir = path.join(ROOT, 'icons');
rmSync(iconsDir, { recursive: true, force: true });

let files = 0;
for (const variant of VARIANTS) {
  const data = read<Record<string, IconData>>(`${variant}.json`);
  const missing = names.filter((n) => !(n in data));
  if (missing.length > 0) throw new Error(`${variant}.json is missing: ${missing.join(', ')}`);
  const dangling = Object.values(aliases).filter((target) => !(target in data));
  if (dangling.length > 0) throw new Error(`${variant}: alias targets missing: ${dangling.join(', ')}`);
  const dir = path.join(iconsDir, variant);
  mkdirSync(dir, { recursive: true });
  for (const [name, icon] of Object.entries(data)) {
    writeFileSync(path.join(dir, `${name}.js`), renderIconModule(icon));
    files += 1;
  }
}

mkdirSync(path.join(ROOT, 'src', 'generated'), { recursive: true });
writeFileSync(path.join(ROOT, 'src', 'generated', 'names.ts'), renderNamesModule(names, aliases, meta.legacy));
console.log(`icons: ${files} files · names: ${names.length} · aliases: ${Object.keys(aliases).length} · legacy: ${meta.legacy.length}`);
