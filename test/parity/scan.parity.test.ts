import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MATERIAL_SYMBOL_ALIASES, MATERIAL_SYMBOL_LEGACY, MATERIAL_SYMBOL_NAMES } from '../../src/generated/names';
import type { NativeBinding } from '../../src/metro/nativeScanner';
import { nativeCacheFile } from '../../src/metro/nativeScanner';
import { type ScanResult, scanProject } from '../../src/metro/scanProject';
import { DEFAULT_EXCLUDE } from '../../src/metro/withMaterialSymbols';
import { loadNative } from './loadNative';

const d = loadNative() ? describe : describe.skip;
const repo = path.join(__dirname, '..', '..');
const unix = process.platform !== 'win32';

/** Files that DEFAULT_EXCLUDE removes; each holds an icon name so a leak would show in byFile. */
const EXCLUDED_BY_DEFAULT = ['src/Button.test.ts', 'src/__tests__/a.ts', 'src/Card.stories.tsx', 'dist/index.js'];
/** Paths the walk must prune whatever the exclude option says: ignored and dot directories (written as files)… */
const PRUNED_DIRS = ['node_modules/dep/index.js', 'ios/Pods/x.js', 'pkg/ios/y.ts', '.hidden/z.ts'];
/** …and symlinks (created as links to targets outside the corpus, Unix only). */
const PRUNED_SYMLINKS = ['src/link.ts', 'src/linkdir/w.ts'];
const ALWAYS_PRUNED = [...PRUNED_DIRS, ...PRUNED_SYMLINKS];
/**
 * Flow syntax (oxc rejects it, Babel parses it) with names only the JS extractor can see: an escaped `home` the native
 * regex fallback cannot decode. scanProject re-extracts native's unparsed files with the JS extractor, so the scan
 * results must still be identical. No literal sits in a type position, so the regex over-inclusion does not show.
 */
const FLOW_FILES: Record<string, string> = {
  'src/flow/Icon.js': '// @flow\ntype Icon = {| name: string |};\nexport const a = "info";\nexport const b = "ho\\u006de";\n',
  'src/flow/Tabs.jsx': '// @flow\ntype P = {| +tab: string |};\nexport const t = <Tab icon={"\\u0073earch"} label=\'settings\' />;\n',
};

function write(root: string, rel: string, code: string) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, code);
}

const sorted = (r: ScanResult) => ({
  names: [...r.names].sort(),
  byFile: Object.fromEntries([...r.byFile].sort()),
  files: r.files,
  unparsed: [...r.unparsed].sort(),
});

