import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadNative as loadRealNative } from '../../test/parity/loadNative';
import { describeLoadError, isNotAvailable, type NativeBinding, versionMismatch } from './nativeScanner';
import { scanProject } from './scanProject';

const NAMES = new Set(['info', 'home']);

const temps: string[] = [];
const tempDir = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function fingerprint(set: Set<string>) {
  const hash = crypto.createHash('sha1');
  for (const n of [...set].sort()) hash.update(n).update('\0');
  return `${set.size}:${hash.digest('hex')}`;
}

function project() {
  const dir = tempDir('rnms-nat-');
  fs.writeFileSync(path.join(dir, 'a.ts'), "export const a = 'info';");
  return dir;
}

const fakeNative =
  (impl: (o: any) => any, version = '0.2.0') =>
  () => ({ version: () => version, scan: impl, extractLiterals: () => ({ literals: [], parsed: true }) });

test('auto uses native when it loads and maps its result', () => {
  const calls: any[] = [];
  const r = scanProject({
    sources: [project()],
    nameSet: NAMES,
    scanner: 'auto',
    loadNative: fakeNative((o) => {
      calls.push(structuredClone(o));
      return { names: ['info'], byFile: { '/x/a.ts': ['info'] }, files: 1, unparsed: [], ms: 1 };
    }),
  });
  expect(r.engine).toBe('native');
  expect([...r.names]).toEqual(['info']);
  expect(r.byFile.get('/x/a.ts')).toEqual(['info']);
  expect([...calls[0].names].sort()).toEqual(['home', 'info']);
  expect(Array.isArray(calls[0].excludeRegex)).toBe(true);
  expect(calls[0].cacheKey).toBe(`default:0.2.0:${fingerprint(NAMES)}`);
});

test('the native cache key includes the binary version', () => {
  const keys: string[] = [];
  for (const version of ['0.2.0', '0.2.1']) {
    scanProject({
      sources: [project()],
      nameSet: NAMES,
      cacheKey: 'k',
      loadNative: fakeNative((o) => {
        keys.push(o.cacheKey);
        return { names: [], byFile: {}, files: 0, unparsed: [], ms: 0 };
      }, version),
    });
  }
  expect(keys).toEqual([`k:0.2.0:${fingerprint(NAMES)}`, `k:0.2.1:${fingerprint(NAMES)}`]);
});

test('files native reports as unparsed are re-extracted with the JS extractor and merged in', () => {
  const dir = project();
  const flow = path.join(dir, 'f.js');
  const broken = path.join(dir, 'broken.ts');
  const gone = path.join(dir, 'gone.js');
  // Babel parses Flow; the escaped `home` is invisible to a regex fallback
  fs.writeFileSync(flow, 'type Icon = {| name: string |}; const a = "info"; const b = "ho\\u006de";');
  fs.writeFileSync(broken, "const a = 'home'; <div");
  const r = scanProject({
    sources: [dir],
    nameSet: NAMES,
    scanner: 'native',
    loadNative: fakeNative(() => ({
      names: ['info'],
      byFile: { [flow]: ['info'], [broken]: ['home'] },
      files: 4,
      unparsed: [broken, flow, gone], // gone.js vanished after the native scan read it
      ms: 0,
    })),
  });
  expect(r.engine).toBe('native');
  expect([...r.names]).toEqual(['home', 'info']);
  expect(r.byFile.get(flow)).toEqual(['home', 'info']);
  expect(r.byFile.get(broken)).toEqual(['home']);
  expect(r.byFile.has(gone)).toBe(false);
  // only the file the JS extractor cannot parse either is still reported
  expect(r.unparsed).toEqual([broken]);
});

test('a read error other than ENOENT during the re-extraction is handled like the JS scanner does (auto: JS retry)', () => {
  const dir = project();
  const flow = path.join(dir, 'f.js');
  fs.writeFileSync(flow, 'type Icon = {| name: string |}; const a = "info";');
  const native = fakeNative(() => ({ names: ['info'], byFile: { [flow]: ['info'] }, files: 2, unparsed: [flow], ms: 0 }));
  const real = fs.readFileSync;
  const spy = jest.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (file === flow) throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' });
    return (real as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFileSync);
  try {
    expect(() => scanProject({ sources: [dir], nameSet: NAMES, scanner: 'native', loadNative: native })).toThrow('EACCES: denied');
    // auto: the native attempt fails, the JS retry hits the same error and reports both
    expect(() => scanProject({ sources: [dir], nameSet: NAMES, scanner: 'auto', loadNative: native })).toThrow(/EACCES: denied \(native scanner also failed: EACCES: denied\)/);
  } finally {
    spy.mockRestore();
  }
});

