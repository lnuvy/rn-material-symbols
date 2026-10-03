import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildAliases, type IconData, type Variant, VARIANTS } from './lib/aliases';
import { formatDataJson } from './lib/render';
import { assertWithinViewBox, normalizePath, parseSymbolSvg } from './lib/svg';

const METADATA_URL = 'https://fonts.google.com/metadata/icons?key=material_symbols&incomplete=1';
const CDN = 'https://fonts.gstatic.com/s/i/short-term/release';
const FAMILY: Record<Variant, string> = {
  rounded: 'materialsymbolsrounded',
  outlined: 'materialsymbolsoutlined',
  sharp: 'materialsymbolssharp',
};
const CONCURRENCY = Number(process.env.FETCH_CONCURRENCY ?? 32);
const DATA_DIR = path.join(__dirname, '..', 'data');

async function fetchText(url: string, attempts = 3): Promise<string | null> {
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch(url);
    if (res.ok) return res.text();
    if (res.status === 404) return null;
    if (attempt >= attempts) throw new Error(`${res.status} ${url}`);
    await new Promise((r) => setTimeout(r, 500 * attempt));
  }
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

interface MetaIcon {
  name: string;
  version: number;
  unsupported_families: string[];
}

async function loadMetadata(): Promise<{ symbols: MetaIcon[]; legacy: MetaIcon[] }> {
  const raw = await fetchText(METADATA_URL);
  if (!raw) throw new Error('metadata 404');
  const json = JSON.parse(raw.slice(raw.indexOf('{'))) as { icons: MetaIcon[] };
  const isSymbol = (i: MetaIcon) => !i.unsupported_families.some((f) => f.startsWith('Material Symbols'));
  return { symbols: json.icons.filter(isSymbol), legacy: json.icons.filter((i) => !isSymbol(i)) };
}

async function fetchIcon(variant: Variant, name: string): Promise<IconData | null> {
  const [d, f] = await Promise.all(
    (['default', 'fill1'] as const).map(async (axis) => {
      const svg = await fetchText(`${CDN}/${FAMILY[variant]}/${name}/${axis}/24px.svg`);
      if (svg === null) return null;
      const parsed = parseSymbolSvg(svg, `${variant}/${name}/${axis}`);
      const normalized = normalizePath(parsed.d, parsed.viewBox);
      assertWithinViewBox(normalized, `${variant}/${name}/${axis}`);
      return normalized;
    }),
  );
  if (d === null || f === null) return null;
  return d === f ? { d } : { d, f };
}

async function fetchVariant(variant: Variant, names: string[], required: boolean): Promise<Record<string, IconData>> {
  const out: Record<string, IconData> = {};
  const missing: string[] = [];
  const results = await pool(names, CONCURRENCY, (name) => fetchIcon(variant, name));
  names.forEach((name, i) => {
    const icon = results[i];
    if (icon) out[name] = icon;
    else missing.push(name);
  });
  if (required && missing.length > 0) throw new Error(`${variant}: CDN 404 for metadata icons: ${missing.join(', ')}`);
  console.log(`${variant}: ${Object.keys(out).length}/${names.length}${required ? '' : ' (legacy)'}`);
  return out;
}

async function main() {
  const { symbols, legacy } = await loadMetadata();
  const symbolNames = symbols.map((i) => i.name).sort();
  const legacyNames = legacy.map((i) => i.name).sort();

  const symbolData = {} as Record<Variant, Record<string, IconData>>;
  const legacyData = {} as Record<Variant, Record<string, IconData>>;
  for (const variant of VARIANTS) {
    symbolData[variant] = await fetchVariant(variant, symbolNames, true);
    legacyData[variant] = await fetchVariant(variant, legacyNames, false);
  }

  const { aliases, standalone } = buildAliases(symbolData, legacyData);
  await mkdir(DATA_DIR, { recursive: true });
  for (const variant of VARIANTS) {
    await writeFile(path.join(DATA_DIR, `${variant}.json`), formatDataJson({ ...symbolData[variant], ...standalone[variant] }));
  }
  await writeFile(path.join(DATA_DIR, 'aliases.json'), `${JSON.stringify(aliases, Object.keys(aliases).sort(), 2)}\n`);
  const standaloneNames = [...new Set(VARIANTS.flatMap((v) => Object.keys(standalone[v])))].sort();
  const meta = {
    fetchedAt: new Date().toISOString(),
    source: CDN,
    metadata: METADATA_URL,
    counts: Object.fromEntries(VARIANTS.map((v) => [v, Object.keys(symbolData[v]).length])),
    icons: Object.fromEntries(symbols.map((i) => [i.name, i.version]).sort()),
    legacy: standaloneNames,
  };
  await writeFile(path.join(DATA_DIR, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`aliases ${Object.keys(aliases).length} · standalone legacy ${standaloneNames.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
