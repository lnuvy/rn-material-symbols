import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { globToRegExp, listSourceFiles, scanProject, topFiles } from './scanProject';

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

const FIX = path.join(__dirname, '..', '..', 'test', 'fixtures', 'scan');
const NAMES = new Set(['info', 'home', 'settings', 'search', 'close', 'apps', 'check', 'delete']);

test('collects value literals across files, skipping type positions', () => {
  const result = scanProject({ sources: [path.join(FIX, 'app')], nameSet: NAMES, scanner: 'js' });
  expect([...result.names].sort()).toEqual(['home', 'info', 'settings']);
  expect(result.files).toBe(3);
  expect(result.unparsed).toEqual([]);
});

test('sources may be files or dirs outside projectRoot (monorepo shared packages)', () => {
  const result = scanProject({ sources: [path.join(FIX, 'app', 'menu.ts'), path.join(FIX, 'shared')], nameSet: NAMES, scanner: 'js' });
  expect([...result.names].sort()).toEqual(['check', 'home', 'settings']);
});

test('exclude globs remove files', () => {
  const result = scanProject({ sources: [path.join(FIX, 'app')], nameSet: NAMES, exclude: ['**/menu.ts'], scanner: 'js' });
  expect([...result.names].sort()).toEqual(['info']);
});

test('cache is reused when mtime and size are unchanged, and invalidated by cacheKey', () => {
  const dir = tempDir('rnms-');
  const file = path.join(dir, 'a.ts');
  fs.writeFileSync(file, "export const a = 'info';");
  const cacheFile = path.join(dir, 'cache.json');
  scanProject({ sources: [dir], nameSet: NAMES, cacheFile, cacheKey: 'k1', scanner: 'js' });
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  cache.files[file].names = ['home']; // poison: proves the cached value is used
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  expect([...scanProject({ sources: [dir], nameSet: NAMES, cacheFile, cacheKey: 'k1', scanner: 'js' }).names]).toEqual(['home']);
  expect([...scanProject({ sources: [dir], nameSet: NAMES, cacheFile, cacheKey: 'k2', scanner: 'js' }).names]).toEqual(['info']);
});

test('files without any icon-shaped candidate are not parsed', () => {
  const dir = tempDir('rnms-');
  fs.writeFileSync(path.join(dir, 'broken.ts'), 'const = = "Not An Icon";');
  const result = scanProject({ sources: [dir], nameSet: NAMES, scanner: 'js' });
  expect(result.unparsed).toEqual([]);
  expect(result.names.size).toBe(0);
});

test('listSourceFiles skips node_modules, native and dot directories but keeps nested lib/ source folders', () => {
  const dir = tempDir('rnms-');
  for (const rel of ['src/pages/home/lib/status.ts', 'node_modules/dep/index.js', 'ios/Pods/x.js', '.expo/a.js', 'src/App.tsx', 'README.md']) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), "'info'");
  }
  const files = listSourceFiles(dir, []).map((f) => path.relative(dir, f).split(path.sep).join('/')).sort();
  expect(files).toEqual(['src/App.tsx', 'src/pages/home/lib/status.ts']);
});

test('globToRegExp supports ** and *', () => {
  expect(globToRegExp('**/menu.ts').test('a/b/menu.ts')).toBe(true);
  expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true);
  expect(globToRegExp('src/*.ts').test('x/src/a.ts')).toBe(false);
  expect(globToRegExp('src/*.ts').test('src/deep/a.ts')).toBe(false);
});

test('globToRegExp: non-** patterns are anchored at the source root', () => {
  expect(globToRegExp('src/types/icons.ts').test('src/types/icons.ts')).toBe(true);
  expect(globToRegExp('src/types/icons.ts').test('lib/src/types/icons.ts')).toBe(false);
  expect(globToRegExp('dist/**').test('dist/a/b.js')).toBe(true);
  expect(globToRegExp('dist/**').test('packages/dist/a.js')).toBe(false);
});

test('topFiles orders by hit count', () => {
  const byFile = new Map([['a', ['x']], ['b', ['x', 'y', 'z']], ['c', ['x', 'y']]]);
  expect(topFiles(byFile, 2)).toEqual([{ file: 'b', count: 3 }, { file: 'c', count: 2 }]);
});