// Real binary: a Flow file oxc cannot parse, with an escaped name the regex fallback cannot decode. The JS scanner
// finds both names; the native result must too, cold AND warm (unparsed files are never served from the cache).
const realNative = loadRealNative<NativeBinding>();
(realNative ? test : test.skip)('real binary: names only the JS extractor finds survive cold and warm runs', () => {
  const dir = tempDir('rnms-flow-');
  fs.writeFileSync(path.join(dir, 'a.js'), 'type Icon = {| name: string |}; const a = "info"; const b = "ho\\u006de";');
  fs.writeFileSync(path.join(dir, 'b.ts'), "export const b = 'info';");
  const cacheFile = path.join(dir, '.cache', 'scan-cache.json');
  const js = scanProject({ sources: [dir], nameSet: NAMES, scanner: 'js' });
  expect([...js.names].sort()).toEqual(['home', 'info']);
  for (const run of ['cold', 'warm']) {
    const rs = scanProject({ sources: [dir], nameSet: NAMES, scanner: 'native', cacheFile, loadNative: () => realNative });
    expect({ run, engine: rs.engine, names: [...rs.names].sort(), a: rs.byFile.get(path.join(dir, 'a.js')), unparsed: rs.unparsed }).toEqual({
      run,
      engine: 'native',
      names: ['home', 'info'],
      a: ['home', 'info'],
      unparsed: [],
    });
    expect(fs.existsSync(path.join(dir, '.cache', 'scan-cache.native.json'))).toBe(true);
  }
});

test('auto falls back to JS when native cannot load', () => {
  const r = scanProject({ sources: [project()], nameSet: NAMES, scanner: 'auto', loadNative: () => null });
  expect(r.engine).toBe('js');
  expect([...r.names]).toEqual(['info']);
});

test('auto falls back to JS when native throws, and reports why', () => {
  const r = scanProject({
    sources: [project()],
    nameSet: NAMES,
    scanner: 'auto',
    loadNative: fakeNative(() => {
      throw new Error('boom');
    }),
  });
  expect(r.engine).toBe('js');
  expect(r.fallbackReason).toContain('boom');
  expect([...r.names]).toEqual(['info']);
});

test("'native' without a binary is a clear error", () => {
  expect(() => scanProject({ sources: [project()], nameSet: NAMES, scanner: 'native', loadNative: () => null })).toThrow(
    "[rn-material-symbols] scanner: 'native' was requested but rn-material-symbols-scanner-native is not installed for this platform",
  );
});

test("'native' rethrows a native failure instead of falling back", () => {
  expect(() =>
    scanProject({
      sources: [project()],
      nameSet: NAMES,
      scanner: 'native',
      loadNative: fakeNative(() => {
        throw new Error('boom');
      }),
    }),
  ).toThrow('boom');
});

test("'js' never touches native", () => {
  const load = jest.fn();
  const r = scanProject({ sources: [project()], nameSet: NAMES, scanner: 'js', loadNative: load });
  expect(load).not.toHaveBeenCalled();
  expect(r.engine).toBe('js');
});

test('a missing source is a clear error even in auto mode, with no JS retry', () => {
  expect(() => scanProject({ sources: ['/nonexistent/rnms-src'], nameSet: NAMES, scanner: 'auto', loadNative: fakeNative(() => ({})) })).toThrow(
    "source not found: /nonexistent/rnms-src (check the 'sources' option)",
  );
});

test('native and JS use different cache files', () => {
  const dir = project();
  const cacheFile = path.join(dir, '.c', 'scan-cache.json');
  let seen = '';
  scanProject({
    sources: [dir],
    nameSet: NAMES,
    cacheFile,
    scanner: 'auto',
    loadNative: fakeNative((o) => {
      seen = o.cacheFile;
      return { names: [], byFile: {}, files: 0, unparsed: [], ms: 0 };
    }),
  });
  expect(seen).toBe(path.join(dir, '.c', 'scan-cache.native.json'));
});

test('versionMismatch compares major.minor only', () => {
  expect(versionMismatch('0.1.5', '0.1.0')).toBeUndefined();
  expect(versionMismatch('0.2.0', '0.1.0')).toMatch(/0\.2\.0.*0\.1\.0/);
  expect(versionMismatch('1.0.0', '0.1.0')).toBeDefined();
});

