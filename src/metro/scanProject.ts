import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { extractLiterals } from './extractLiterals';
import { describeLoadError, isNotAvailable, loadNative as defaultLoadNative, nativeCacheFile, type NativeBinding, type NativeScanOutput, versionMismatch, type ScannerMode } from './nativeScanner';

export interface ScanOptions {
  sources: string[];
  nameSet: ReadonlySet<string>;
  exclude?: string[];
  cacheFile?: string;
  cacheKey?: string;
  scanner?: ScannerMode;
  /** injected for tests; defaults to the installed rn-material-symbols-scanner-native */
  loadNative?: () => NativeBinding | null;
  /** this package's version; when set, a native binary whose major.minor differs is reported via `nativeVersionWarning` */
  expectedNativeVersion?: string;
}

export interface ScanResult {
  names: Set<string>;
  byFile: Map<string, string[]>;
  files: number;
  unparsed: string[];
  ms: number;
  engine: 'js' | 'native';
  fallbackReason?: string;
  nativeVersionWarning?: string;
}

interface CacheShape {
  key: string;
  files: Record<string, { mtimeMs: number; size: number; names: string[] }>;
}

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;
// Only directories that are never app source. `lib`/`dist`/`build` are NOT ignored: feature-sliced apps keep source in
// nested `lib/` folders. Build outputs go through `exclude`.
const IGNORED_DIRS = new Set(['node_modules', 'ios', 'android', 'Pods', 'coverage']);
const CANDIDATE = /(['"`])([a-z0-9_]+)\1/g;

export function globToRegExp(glob: string): RegExp {
  const normalized = glob.split(path.sep).join('/').replace(/^(?:\.\/)+/, '');
  let re = '';
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (ch === '*' && normalized[i + 1] === '*') {
      i += 1;
      if (normalized[i + 1] === '/') {
        re += '(?:.*/)?'; // zero or more whole segments
        i += 1;
      } else {
        re += '.*';
      }
    } else if (ch === '*') {
      re += '[^/]*';
    } else {
      re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  // `**/` patterns match at any depth; everything else is anchored at the source root.
  return new RegExp(`^${re}$`);
}

// Exclude globs are matched against the path relative to the source root being walked, never the absolute path,
// so an ancestor directory named like an excluded folder cannot exclude the whole project.
export function listSourceFiles(source: string, exclude: RegExp[]): string[] {
  const out: string[] = [];
  const isExcluded = (rel: string) => exclude.some((re) => re.test(rel));
  const stat = fs.statSync(source);
  if (stat.isFile()) return SOURCE_EXT.test(source) && !isExcluded(path.basename(source)) ? [source] : [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (isExcluded(path.relative(source, full).split(path.sep).join('/'))) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(full);
      } else if (entry.isFile() && SOURCE_EXT.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(source);
  return out;
}

function readCache(file: string | undefined, key: string): CacheShape {
  if (!file || !fs.existsSync(file)) return { key, files: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as CacheShape;
    return parsed.key === key ? parsed : { key, files: {} };
  } catch {
    return { key, files: {} };
  }
}

function nameSetFingerprint(nameSet: ReadonlySet<string>): string {
  const hash = crypto.createHash('sha1');
  for (const n of [...nameSet].sort()) hash.update(n).update('\0');
  return `${nameSet.size}:${hash.digest('hex')}`;
}

function isENOENT(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

// Best-effort: a failing cache must never fail the scan. Atomic via temp file + rename; skipped when unchanged.
function writeCache(file: string, cache: CacheShape): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const content = JSON.stringify(cache);
    try {
      if (fs.readFileSync(file, 'utf8') === content) return;
    } catch {
      // no existing cache
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
  }
}

function scanProjectJs({ sources, nameSet, exclude = [], cacheFile, cacheKey: userKey = 'default' }: ScanOptions): Omit<ScanResult, 'engine'> {
  const started = Date.now();
  const cacheKey = `${userKey}:${nameSetFingerprint(nameSet)}`;
  for (const s of sources) {
    if (!fs.existsSync(s)) throw new Error(`[rn-material-symbols] source not found: ${path.resolve(s)} (check the 'sources' option)`);
  }
  const excludeRes = exclude.map(globToRegExp);
  const cache = readCache(cacheFile, cacheKey);
  const nextCache: CacheShape = { key: cacheKey, files: {} };
  const names = new Set<string>();
  const byFile = new Map<string, string[]>();
  const unparsed: string[] = [];

  const files = [...new Set(sources.flatMap((s) => listSourceFiles(path.resolve(s), excludeRes)))];
  for (const file of files) {
    let hits: string[];
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
      const cached = cache.files[file];
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        hits = cached.names;
      } else {
        const code = fs.readFileSync(file, 'utf8');
        const hasCandidate = [...code.matchAll(CANDIDATE)].some((m) => nameSet.has(m[2]));
        if (hasCandidate) {
          const { literals, parsed } = extractLiterals(code, file);
          if (!parsed) unparsed.push(file);
          hits = [...literals].filter((l) => nameSet.has(l)).sort();
        } else {
          hits = [];
        }
      }
    } catch (e) {
      if (isENOENT(e)) continue; // removed between listing and read (e.g. Metro saving a file mid-scan)
      throw e;
    }
    nextCache.files[file] = { mtimeMs: stat.mtimeMs, size: stat.size, names: hits };
    if (hits.length > 0) byFile.set(file, hits);
    for (const h of hits) names.add(h);
  }

  if (cacheFile) writeCache(cacheFile, nextCache);
  return { names, byFile, files: files.length, unparsed, ms: Date.now() - started };
}

/**
 * oxc rejects some files Babel parses (Flow syntax above all), and the native regex fallback cannot decode escapes
 * (`"ho\\u006de"`), so names the JS scanner finds could be lost. Every file the native scanner reports as unparsed is
 * therefore re-extracted with the JS extractor and its names are merged in: the native result has every name the JS
 * scanner finds in a value position. (It can lack type-position strings that the JS scanner only collects because Babel
 * rejected a file oxc accepts, e.g. `class C { override m(x: 'home') {} }`, and fell back to the regex.) A file stays
 * in `unparsed` only if the JS extractor fails on it too. The native scanner never caches unparsed files, so this also
 * holds on warm runs.
 */
function reextractUnparsed(out: NativeScanOutput, nameSet: ReadonlySet<string>): Pick<ScanResult, 'names' | 'byFile' | 'unparsed'> {
  const byFile = new Map(Object.entries(out.byFile));
  const names = new Set(out.names);
  const unparsed: string[] = [];
  for (const file of out.unparsed) {
    let code: string;
    try {
      code = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (isENOENT(e)) continue; // removed since the native scan read it
      throw e;
    }
    const { literals, parsed } = extractLiterals(code, file);
    if (!parsed) unparsed.push(file);
    const hits = new Set(byFile.get(file));
    for (const l of literals) if (nameSet.has(l)) hits.add(l);
    if (hits.size > 0) byFile.set(file, [...hits].sort());
    for (const h of hits) names.add(h);
  }
  return { names: new Set([...names].sort()), byFile, unparsed };
}

export function scanProject(options: ScanOptions): ScanResult {
  const mode = options.scanner ?? 'auto';
  if (mode === 'js') return { ...scanProjectJs(options), engine: 'js' };

  // The JS retry after a native failure: if it throws too, keep the native reason in the message.
  const retryWithJs = (reason: string | undefined): ScanResult => {
    try {
      return { ...scanProjectJs(options), engine: 'js', ...(reason ? { fallbackReason: reason } : {}) };
    } catch (error) {
      if (!reason) throw error;
      const suffix = ` (native scanner also failed: ${reason})`;
      if (error instanceof Error) {
        error.message += suffix;
        throw error;
      }
      throw new Error(`${String(error)}${suffix}`);
    }
  };

  let native: NativeBinding | null = null;
  let loadError: unknown;
  try {
    native = (options.loadNative ?? defaultLoadNative)();
  } catch (error) {
    loadError = error;
  }
  if (!native) {
    const missing = loadError === undefined || isNotAvailable(loadError);
    const cause = loadError === undefined ? '' : describeLoadError(loadError);
    if (mode === 'native') {
      throw new Error(
        missing
          ? `[rn-material-symbols] scanner: 'native' was requested but rn-material-symbols-scanner-native is not installed for this platform${cause ? ` (${cause})` : ''}`
          : `[rn-material-symbols] scanner: 'native' was requested but rn-material-symbols-scanner-native failed to load: ${cause}`,
      );
    }
    return retryWithJs(missing ? undefined : `rn-material-symbols-scanner-native failed to load: ${cause}`);
  }

  try {
    for (const s of options.sources) {
      if (!fs.existsSync(s)) throw new Error(`[rn-material-symbols] source not found: ${path.resolve(s)} (check the 'sources' option)`);
    }
    const nativeVersionWarning = options.expectedNativeVersion ? versionMismatch(native.version(), options.expectedNativeVersion) : undefined;
    const out = native.scan({
      sources: options.sources.map((s) => path.resolve(s)),
      names: [...options.nameSet],
      excludeRegex: (options.exclude ?? []).map((g) => globToRegExp(g).source),
      cacheFile: nativeCacheFile(options.cacheFile),
      // the binary version is part of the key: a different extractor must not reuse another one's results
      cacheKey: `${options.cacheKey ?? 'default'}:${native.version()}:${nameSetFingerprint(options.nameSet)}`,
    });
    const { names, byFile, unparsed } = reextractUnparsed(out, options.nameSet);
    return {
      names,
      byFile,
      files: out.files,
      unparsed,
      ms: out.ms, // engine-reported; excludes the JS re-extraction of unparsed files
      engine: 'native',
      ...(nativeVersionWarning ? { nativeVersionWarning } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('[rn-material-symbols] source not found')) throw error;
    if (mode === 'native') throw error;
    return retryWithJs(message);
  }
}

export function topFiles(byFile: Map<string, string[]>, limit: number): Array<{ file: string; count: number }> {
  return [...byFile.entries()]
    .map(([file, hits]) => ({ file, count: hits.length }))
    .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
    .slice(0, limit);
}
