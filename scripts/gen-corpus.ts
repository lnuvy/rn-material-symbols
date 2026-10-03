import fs from 'node:fs';
import path from 'node:path';
import { MATERIAL_SYMBOL_NAMES } from '../src/generated/names';

const [outDir, ...rest] = process.argv.slice(2);
if (!outDir || outDir.startsWith('--')) {
  console.error('usage: tsx scripts/gen-corpus.ts <outDir> [--files=N] [--seed=S]');
  process.exit(1);
}
const arg = (k: string, d: number) => Number(rest.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d);
const total = arg('files', 50000);
let seed = arg('seed', 42);
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const N = MATERIAL_SYMBOL_NAMES;

const templates: Array<(i: number) => [string, string]> = [
  (i) => [`Screen${i}.tsx`, `import { MaterialIcon } from 'rn-material-symbols';\nexport const S${i} = () => <MaterialIcon name='${pick(N)}' size={24} />;\n`],
  (i) => [`menu${i}.ts`, `export const MENU_${i} = [{ label: 'a', iconName: '${pick(N)}' }, { label: 'b', iconName: "${pick(N)}" }];\n`],
  (i) => [`types${i}.ts`, `export type IconName${i} = ${Array.from({ length: 40 }, () => `'${pick(N)}'`).join(' | ')};\n`],
  (i) => [`util${i}.ts`, `export function f${i}(x: number): number { const label = 'Hello World'; return x * ${i}; }\n`],
  (i) => [`Toggle${i}.tsx`, `export const T${i} = ({ on }: { on: boolean }) => <Icon name={on ? '${pick(N)}' : '${pick(N)}'} />;\n`],
  (i) => [`tpl${i}.ts`, "export const k = `${a ? '" + pick(N) + "' : '" + pick(N) + "'}`;\n"],
  (i) => [`plain${i}.ts`, `export const STYLES_${i} = { padding: 8, margin: 4, color: 'red' };\n`],
  (i) => [`flowish${i}.js`, `// plain JS\nmodule.exports = { name: '${pick(N)}', n: ${i} };\n`],
];

for (let i = 0; i < total; i += 1) {
  const dir = path.join(outDir, `pkg${i % 40}`, `feature${i % 300}`, i % 5 === 0 ? 'lib' : 'ui');
  fs.mkdirSync(dir, { recursive: true });
  const [name, code] = templates[i % templates.length](i);
  fs.writeFileSync(path.join(dir, name), code);
}
console.log(`wrote ${total} files to ${outDir}`);