test('scanProject surfaces a native/package version mismatch but still uses native', () => {
  const ok = () => ({ names: [], byFile: {}, files: 0, unparsed: [], ms: 0 });
  const r = scanProject({ sources: [project()], nameSet: NAMES, expectedNativeVersion: '0.1.0', loadNative: fakeNative(ok, '0.2.0') });
  expect(r.engine).toBe('native');
  expect(r.nativeVersionWarning).toMatch(/0\.2\.0/);
  const same = scanProject({ sources: [project()], nameSet: NAMES, expectedNativeVersion: '0.2.3', loadNative: fakeNative(ok, '0.2.0') });
  expect(same.nativeVersionWarning).toBeUndefined();
});

const napiMissing = () => {
  const e: any = new Error('Cannot find native binding. npm has a bug');
  const leaf: any = new Error("Cannot find module './scanner.darwin-arm64.node'");
  const mid: any = new Error("Cannot find module 'rn-material-symbols-scanner-native-darwin-arm64'");
  mid.cause = leaf;
  e.cause = mid;
  return e;
};
const napiDlopen = () => {
  const e: any = new Error('Cannot find native binding. npm has a bug');
  const leaf: any = new Error('dlopen(/x/scanner.node): code signature invalid');
  e.cause = leaf;
  return e;
};
const pkgMissing = () => Object.assign(new Error("Cannot find module 'rn-material-symbols-scanner-native'\nRequire stack:"), { code: 'MODULE_NOT_FOUND' });
const throwing = (make: () => Error) => () => {
  throw make();
};

test('isNotAvailable classifies load errors', () => {
  expect(isNotAvailable(pkgMissing())).toBe(true);
  expect(isNotAvailable(napiMissing())).toBe(true);
  expect(isNotAvailable(napiDlopen())).toBe(false);
  expect(isNotAvailable(new Error('boom'))).toBe(false);
});

test('auto: package missing or no platform binary is quiet JS', () => {
  for (const make of [pkgMissing, napiMissing]) {
    const r = scanProject({ sources: [project()], nameSet: NAMES, scanner: 'auto', loadNative: throwing(make) });
    expect(r.engine).toBe('js');
    expect(r.fallbackReason).toBeUndefined();
  }
});

test('auto: an installed but unloadable binary falls back to JS and says why', () => {
  const r = scanProject({ sources: [project()], nameSet: NAMES, scanner: 'auto', loadNative: throwing(napiDlopen) });
  expect(r.engine).toBe('js');
  expect(r.fallbackReason).toContain('failed to load');
  expect(r.fallbackReason).toContain('code signature invalid');
});

test("'native': not-available keeps the required prefix; a broken install reports the cause", () => {
  const prefix = "[rn-material-symbols] scanner: 'native' was requested but rn-material-symbols-scanner-native is not installed for this platform";
  expect(() => scanProject({ sources: [project()], nameSet: NAMES, scanner: 'native', loadNative: throwing(napiMissing) })).toThrow(prefix);
  expect(() => scanProject({ sources: [project()], nameSet: NAMES, scanner: 'native', loadNative: throwing(napiDlopen) })).toThrow(
    /failed to load: .*code signature invalid/,
  );
});

test('when native fails and the JS retry also throws, the native reason is in the message', () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, 'b.ts'), "export const b = 'info';");
  const spy = jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
    throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' });
  });
  try {
    expect(() =>
      scanProject({
        sources: [dir],
        nameSet: NAMES,
        scanner: 'auto',
        loadNative: fakeNative(() => {
          throw new Error('boom');
        }),
      }),
    ).toThrow(/EACCES: denied \(native scanner also failed: boom\)/);
  } finally {
    spy.mockRestore();
  }
});

// The real napi loader chain (7 entries) reproduced from a truncated real .node: the dlopen reason is the 5th entry.
const realChain = () => {
  const reasons = [
    "Cannot find module 'rn-material-symbols-scanner-native-wasm32-wasi'",
    "Cannot find module './scanner.wasi.cjs'",
    "Cannot find module 'rn-material-symbols-scanner-native-darwin-arm64'",
    'dlopen(/x/scanner.darwin-arm64.node, 0x0001): tried: file too short',
    "Cannot find module 'rn-material-symbols-scanner-native-darwin-universal'",
    "Cannot find module './scanner.darwin-universal.node'",
  ];
  // linked list as built by createLoadErrorChain: each entry's cause is the previous one
  const chain = reasons.reduce<any>((prev, m) => Object.assign(new Error(m), { cause: prev ?? undefined }), null);
  return Object.assign(new Error('Cannot find native binding. npm has a bug'), { cause: chain });
};

