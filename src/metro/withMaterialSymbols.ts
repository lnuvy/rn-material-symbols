import path from 'node:path';
import { MATERIAL_SYMBOL_VARIANTS, REGISTRY_MODULE } from '../constants';
import { MATERIAL_SYMBOL_ALIASES, MATERIAL_SYMBOL_LEGACY, MATERIAL_SYMBOL_NAMES } from '../generated/names';
import type { MaterialSymbolAlias, MaterialSymbolName, MaterialSymbolVariant } from '../types';
import { renderRegistry, writeIfChanged } from './renderRegistry';
import type { ScannerMode } from './nativeScanner';
import { scanProject, topFiles } from './scanProject';

export type { ScannerMode } from './nativeScanner';

// Deliberately loose: Metro's real `CustomResolver` takes a `CustomResolutionContext` with many required fields and
// returns a `Resolution`. Typing these strictly here would reject Metro's own config type.
// biome-ignore lint/suspicious/noExplicitAny: must accept Metro's CustomResolver
type ResolveRequest = (context: any, moduleName: string, platform: string | null) => any;

export interface MetroConfigLike {
  projectRoot?: string;
  watchFolders?: readonly string[];
  resolver?: { resolveRequest?: ResolveRequest | null };
}

/** Globs skipped by default: stories and tests rarely reflect icons used at runtime; dist and web-build are Expo web export output (root-anchored). */
export const DEFAULT_EXCLUDE: readonly string[] = ['**/*.stories.*', '**/*.test.*', '**/*.spec.*', '**/__tests__/**', 'dist/**', 'web-build/**'];

type ResolverWithRegistry = { resolver: { resolveRequest: ResolveRequest } };

export interface WithMaterialSymbolsOptions {
  variants?: MaterialSymbolVariant[];
  sources?: string[];
  /**
   * Extra globs to skip, added on top of DEFAULT_EXCLUDE.
   * Globs are matched relative to each source root; absolute paths are not supported.
   */
  exclude?: string[];
  /** Scan stories and tests too (drops DEFAULT_EXCLUDE). Useful for Storybook apps. Default false. */
  includeTests?: boolean;
  include?: Array<MaterialSymbolName | MaterialSymbolAlias>;
  watch?: boolean;
  warnAboveIcons?: number;
  cacheDir?: string;
  /** 'auto' (default) uses the native scanner when installed, else JS. Overridden by RN_MATERIAL_SYMBOLS_SCANNER. */
  scanner?: ScannerMode;
  log?: (line: string) => void;
  /** injected for tests; defaults to ./watch startWatcher */
  startWatcher?: (roots: string[], onChange: () => void, debounceMs?: number, onError?: (error: Error) => void) => () => void;
}

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const ICONS_DIR = path.join(PACKAGE_ROOT, 'icons');
const NAME_SET: ReadonlySet<string> = new Set<string>([
  ...MATERIAL_SYMBOL_NAMES,
  ...Object.keys(MATERIAL_SYMBOL_ALIASES),
  ...MATERIAL_SYMBOL_LEGACY,
]);
const ALIASES: Record<string, string> = { ...MATERIAL_SYMBOL_ALIASES };
const PACKAGE_VERSION: string = require(path.join(PACKAGE_ROOT, 'package.json')).version;
const CACHE_KEY = `${PACKAGE_VERSION}:${NAME_SET.size}`;
const SCANNER_MODES: readonly ScannerMode[] = ['auto', 'js', 'native'];
// Each distinct message is logged once per process; native is still retried on every rescan.
const warnedOnce = new Set<string>();

const activeWatchers = new Map<string, () => void>();

/** Test-only: stop every watcher started by withMaterialSymbols. */
export function __stopAllWatchers(): void {
  for (const stop of activeWatchers.values()) stop();
  activeWatchers.clear();
}