// --- fix round 1 ---
const tmp = () => tempDir('rnms-');

test('cache is not reused when nameSet changes under the same cacheKey', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.ts'), "export const a = ['info', 'home'];");
  const cacheFile = path.join(dir, 'cache.json');
  const first = scanProject({ sources: [dir], nameSet: new Set(['info']), cacheFile, cacheKey: 'k', scanner: 'js' });
  expect([...first.names]).toEqual(['info']);
  const second = scanProject({ sources: [dir], nameSet: new Set(['info', 'home']), cacheFile, cacheKey: 'k', scanner: 'js' });
  expect([...second.names].sort()).toEqual(['home', 'info']);
});

test('globToRegExp ** matches whole path segments only', () => {
  expect(globToRegExp('**/menu.ts').test('a/xmenu.ts')).toBe(false);
  expect(globToRegExp('**/menu.ts').test('menu.ts')).toBe(true);
  expect(globToRegExp('**/menu.ts').test('a/menu.ts')).toBe(true);
  expect(globToRegExp('**/__tests__/**').test('a/foo__tests__/x.ts')).toBe(false);
  expect(globToRegExp('**/__tests__/**').test('a/__tests__/x.ts')).toBe(true);
  expect(globToRegExp('**/__tests__/**').test('src/__tests__/deep/x.ts')).toBe(true);
  expect(globToRegExp('./src/*.ts').test('src/a.ts')).toBe(true);
});

test('exclude globs are matched relative to the source root, not ancestors', () => {
  const base = tmp();
  const root = path.join(base, '__tests__', 'app');
  fs.mkdirSync(path.join(root, '__tests__'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.ts'), "'info'");
  fs.writeFileSync(path.join(root, '__tests__', 'b.ts'), "'info'");
  const files = listSourceFiles(root, [globToRegExp('**/__tests__/**')]).map((f) => path.relative(root, f));
  expect(files).toEqual(['a.ts']);
  const result = scanProject({ sources: [root], nameSet: NAMES, exclude: ['**/__tests__/**'], scanner: 'js' });
  expect(result.files).toBe(1);
});

test('an unwritable cacheFile does not fail the scan, and unchanged cache is not rewritten', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.ts'), "export const a = 'info';");
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const result = scanProject({ sources: [dir], nameSet: NAMES, cacheFile: path.join(blocker, 'sub', 'cache.json'), cacheKey: 'k', scanner: 'js' });
  expect([...result.names]).toEqual(['info']);

  const cacheFile = path.join(dir, 'c', 'cache.json');
  scanProject({ sources: [dir], nameSet: NAMES, cacheFile, cacheKey: 'k', scanner: 'js' });
  const before = fs.statSync(cacheFile);
  const old = new Date(before.mtimeMs - 60_000);
  fs.utimesSync(cacheFile, old, old);
  scanProject({ sources: [dir], nameSet: NAMES, cacheFile, cacheKey: 'k', scanner: 'js' });
  // Linux filesystems report sub-millisecond mtimes (1790935168815.999), so compare with a tolerance.
  // A rewrite would move mtime to now, 60 s away from `old`.
  expect(Math.abs(fs.statSync(cacheFile).mtimeMs - old.getTime())).toBeLessThan(1000);
  expect(fs.readdirSync(path.dirname(cacheFile))).toEqual(['cache.json']);
});

test('a file removed between listing and read is skipped', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.ts'), "export const a = 'info';");
  fs.writeFileSync(path.join(dir, 'gone.ts'), "export const a = 'home';");
  const real = fs.statSync;
  const spy = jest.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    if (String(p).endsWith('gone.ts')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return (real as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.statSync);
  try {
    const result = scanProject({ sources: [dir], nameSet: NAMES, scanner: 'js' });
    expect([...result.names]).toEqual(['info']);
  } finally {
    spy.mockRestore();
  }
});

test('a missing source root throws a clear error', () => {
  const missing = path.join(tmp(), 'nope');
  expect(() => scanProject({ sources: [missing], nameSet: NAMES, scanner: 'js' })).toThrow(
    `[rn-material-symbols] source not found: ${missing} (check the 'sources' option)`,
  );
});
