import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NativeBinding } from './nativeScanner';
import { loadNative } from './nativeScanner';
import { __stopAllWatchers, DEFAULT_EXCLUDE, shouldWatch, withMaterialSymbols } from './withMaterialSymbols';

// every temp dir this file creates is removed after the file's tests
const createdTempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of createdTempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// The suite never touches the real binary: loadNative is mocked ("not available" by default => JS engine), so results
// are identical with or without native/scanner.*.node present.
jest.mock('./nativeScanner', () => ({ ...jest.requireActual('./nativeScanner'), loadNative: jest.fn() }));
const loadNativeMock = loadNative as jest.MockedFunction<typeof loadNative>;
beforeEach(() => {
  loadNativeMock.mockReset();
  loadNativeMock.mockReturnValue(null);
});

function project(files: Record<string, string>) {
  const root = tempDir('rnms-proj-');
  for (const [rel, code] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), code);
  }
  return root;
}

const quiet = { watch: false, log: () => {} };

test('writes a registry with only the scanned icons and resolves the virtual module to it', () => {
  const root = project({ 'src/App.tsx': "<MaterialIcon name='info' />; const x = 'access_time';" });
  const config = withMaterialSymbols({ projectRoot: root, resolver: {} }, quiet);
  const registryFile = path.join(root, 'node_modules', '.cache', 'rn-material-symbols', 'registry.js');
  const code = fs.readFileSync(registryFile, 'utf8');
  expect(code).toContain('"info": require(');
  expect(code).toContain('"access_time":');
  expect(code).not.toContain('"home"');
  const resolved = config.resolver!.resolveRequest!({ resolveRequest: () => 'default' } as never, 'rn-material-symbols/registry', 'ios');
  expect(resolved).toEqual({ type: 'sourceFile', filePath: registryFile });
});

test('chains to the upstream resolveRequest for other modules', () => {
  const root = project({ 'a.ts': "'info'" });
  const upstream = jest.fn(() => ({ type: 'sourceFile', filePath: '/up' }));
  const config = withMaterialSymbols({ projectRoot: root, resolver: { resolveRequest: upstream } }, quiet);
  const ctx = { resolveRequest: jest.fn() };
  expect(config.resolver!.resolveRequest!(ctx as never, 'react', 'android')).toEqual({ type: 'sourceFile', filePath: '/up' });
  expect(upstream).toHaveBeenCalledWith(ctx, 'react', 'android');
  expect(ctx.resolveRequest).not.toHaveBeenCalled();
});

test('falls back to context.resolveRequest when there is no upstream', () => {
  const root = project({ 'a.ts': "'info'" });
  const config = withMaterialSymbols({ projectRoot: root }, quiet);
  const ctx = { resolveRequest: jest.fn(() => 'default') };
  expect(config.resolver!.resolveRequest!(ctx as never, 'react', null)).toBe('default');
});

test('include safelist adds icons, unknown names throw with a list', () => {
  const root = project({ 'a.ts': '' });
  withMaterialSymbols({ projectRoot: root }, { ...quiet, include: ['cloud_download'] });
  expect(fs.readFileSync(path.join(root, 'node_modules', '.cache', 'rn-material-symbols', 'registry.js'), 'utf8')).toContain('"cloud_download"');
  expect(() => withMaterialSymbols({ projectRoot: root }, { ...quiet, include: ['nope_x', 'info'] as never })).toThrow(
    '[rn-material-symbols] include has unknown names: nope_x',
  );
  expect(() => withMaterialSymbols({ projectRoot: root }, { ...quiet, variants: ['two-tone'] as never })).toThrow(
    '[rn-material-symbols] unknown variants: two-tone',
  );
});

test('reports one line, and warns with top files above warnAboveIcons', () => {
  const root = project({ 'types-like.ts': "export const ALL = ['info','home','close','check'];" });
  const lines: string[] = [];
  withMaterialSymbols({ projectRoot: root }, { watch: false, warnAboveIcons: 3, log: (l) => lines.push(l) });
  expect(lines[0]).toMatch(/^\[rn-material-symbols\] rounded 4 icons · [\d.]+ KB · aliases 0 · safelist 0 · 1 files \(\d+ms\) · (?:js|native)$/);
  expect(lines[1]).toContain('more than 3 icons');
  expect(lines[2]).toContain('types-like.ts (4)');
});