export function shouldWatch(argv: string[], env: NodeJS.ProcessEnv): boolean {
  const forced = env.RN_MATERIAL_SYMBOLS_WATCH;
  if (forced === '1' || forced === 'true') return true;
  if (forced === '0' || forced === 'false') return false;
  // Anything that is not a one-shot bundle/export watches. The watcher is unref'd, so it never keeps a process alive.
  const args = argv.slice(1);
  return !args.some((a) => ['bundle', 'export', 'export:embed', 'ram-bundle'].includes(a));
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function withMaterialSymbols<T extends MetroConfigLike>(config: T, options: WithMaterialSymbolsOptions = {}): T & ResolverWithRegistry {
  const projectRoot = config.projectRoot ?? process.cwd();
  const variants = options.variants ?? ['rounded'];
  const log = options.log ?? ((line: string) => console.log(line));
  const warnAboveIcons = options.warnAboveIcons ?? 800;

  const unknownVariants = variants.filter((v) => !MATERIAL_SYMBOL_VARIANTS.includes(v));
  if (unknownVariants.length > 0) throw new Error(`[rn-material-symbols] unknown variants: ${unknownVariants.join(', ')}`);
  const include = options.include ?? [];
  const unknownInclude = include.filter((n) => !NAME_SET.has(n));
  if (unknownInclude.length > 0) throw new Error(`[rn-material-symbols] include has unknown names: ${unknownInclude.join(', ')}`);

  const sources = (options.sources ?? [projectRoot]).map((s) => path.resolve(projectRoot, s));
  const exclude = [...(options.includeTests ? [] : DEFAULT_EXCLUDE), ...(options.exclude ?? [])];
  const cacheDir = options.cacheDir ?? path.join(projectRoot, 'node_modules', '.cache', 'rn-material-symbols');
  const registryFile = path.join(cacheDir, 'registry.js');

  const envScanner = process.env.RN_MATERIAL_SYMBOLS_SCANNER;
  if (envScanner && !SCANNER_MODES.includes(envScanner as ScannerMode)) {
    throw new Error(`[rn-material-symbols] RN_MATERIAL_SYMBOLS_SCANNER must be one of js|native|auto, got '${envScanner}'`);
  }
  if (options.scanner !== undefined && !SCANNER_MODES.includes(options.scanner)) {
    throw new Error(`[rn-material-symbols] unknown scanner: ${String(options.scanner)} (expected js|native|auto)`);
  }
  const scanner: ScannerMode = (envScanner as ScannerMode | undefined) || (options.scanner ?? 'auto');

  const generate = () => {
    // wall time around scanProject, the same for both engines (the native one also pays napi marshalling and the JS
    // re-extraction of files it could not parse)
    const started = performance.now();
    const scan = scanProject({
      sources,
      nameSet: NAME_SET,
      exclude,
      cacheFile: path.join(cacheDir, 'scan-cache.json'),
      cacheKey: CACHE_KEY,
      scanner,
      expectedNativeVersion: PACKAGE_VERSION,
    });
    const scanMs = performance.now() - started;
    const names = new Set<string>([...scan.names, ...include]);
    const out = renderRegistry({ variants, names, aliases: ALIASES, iconsDir: ICONS_DIR });
    const changed = writeIfChanged(registryFile, out.code);
    const perVariant = variants.map((v) => `${v} ${out.count[v] ?? 0} icons`).join(' · ');
    log(`[rn-material-symbols] ${perVariant} · ${(out.bytes / 1024).toFixed(1)} KB · aliases ${out.aliasesUsed} · safelist ${include.length} · ${scan.files} files (${Math.round(scanMs)}ms) · ${scan.engine}`);
    const once = (line: string) => {
      if (warnedOnce.has(line)) return;
      warnedOnce.add(line);
      log(line);
    };
    if (scan.fallbackReason) once(`[rn-material-symbols] native scanner failed, used JS: ${scan.fallbackReason}`);
    if (scan.nativeVersionWarning) once(`[rn-material-symbols] warning: ${scan.nativeVersionWarning}`);
    const maxCount = Math.max(...variants.map((v) => out.count[v] ?? 0));
    if (maxCount > warnAboveIcons) {
      log(`[rn-material-symbols] warning: more than ${warnAboveIcons} icons. A type union or a list of icon names may have been scanned. Top files:`);
      for (const { file, count } of topFiles(scan.byFile, 5)) log(`  ${path.relative(projectRoot, file)} (${count})`);
      log('  Exclude them with withMaterialSymbols({ exclude: [...] }) if they are not used at runtime.');
    }
    // Once per distinct set of files per process: the native engine never caches unparsed files, so it reports the same
    // set on every rescan (the JS engine only reports files it re-read). A changed set is logged again.
    if (scan.unparsed.length > 0) {
      const key = `unparsed\0${[...scan.unparsed].sort().join('\0')}`;
      if (!warnedOnce.has(key)) {
        warnedOnce.add(key);
        log(`[rn-material-symbols] ${scan.unparsed.length} files fell back to regex scanning (syntax errors?)`);
      }
    }
    return changed;
  };

  generate();

  const watch = options.watch ?? shouldWatch(process.argv, process.env);
  if (watch) {
    // A Metro config can be evaluated more than once per process; keep a single watcher per registry file.
    activeWatchers.get(registryFile)?.();
    activeWatchers.delete(registryFile);
    try {
      const start = options.startWatcher ?? require('./watch').startWatcher;
      const stop = start(sources, () => {
        try {
          generate();
        } catch (error) {
          log(`[rn-material-symbols] rescan failed: ${(error as Error).message}`);
        }
      }, undefined, (error: Error) => log(`[rn-material-symbols] watch error: ${error.message}`));
      if (typeof stop === 'function') activeWatchers.set(registryFile, stop);
    } catch (error) {
      log(`[rn-material-symbols] watch disabled: ${(error as Error).message}`);
    }
  }

  const upstream = config.resolver?.resolveRequest ?? null;
  const resolveRequest: ResolveRequest = (context, moduleName, platform) => {
    if (moduleName === REGISTRY_MODULE) return { type: 'sourceFile', filePath: registryFile };
    return upstream ? upstream(context, moduleName, platform) : context.resolveRequest(context, moduleName, platform);
  };

  const watchFolders = [...(config.watchFolders ?? [])];
  const watched = [projectRoot, ...watchFolders].some((dir) => isInside(cacheDir, dir));
  if (!watched) watchFolders.push(cacheDir);

  return {
    ...config,
    ...(config.watchFolders !== undefined || !watched ? { watchFolders } : {}),
    resolver: { ...config.resolver, resolveRequest },
  };
}