test('describeLoadError surfaces the buried dlopen reason from the real 7-entry chain', () => {
  const e = realChain();
  expect(isNotAvailable(e)).toBe(false);
  const d = describeLoadError(e);
  expect(d).toContain('file too short');
  expect(d).not.toContain('wasm32-wasi');
  expect(d.length).toBeLessThanOrEqual(600);
});

test('describeLoadError lists the missing candidates when nothing else explains the failure, capped by characters', () => {
  expect(describeLoadError(napiMissing())).toContain('scanner.darwin-arm64.node');
  expect(describeLoadError(new Error('x'.repeat(5000))).length).toBeLessThanOrEqual(600);
});

test('classification is strict: a missing non-candidate module is not "not available"', () => {
  const e = Object.assign(new Error('Cannot find native binding. npm has a bug'), {
    cause: Object.assign(new Error("Cannot find module 'some-runtime-dep'"), { cause: undefined }),
  });
  expect(isNotAvailable(e)).toBe(false);
  const arrayShape = Object.assign(new Error('Cannot find native binding. x'), { cause: [new Error("Cannot find module './scanner.a.node'")] });
  expect(isNotAvailable(arrayShape)).toBe(false);
  const unsupported = Object.assign(new Error('Cannot find native binding. x'), { cause: new Error('Unsupported OS: aix, architecture: ppc64') });
  expect(isNotAvailable(unsupported)).toBe(true);
});

test('scanner failure that is not an Error is wrapped when JS also fails', () => {
  const spy = jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
    throw 'string-failure';
  });
  try {
    expect(() =>
      scanProject({
        sources: [project()],
        nameSet: NAMES,
        loadNative: fakeNative(() => {
          throw 'native-string';
        }),
      }),
    ).toThrow(/string-failure \(native scanner also failed: native-string\)/);
  } finally {
    spy.mockRestore();
  }
});

// Real corrupted binary: copy the napi loader + a truncated .node into a temp dir and feed the genuine error through the classifier.
const nativeDir = path.resolve(__dirname, '../../native');
const realNode = `scanner.${process.platform}-${process.arch}.node`;
(process.platform === 'darwin' && fs.existsSync(path.join(nativeDir, realNode)) ? test : test.skip)(
  'a truncated real .node is classified as broken, with the dlopen reason in the description',
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnms-corrupt-'));
    // The napi loader loads this path first when set; it must not bypass the truncated binary.
    const prevLibraryPath = process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
    delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
    try {
      for (const f of ['index.js', 'package.json']) fs.copyFileSync(path.join(nativeDir, f), path.join(dir, f));
      fs.writeFileSync(path.join(dir, realNode), fs.readFileSync(path.join(nativeDir, realNode)).subarray(0, 64));
      // The loader falls back to the platform package by name. If that resolves from a temp dir, the
      // test would load the real binary instead of the truncated one.
      const platformPackage = `rn-material-symbols-scanner-native-${realNode.slice('scanner.'.length, -'.node'.length)}`;
      let leaked: string | undefined;
      try {
        leaked = require.resolve(platformPackage, { paths: [dir] });
      } catch {}
      if (leaked) {
        throw new Error(`${platformPackage} resolves from a temp dir (${leaked}); reinstall node_modules so pnpm's hoistPattern in pnpm-workspace.yaml applies`);
      }
      let error: unknown;
      try {
        jest.isolateModules(() => {
          require(dir);
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      expect(isNotAvailable(error)).toBe(false);
      // macOS dyld rejecting the truncated file, e.g. "dlopen(<dir>/scanner.darwin-arm64.node, 0x0001): tried: '<dir>/…'
      // (load commands length (2376) exceeds length of file (64))" — the reason text varies by dyld version.
      expect(describeLoadError(error)).toMatch(/dlopen\([^)]*\/scanner\.darwin-[a-z0-9]+\.node, 0x[0-9a-f]+\): tried: '[^']*\/scanner\.darwin-[a-z0-9]+\.node' \(/);
    } finally {
      if (prevLibraryPath === undefined) delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
      else process.env.NAPI_RS_NATIVE_LIBRARY_PATH = prevLibraryPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
