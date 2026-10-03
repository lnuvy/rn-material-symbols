import { generateCorpus } from './lib/corpus';

const [outDir, ...rest] = process.argv.slice(2);
if (!outDir || outDir.startsWith('--')) {
  console.error('usage: tsx scripts/gen-corpus.ts <outDir> [--files=N] [--seed=S]');
  process.exit(1);
}
const arg = (k: string, d: number) => Number(rest.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d);
const total = arg('files', 50000);
generateCorpus(outDir, total, arg('seed', 42));
console.log(`wrote ${total} files to ${outDir}`);
