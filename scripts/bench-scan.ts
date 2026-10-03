import fs from 'node:fs';
import path from 'node:path';
import { MATERIAL_SYMBOL_ALIASES, MATERIAL_SYMBOL_LEGACY, MATERIAL_SYMBOL_NAMES } from '../src/generated/names';
import { extractLiterals } from '../src/metro/extractLiterals';
import { nativeCacheFile } from '../src/metro/nativeScanner';
import { listSourceFiles, scanProject, topFiles } from '../src/metro/scanProject';

const args = process.argv.slice(2);
const runsArg = args.find((a) => a.startsWith('--runs='));
const runs = runsArg ? Number(runsArg.slice('--runs='.length)) : 1;
const phases = args.includes('--phases');
const scannerArg = args.find((a) => a.startsWith('--scanner='))?.slice('--scanner='.length) ?? 'js';
if (scannerArg !== 'js' && scannerArg !== 'native') {
  console.error(`--scanner must be js or native, got ${scannerArg}`);
  process.exit(1);
}
const scanner: 'js' | 'native' = scannerArg;
const [root, ...rel] = args.filter((a) => !a.startsWith('--'));
if (!root || rel.length === 0) {
  console.error('usage: tsx scripts/bench-scan.ts [--runs=N] [--scanner=js|native] [--cache-dir=DIR] [--phases] <root> <source...>');
  process.exit(1);
}
const nameSet = new Set<string>([...MATERIAL_SYMBOL_NAMES, ...Object.keys(MATERIAL_SYMBOL_ALIASES), ...MATERIAL_SYMBOL_LEGACY]);
const sources = rel.map((r) => path.join(root, r));
// --cache-dir keeps the bench cache out of a corpus that must stay read-only (default: <root>).
const cacheDir = args.find((a) => a.startsWith('--cache-dir='))?.slice('--cache-dir='.length) ?? root;
const cacheFile = path.join(cacheDir, '.bench-cache.json');
// The cache file the selected engine actually reads/writes; deleting the other one would leave 'cold' runs warm.
const engineCache = scanner === 'native' ? nativeCacheFile(cacheFile)! : cacheFile;
const stats = (xs: number[]) => {
  const r = xs.map((x) => Math.round(x)); // native reports fractional ms
  const s = [...r].sort((a, b) => a - b);
  return `min=${s[0]}ms median=${s[Math.floor(s.length / 2)]}ms all=[${r.join(',')}]`;
};

console.log(`engine=${scanner} cache=${engineCache}`);
// Gated numbers are WALL time around scanProject() (what Metro pays: JS wrapper, napi marshalling, result
// conversion), measured the same way for both engines. `ms` reported by the engine is kept as a secondary figure.
const colds: number[] = [];
const warms: number[] = [];
const coldsInternal: number[] = [];
const warmsInternal: number[] = [];
let first: ReturnType<typeof scanProject> | undefined;
const opts = { sources, nameSet, cacheFile, cacheKey: 'bench', scanner };
const timed = () => {
  const t = performance.now();
  const r = scanProject(opts);
  return { r, wall: performance.now() - t };
};
for (let i = 0; i < runs; i += 1) {
  fs.rmSync(engineCache, { force: true });
  console.log(`run ${i + 1}: cold: cache absent=${!fs.existsSync(engineCache)}`);
  const cold = timed();
  console.log(`run ${i + 1}: warm: cache present=${fs.existsSync(engineCache)}`);
  const warm = timed();
  if (cold.r.engine !== scanner || warm.r.engine !== scanner) throw new Error(`expected engine=${scanner}, got ${cold.r.engine}/${warm.r.engine}`);
  colds.push(cold.wall);
  warms.push(warm.wall);
  coldsInternal.push(cold.r.ms);
  warmsInternal.push(warm.r.ms);
  first ??= cold.r;
}
const cold = first!;
console.log(`files=${cold.files} names=${cold.names.size} unparsed=${cold.unparsed.length}`);
console.log(`cold wall ${stats(colds)}`);
console.log(`warm wall ${stats(warms)}`);
console.log(`cold internal ${stats(coldsInternal)}`);
console.log(`warm internal ${stats(warmsInternal)}`);
console.log('top files:', topFiles(cold.byFile, 5));
console.log('unparsed:', [...cold.unparsed].sort());
console.log('names:', [...cold.names].sort().join(' '));

if (phases && scanner === 'native') console.log('phases: n/a (native)');
if (phases && scanner === 'js') {
  // One cold run re-implemented around scanProject's loop so each phase can be timed from outside src/.
  const CANDIDATE = /(['"`])([a-z0-9_]+)\1/g;
  const now = () => performance.now();
  let t = now();
  const files = [...new Set(sources.flatMap((s) => listSourceFiles(path.resolve(s), [])))];
  const listMs = now() - t;
  let readStatMs = 0;
  let prefilterMs = 0;
  let parseMs = 0;
  let parsedCount = 0;
  let skipped = 0;
  const wall = now();
  for (const file of files) {
    t = now();
    fs.statSync(file);
    const code = fs.readFileSync(file, 'utf8');
    readStatMs += now() - t;
    t = now();
    const hasCandidate = [...code.matchAll(CANDIDATE)].some((m) => nameSet.has(m[2]));
    prefilterMs += now() - t;
    if (hasCandidate) {
      t = now();
      extractLiterals(code, file);
      parseMs += now() - t;
      parsedCount += 1;
    } else {
      skipped += 1;
    }
  }
  const loopMs = now() - wall;
  const f = (n: number) => n.toFixed(1);
  console.log(
    `phases: files=${files.length} list=${f(listMs)}ms readStat=${f(readStatMs)}ms prefilter=${f(prefilterMs)}ms extractLiterals=${f(parseMs)}ms loopTotal=${f(loopMs)}ms parsed=${parsedCount} skippedByPrefilter=${skipped}`,
  );
}