test('adds the cache dir to watchFolders when it is outside projectRoot and watchFolders', () => {
  const root = project({ 'a.ts': "'info'" });
  const cacheDir = tempDir('rnms-cache-');
  const config = withMaterialSymbols({ projectRoot: root, watchFolders: [] }, { ...quiet, cacheDir });
  expect(config.watchFolders).toEqual([cacheDir]);
  const inside = withMaterialSymbols({ projectRoot: root, watchFolders: ['/x'] }, quiet);
  expect(inside.watchFolders).toEqual(['/x']);
});

test('starts the injected watcher only when watch is true', () => {
  const root = project({ 'a.ts': "'info'" });
  const startWatcher = jest.fn(() => () => {});
  withMaterialSymbols({ projectRoot: root }, { ...quiet, startWatcher });
  expect(startWatcher).not.toHaveBeenCalled();
  withMaterialSymbols({ projectRoot: root }, { ...quiet, watch: true, startWatcher });
  expect(startWatcher).toHaveBeenCalledWith([root], expect.any(Function), undefined, expect.any(Function));
  __stopAllWatchers();
});

test('shouldWatch: env wins, then argv', () => {
  expect(shouldWatch(['node', 'react-native', 'bundle'], { RN_MATERIAL_SYMBOLS_WATCH: '1' })).toBe(true);
  expect(shouldWatch(['node', 'react-native', 'start'], { RN_MATERIAL_SYMBOLS_WATCH: '0' })).toBe(false);
  expect(shouldWatch(['node', 'react-native', 'start'], {})).toBe(true);
  expect(shouldWatch(['node', 'expo', 'start'], {})).toBe(true);
  expect(shouldWatch(['node', 'react-native', 'run-ios'], {})).toBe(true);
  expect(shouldWatch(['node', 'react-native', 'bundle'], {})).toBe(false);
  expect(shouldWatch(['node', 'expo', 'export'], {})).toBe(false);
  expect(shouldWatch(['node', 'expo', 'run:ios'], {})).toBe(true);
  expect(shouldWatch(['node', 'expo', 'run:android'], {})).toBe(true);
  expect(shouldWatch(['node', 'expo'], {})).toBe(true);
  expect(shouldWatch(['node', 'jest'], {})).toBe(true);
  expect(shouldWatch(['node', 'react-native', 'ram-bundle'], {})).toBe(false);
  expect(shouldWatch(['node', 'expo', 'export:embed'], {})).toBe(false);
});

describe('default excludes', () => {
  const registryOf = (root: string) => fs.readFileSync(path.join(root, 'node_modules', '.cache', 'rn-material-symbols', 'registry.js'), 'utf8');
  const files = { 'src/App.tsx': "export const a = 'info';", 'src/Button.stories.tsx': "export const s = 'home';" };

  test('exports the default globs', () => {
    expect(DEFAULT_EXCLUDE).toEqual(['**/*.stories.*', '**/*.test.*', '**/*.spec.*', '**/__tests__/**', 'dist/**', 'web-build/**']);
  });

  test('Expo web export output at the source root is not scanned', () => {
    const root = project({ 'src/App.tsx': "export const a = 'info';", 'dist/bundle.js': "export const d = 'home';", 'web-build/x.js': "export const w = 'search';" });
    withMaterialSymbols({ projectRoot: root }, quiet);
    const reg = registryOf(root);
    expect(reg).toContain('"info"');
    expect(reg).not.toContain('"home"');
    expect(reg).not.toContain('"search"');
  });

  test('a stories file is not scanned by default', () => {
    const root = project(files);
    withMaterialSymbols({ projectRoot: root }, quiet);
    expect(registryOf(root)).toContain('"info"');
    expect(registryOf(root)).not.toContain('"home"');
  });

  test('includeTests: true scans stories/tests', () => {
    const root = project(files);
    withMaterialSymbols({ projectRoot: root }, { ...quiet, includeTests: true });
    expect(registryOf(root)).toContain('"home"');
  });

  test('user exclude adds to the defaults', () => {
    const root = project({ ...files,  'src/gen/Big.ts': "export const b = 'close';", 'src/Keep.ts': "export const c = 'check';" });
    withMaterialSymbols({ projectRoot: root }, { ...quiet, exclude: ['**/gen/**'] });
    const code = registryOf(root);
    expect(code).toContain('"check"');
    expect(code).not.toContain('"close"');
    expect(code).not.toContain('"home"');
  });
});