// The synthetic corpus has no deep nesting and its only Flow files (FLOW_FILES) keep literals out of type positions,
// so names, byFile, file count and (cold, no cache) unparsed must be identical. Engines emit in different orders
// (native: path order, JS: listing order), so compare sorted.
d('native scan matches JS scan', () => {
  let dir: string;
  let outside: string;
  const nameSet = new Set<string>([...MATERIAL_SYMBOL_NAMES, ...Object.keys(MATERIAL_SYMBOL_ALIASES), ...MATERIAL_SYMBOL_LEGACY]);

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnms-corpus-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rnms-outside-'));
    execFileSync('pnpm', ['exec', 'tsx', 'scripts/gen-corpus.ts', dir, '--files=2000', '--seed=7'], { cwd: repo });
    for (const rel of EXCLUDED_BY_DEFAULT) write(dir, rel, "export const a = 'home';\n");
    for (const rel of PRUNED_DIRS) write(dir, rel, "export const a = 'settings';\n");
    for (const [rel, code] of Object.entries(FLOW_FILES)) write(dir, rel, code);
    if (unix) {
      // symlink targets live outside the corpus, so the link is the only way to reach them
      write(outside, 'target.ts', "export const a = 'search';\n");
      write(outside, 'dir/w.ts', "export const a = 'search';\n");
      fs.symlinkSync(path.join(outside, 'target.ts'), path.join(dir, 'src/link.ts'));
      fs.symlinkSync(path.join(outside, 'dir'), path.join(dir, 'src/linkdir'));
    }
  }, 60000);
  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if (outside) fs.rmSync(outside, { recursive: true, force: true });
  });

  const both = (exclude: string[]) => {
    const js = scanProject({ sources: [dir], nameSet, exclude, scanner: 'js' });
    const rs = scanProject({ sources: [dir], nameSet, exclude, scanner: 'native' });
    expect(js.engine).toBe('js');
    expect(rs.engine).toBe('native');
    expect(sorted(rs)).toEqual(sorted(js));
    for (const rel of ALWAYS_PRUNED) expect(js.byFile.has(path.join(dir, rel))).toBe(false);
    return js;
  };

  test('synthetic corpus + pruning fixtures, default excludes and none', () => {
    const withDefault = both([...DEFAULT_EXCLUDE]);
    const none = both([]);
    expect(withDefault.files).toBe(2000 + Object.keys(FLOW_FILES).length);
    // the Flow fixtures were exercised: native could not parse them, the JS re-extraction recovered the escaped names
    expect(withDefault.byFile.get(path.join(dir, 'src/flow/Icon.js'))).toEqual(['home', 'info']);
    expect(withDefault.byFile.get(path.join(dir, 'src/flow/Tabs.jsx'))).toEqual(['search', 'settings']);
    const raw = loadNative<NativeBinding>()!.scan({ sources: [dir], names: [...nameSet], excludeRegex: [], cacheKey: 'raw' });
    for (const rel of Object.keys(FLOW_FILES)) expect(raw.unparsed).toContain(path.join(dir, rel));
    expect(withDefault.names.size).toBeGreaterThan(100);
    // the excludes were exercised: exactly the DEFAULT_EXCLUDE fixtures come back without them
    expect(none.files).toBe(withDefault.files + EXCLUDED_BY_DEFAULT.length);
    for (const rel of EXCLUDED_BY_DEFAULT) {
      expect(withDefault.byFile.has(path.join(dir, rel))).toBe(false);
      expect(none.byFile.get(path.join(dir, rel))).toEqual(['home']);
    }
  }, 60000);
});

// A JSX attribute entity (`name="ho&#109;e"`): Babel decodes it to `home`, oxc keeps the raw text. The file parses in
// both engines, so scanProject does NOT re-extract it with JS — the native extractor must decode on its own, and the
// result it caches must hold the decoded name so warm runs keep it.
d('JSX attribute entities through the real binary', () => {
  test('cold and warm (cache file): both engines find home', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnms-entity-'));
    try {
      const files = ['src/Icon.tsx', 'src/Icon2.jsx', 'src/Icon3.js'].map((rel) => path.join(dir, rel));
      for (const f of files) write(dir, path.relative(dir, f), 'const marker = "info"; const icon = <MaterialIcon name="ho&#109;e" />;\n');
      const nameSet = new Set(['home', 'info']);
      const native = loadNative<NativeBinding>()!;
      const cacheFile = path.join(dir, '.cache', 'scan-cache.json');
      for (const run of ['cold', 'warm']) {
        const js = scanProject({ sources: [dir], nameSet, scanner: 'js', cacheFile });
        const rs = scanProject({ sources: [dir], nameSet, scanner: 'native', cacheFile, loadNative: () => native });
        expect(rs.engine).toBe('native');
        for (const r of [js, rs]) {
          expect({ run, names: [...r.names].sort(), unparsed: r.unparsed }).toEqual({ run, names: ['home', 'info'], unparsed: [] });
          for (const f of files) expect({ run, f, names: r.byFile.get(f) }).toEqual({ run, f, names: ['home', 'info'] });
        }
        // the native cache (written cold, read warm) holds the decoded name
        const cached = JSON.parse(fs.readFileSync(nativeCacheFile(cacheFile)!, 'utf8')) as { files: Record<string, { names: string[] }> };
        for (const f of files) expect({ run, f, names: cached.files[f]?.names }).toEqual({ run, f, names: ['home', 'info'] });
      }
      // the engine itself, without scanProject's JS re-extraction of unparsed files
      const raw = native.scan({ sources: [dir], names: [...nameSet], excludeRegex: [], cacheKey: 'raw' });
      expect({ unparsed: raw.unparsed, names: raw.names }).toEqual({ unparsed: [], names: ['home', 'info'] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