describe('watch wiring', () => {
  const watching = (log: (line: string) => void) => ({ watch: true, log });

  test('a second evaluation stops the first watcher before starting a new one', () => {
    const root = project({ 'a.ts': "'info'" });
    const stopFirst = jest.fn();
    const stopSecond = jest.fn();
    const startWatcher = jest.fn().mockReturnValueOnce(stopFirst).mockReturnValueOnce(stopSecond);
    withMaterialSymbols({ projectRoot: root }, { ...watching(() => {}), startWatcher });
    expect(stopFirst).not.toHaveBeenCalled();
    withMaterialSymbols({ projectRoot: root }, { ...watching(() => {}), startWatcher });
    expect(stopFirst).toHaveBeenCalledTimes(1);
    expect(startWatcher).toHaveBeenCalledTimes(2);
    __stopAllWatchers();
    expect(stopSecond).toHaveBeenCalledTimes(1);
  });

  test('a throwing startWatcher disables watching but still returns a config', () => {
    const root = project({ 'a.ts': "'info'" });
    const lines: string[] = [];
    const config = withMaterialSymbols({ projectRoot: root }, {
      ...watching((l) => lines.push(l)),
      startWatcher: () => {
        throw new Error('EMFILE');
      },
    });
    expect(config.resolver.resolveRequest).toBeInstanceOf(Function);
    expect(lines.join('\n')).toContain('[rn-material-symbols] watch disabled: EMFILE');
  });

  test('passes an onError that logs watch errors', () => {
    const root = project({ 'a.ts': "export const a = 'info';" });
    const lines: string[] = [];
    let onError: ((e: Error) => void) | undefined;
    withMaterialSymbols({ projectRoot: root }, {
      ...watching((l) => lines.push(l)),
      startWatcher: (_r, _c, _d, cb) => {
        onError = cb;
        return () => {};
      },
    });
    onError!(new Error('ENOSPC'));
    expect(lines.join('\n')).toContain('[rn-material-symbols] watch error: ENOSPC');
    __stopAllWatchers();
  });

  test('the real ./watch module loads and regenerates the registry on change', async () => {
    const root = project({ 'src/a.ts': "export const a = 'info';" });
    withMaterialSymbols({ projectRoot: root }, watching(() => {}));
    try {
      await new Promise((r) => setTimeout(r, 100));
      fs.writeFileSync(path.join(root, 'src', 'b.ts'), "export const b = 'home';");
      const registry = path.join(root, 'node_modules', '.cache', 'rn-material-symbols', 'registry.js');
      const deadline = Date.now() + 3000;
      while (!fs.readFileSync(registry, 'utf8').includes('"home"') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(fs.readFileSync(registry, 'utf8')).toContain('"home"');
      __stopAllWatchers();
      const before = fs.readFileSync(registry, 'utf8');
      fs.writeFileSync(path.join(root, 'src', 'c.ts'), "export const c = 'close';");
      await new Promise((r) => setTimeout(r, 300));
      expect(fs.readFileSync(registry, 'utf8')).toBe(before);
      expect(before).not.toContain('"close"');
    } finally {
      __stopAllWatchers();
    }
  });
});

test('reports the scanner engine and honours RN_MATERIAL_SYMBOLS_SCANNER', () => {
  const root = project({ 'a.ts': "export const a = 'info';" });
  const lines: string[] = [];
  const prev = process.env.RN_MATERIAL_SYMBOLS_SCANNER;
  process.env.RN_MATERIAL_SYMBOLS_SCANNER = 'js';
  try {
    withMaterialSymbols({ projectRoot: root }, { watch: false, scanner: 'native', log: (l) => lines.push(l) });
  } finally {
    if (prev === undefined) delete process.env.RN_MATERIAL_SYMBOLS_SCANNER;
    else process.env.RN_MATERIAL_SYMBOLS_SCANNER = prev;
  }
  expect(lines[0]).toMatch(/ · js$/);
});

const nativeBinding = (version: string, scan?: NativeBinding['scan']): NativeBinding => ({
  version: () => version,
  scan: scan ?? (() => ({ names: ['info'], byFile: { '/x/a.ts': ['info'] }, files: 1, unparsed: [], ms: 12.6 })),
  extractLiterals: () => ({ literals: [], parsed: true }),
});

function generateTwice(root: string, lines: string[], extra: Record<string, unknown> = {}) {
  let rescan: () => void = () => {};
  withMaterialSymbols({ projectRoot: root }, {
    watch: true,
    log: (l) => lines.push(l),
    startWatcher: (_roots, onChange) => {
      rescan = onChange;
      return () => {};
    },
    ...extra,
  });
  rescan();
}

// Same major.minor as this package, different patch: must not warn.
const SAME_MINOR_VERSION = `${require('../../package.json').version.split('.').slice(0, 2).join('.')}.99`;

test('native path: report line ends with · native and shows the wall time around the scan, not the engine ms', () => {
  // the engine claims 1ms but the call takes ~40ms: the line must show what the caller paid
  const slowScan = () => {
    const until = Date.now() + 40;
    while (Date.now() < until) {
      // busy-wait
    }
    return { names: ['info'], byFile: { '/x/a.ts': ['info'] }, files: 1, unparsed: [], ms: 1 };
  };
  loadNativeMock.mockReturnValue(nativeBinding(SAME_MINOR_VERSION, slowScan));
  const lines: string[] = [];
  withMaterialSymbols({ projectRoot: project({ 'a.ts': "'info'" }) }, { watch: false, scanner: 'native', log: (l) => lines.push(l) });
  const ms = / \((\d+)ms\) · native$/.exec(lines[0]);
  expect(ms).not.toBeNull();
  expect(Number(ms![1])).toBeGreaterThanOrEqual(35);
  expect(lines.some((l) => l.includes('warning: rn-material-symbols-scanner-native'))).toBe(false);
});

test('native failure in auto logs the fallback line once per distinct reason, across rescans', () => {
  loadNativeMock.mockReturnValue(
    nativeBinding(SAME_MINOR_VERSION, () => {
      throw new Error('boom-once');
    }),
  );
  const lines: string[] = [];
  generateTwice(project({ 'a.ts': "'info'" }), lines);
  expect(lines.filter((l) => l.includes('native scanner failed, used JS: boom-once'))).toHaveLength(1);
  expect(lines.filter((l) => l.endsWith(' · js'))).toHaveLength(2);
});

test('the regex-fallback line is logged once per distinct set of unparsed files, across rescans', () => {
  // syntax errors in both engines, so the JS re-extraction keeps them in `unparsed`
  const root = project({ 'a.ts': "const a = 'info'; <", 'b.ts': "const b = 'home'; <" });
  const [a, b] = ['a.ts', 'b.ts'].map((f) => path.join(root, f));
  let unparsed = [a];
  loadNativeMock.mockReturnValue(
    nativeBinding(SAME_MINOR_VERSION, () => ({ names: [], byFile: {}, files: 2, unparsed, ms: 1 })),
  );
  const lines: string[] = [];
  let rescan: () => void = () => {};
  withMaterialSymbols({ projectRoot: root }, {
    watch: true,
    log: (l) => lines.push(l),
    startWatcher: (_roots, onChange) => {
      rescan = onChange;
      return () => {};
    },
  });
  rescan();
  const fellBack = () => lines.filter((l) => l.includes('fell back to regex scanning'));
  expect(fellBack()).toEqual(['[rn-material-symbols] 1 files fell back to regex scanning (syntax errors?)']);
  unparsed = [b]; // same count, different file: logged again
  rescan();
  unparsed = [b, a];
  rescan();
  rescan();
  expect(fellBack()).toHaveLength(3);
  expect(lines.filter((l) => l.endsWith(' · native'))).toHaveLength(5);
});

test('a version mismatch warning is logged exactly once across two generate calls', () => {
  loadNativeMock.mockReturnValue(nativeBinding('9.9.0'));
  const lines: string[] = [];
  generateTwice(project({ 'a.ts': "'info'" }), lines);
  expect(lines.filter((l) => l.includes('9.9.0 does not match'))).toHaveLength(1);
  expect(lines.filter((l) => l.endsWith(' · native'))).toHaveLength(2);
});

test('rejects an invalid scanner option or environment value', () => {
  const root = project({ 'a.ts': "'info'" });
  expect(() => withMaterialSymbols({ projectRoot: root }, { ...quiet, scanner: 'fast' as never })).toThrow('unknown scanner: fast (expected js|native|auto)');
  const prev = process.env.RN_MATERIAL_SYMBOLS_SCANNER;
  process.env.RN_MATERIAL_SYMBOLS_SCANNER = 'rust';
  try {
    expect(() => withMaterialSymbols({ projectRoot: root }, quiet)).toThrow('RN_MATERIAL_SYMBOLS_SCANNER must be one of js|native|auto');
  } finally {
    if (prev === undefined) delete process.env.RN_MATERIAL_SYMBOLS_SCANNER;
    else process.env.RN_MATERIAL_SYMBOLS_SCANNER = prev;
  }
});
