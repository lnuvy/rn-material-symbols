import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractLiterals as jsExtract } from '../../src/metro/extractLiterals';
import type { NativeBinding } from '../../src/metro/nativeScanner';
import { scanProject } from '../../src/metro/scanProject';
import { loadNative } from './loadNative';

const native = loadNative<NativeBinding>();
const d = native ? describe : describe.skip;

/** Flow (oxc rejects it, Babel parses it) plus an escaped `home` that the regex fallback cannot decode. */
const FLOW_ESCAPED = 'type Icon = {| name: string |}; const a = "info"; const b = "ho\\u006de";';

const CASES: Array<[string, string]> = [
  ["<MaterialIcon name='info' /> ; <X name={'close'} /> ; <Y name={on ? 'check' : 'remove'} />", 'a.tsx'],
  ["export const MENU = [{ iconName: 'home' }, { iconName: \"settings\" }];", 'menu.ts'],
  ["type Name = 'home' | 'search';\ninterface P { icon: 'close'; }\nfunction f(n: 'check'): 'done' { return x; }\nconst g = (n: Array<'apps'>) => n;\nlet h: { a: 'menu' };\nclass C implements I<'star'> {}", 'types.ts'],
  ["const a = 'info' as Name;\nconst b = { x: 'close' } satisfies Cfg;\nenum E { A = 'home' }\nconst m = { 'search': 1 };\nconst t = ['check', 'remove'] as const;", 'v.ts'],
  ["namespace N { export const a = 'home' }", 'ns.ts'],
  ["function f(n: Name = 'home') {}", 'a.ts'],
  ["class C { x: Name = 'close' }", 'a.ts'],
  ["const a: Name = 'info'", 'a.ts'],
  ["useState<Name>('check')", 'a.tsx'],
  ["<Foo<Name> name='star' />", 'a.tsx'],
  ['const a = `info`; const b = `${x}_filled`;', 'tpl.ts'],
  ["const a = `${open ? 'expand_less' : 'expand_more'}`", 't.ts'],
  ["'use strict'; import x from 'react'; export * from 'home'; const a = 'Home'; const b = 'arrow-back'; const c = 'two words';", 'i.js'],
  ["declare const a: 'home'; export const b = 'info';", 'x.d.ts'],
  ["const a = 'info'; <div name='close' ", 'broken.tsx'],
  ["const f = <T,>(x: T) => x; const a = f('home');", 'g.ts'],
  ["export { a as 'home' } from './x'; declare function g(n: 'close'): void; declare module 'info' {}", 'm.ts'],
  ["enum E { 'home' = 1, B = 'search' }", 'e.ts'],
  // JSX attribute strings: Babel decodes XHTML entities, oxc keeps the raw text (the extractor decodes like Babel)
  ['const marker = "info"; const icon = <MaterialIcon name="ho&#109;e" />;', 'a.tsx'],
  ['const marker = "info"; const icon = <MaterialIcon name="ho&#109;e" />;', 'a.jsx'],
  ['const icon = <I name="ho&#109;e" />;', 'a.js'],
  ['<I a="ho&#x6d;e" b="ho&#x6D;e" c="ho&#000109;e" d="arrow&#95;back" e=\'&#109;enu\' x:f="&#115;earch" />', 'a.tsx'],
  ['<I a="ho&#X6d;e" b="ho&#109e" c="&#;home" d="&#x;" e="&#1_09;" f="&#x6g;" />', 'a.tsx'],
  ['<I a="home&amp;" b="x&lt;" c="&nbsp;info" d="&quot;" e="&amp;" f="home" />', 'a.tsx'],
  ['<I a="ho&foo;me" b="&foo;" c="&amp" d="home&" e="&abcdefghijk;" f="&__proto__;" g="&constructor;" h="info" />', 'a.tsx'],
  ['<I a="x&" b="home;" c="&a&#109;" />', 'a.tsx'],
  ['<I a="&#x10FFFF;" b="&#xD800;" c="&#0;" d="home" />', 'a.tsx'],
  ['<I a="&#x110000;" b="home" />', 'a.tsx'],
  ['<I a="&#99999999;" b="home" />', 'a.tsx'],
  ['<I name={"ho&#109;e"}>ho&#109;e</I>; const a = "info"', 'a.tsx'],
  ['<I a="ho\nme" b="ho\r\nme" c="ho\\u006de" d="info" />', 'a.tsx'],
  // escapes Babel and oxc both cook: strings, templates, keys, export names, attributes
  ['const a = "ho\\u{6d}e"; const b = "ho\\x6de"; const c = \'ho\\u006de\'; const d = "\\h\\o\\m\\e"', 'a.ts'],
  ['const a = "se\\\narch"; const b = "inf\\\r\no"; const c = "home\\0"; const d = "close\u2028"', 'a.ts'],
  ['const a = `ho\\u006de`; const b = `se\\x61rch`; const c = `inf\\\no`; const d = `x\r\ny`; const e = `info\r\n`', 'a.ts'],
  ['const a = tag`\\unicode`; const b = tag`ho\\u006de`; const c = "info"', 'a.ts'],
  ['const o = { "ho\\u006de": 1 }; export { o as "se\\u0061rch" }; enum E { \'inf\\u006f\' = 1 }', 'a.ts'],
  ['export { a } from "x" with { type: "ho\\u006de" }; declare module \'cl\\u006fse\' {}', 'a.ts'],
  ['"ho\\u006de"; const b = "info"', 'a.js'],
  ['const a = "ho\\155e"', 'a.ts'],
];

function listRepoSources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'target') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listRepoSources(full, out);
    else if (/\.(?:[cm]?[jt]sx?)$/.test(e.name)) out.push(full);
  }
  return out;
}

d('native extractLiterals matches JS', () => {
  test.each(CASES)('%s (%s)', (code, file) => {
    const js = jsExtract(code, file);
    const rs = native!.extractLiterals(code, file);
    expect({ literals: rs.literals, parsed: rs.parsed }).toEqual({ literals: [...js.literals].sort(), parsed: js.parsed });
  });

  test('every source file in this repo', () => {
    const root = path.join(__dirname, '..', '..');
    const files = ['src', 'scripts', 'test', 'e2e', 'example/App.tsx', 'example/src']
      .map((p) => path.join(root, p))
      .filter((p) => fs.existsSync(p))
      .flatMap((p) => (fs.statSync(p).isFile() ? [p] : listRepoSources(p)));
    const diffs: string[] = [];
    let totalJsLiterals = 0;
    for (const f of files) {
      const code = fs.readFileSync(f, 'utf8');
      const js = jsExtract(code, f);
      const rs = native!.extractLiterals(code, f);
      totalJsLiterals += js.literals.size;
      const a = JSON.stringify([...js.literals].sort());
      const b = JSON.stringify(rs.literals);
      if (a !== b || js.parsed !== rs.parsed) diffs.push(`${path.relative(root, f)}: js=${a}/${js.parsed} rs=${b}/${rs.parsed}`);
    }
    expect(diffs).toEqual([]);
    expect(totalJsLiterals).toBeGreaterThan(0);
    expect(files.length).toBeGreaterThan(30);
  });

  // Accepted, known differences between the engines (ledger rulings). Each is pinned to the CURRENT behavior of
  // both engines so a drift in either direction fails. `rsMissing` lists names JS collects that the Rust extractor
  // does not. That happens in two ways only: Rust fell back to the regex (unparsed → the scan level makes up for it,
  // scanProject re-extracts those files with the JS extractor — see the scan-level test below), or JS fell back to the
  // regex on a file Rust parses and picked up a type-position string (`typeOnly`, never a runtime icon).
  //  - Flow syntax in .js: JS parses, Rust falls back to the regex (over-inclusive: also collects type positions;
  //    blind to escaped names such as "ho\u006de").
  //  - Bracket nesting 301..~750: Rust falls back to regex first (same literals here).
  //  - Rust parses where JS falls back: `override` without superclass, TS `export { Undeclared }`, enum computed template key.
  //    JS's regex fallback then also collects type-position strings that Rust skips (`typeOnly`).
  //  - Rust falls back where JS parses: .tsx `<T>(z)=>z`, `<!--` comments.
  describe('accepted known differences', () => {
    type Want = { js: string[]; jsParsed: boolean; rs: string[]; rsParsed: boolean; rsMissing?: string[]; typeOnly?: { names: string[]; babelAccepts: string } };
    // `typeOnly`: names JS collects only because Babel rejected the file and the regex fallback read a type position.
    // Rust parses the file and (correctly) skips them. `babelAccepts` is the same file minus the Babel-rejected
    // construct: there the JS extractor parses and must NOT collect those names — proof they sit in type positions.
    const KNOWN: Array<[string, string, string, Want]> = [
      ['flow .js', "// @flow\ntype T = 'close'; const a: T = 'home'; function f(x: 'info') {}", 'f.js', { js: ['home'], jsParsed: true, rs: ['close', 'home', 'info'], rsParsed: false }],
      [
        'flow .js with an escaped name',
        FLOW_ESCAPED,
        'a.js',
        { js: ['home', 'info'], jsParsed: true, rs: ['info'], rsParsed: false, rsMissing: ['home'] },
      ],
      ['bracket nesting 301', 'const a = ' + '['.repeat(301) + "'home'" + ']'.repeat(301), 'deep.ts', { js: ['home'], jsParsed: true, rs: ['home'], rsParsed: false }],
      ['override without superclass', "class C { override m() {} }; const a='home'", 'o.ts', { js: ['home'], jsParsed: false, rs: ['home'], rsParsed: true }],
      ['export { Undeclared }', "export { Undeclared }; const a='home'", 'u.ts', { js: ['home'], jsParsed: false, rs: ['home'], rsParsed: true }],
      [
        'override + type-position literal',
        "class C { override m(x: 'home') {} }; const a='info'",
        'ot.ts',
        { js: ['home', 'info'], jsParsed: false, rs: ['info'], rsParsed: true, rsMissing: ['home'], typeOnly: { names: ['home'], babelAccepts: "class C { m(x: 'home') {} }; const a='info'" } },
      ],
      [
        'export { Undeclared } + type-position literal',
        "export { Undeclared }; type T = 'close'; const a='info'",
        'ut.ts',
        { js: ['close', 'info'], jsParsed: false, rs: ['info'], rsParsed: true, rsMissing: ['close'], typeOnly: { names: ['close'], babelAccepts: "type T = 'close'; const a='info'" } },
      ],
      ['enum computed template key', 'enum E { [`home`] = 1 }', 'en.ts', { js: ['home'], jsParsed: false, rs: ['home'], rsParsed: true }],
      ['tsx <T>(z)=>z', "const x = <T>(z: T) => z; const a='home'", 'g.tsx', { js: ['home'], jsParsed: true, rs: ['home'], rsParsed: false }],
      ['html comment <!--', "const a='home'; <!-- c\n const b='info'", 'h.tsx', { js: ['home', 'info'], jsParsed: true, rs: ['home', 'info'], rsParsed: false }],
    ];
    test.each(KNOWN)('%s', (_name, code, file, want) => {
      const js = jsExtract(code, file);
      const rs = native!.extractLiterals(code, file);
      const rsMissing = [...js.literals].filter((n) => !rs.literals.includes(n)).sort();
      expect({ js: [...js.literals].sort(), jsParsed: js.parsed, rs: rs.literals, rsParsed: rs.parsed, rsMissing }).toEqual({
        js: want.js,
        jsParsed: want.jsParsed,
        rs: want.rs,
        rsParsed: want.rsParsed,
        rsMissing: want.rsMissing ?? [],
      });
      // A name Rust lacks is either recovered at the scan level (Rust fell back to the regex → unparsed → JS
      // re-extraction) or a type-position string JS only collected through its own regex fallback.
      if (rsMissing.length > 0 && rs.parsed) {
        expect(want.typeOnly?.names).toEqual(rsMissing);
        const accepted = jsExtract(want.typeOnly!.babelAccepts, file);
        expect(accepted.parsed).toBe(true);
        expect([...accepted.literals].filter((n) => rsMissing.includes(n))).toEqual([]);
        expect(native!.extractLiterals(want.typeOnly!.babelAccepts, file).literals).toEqual([...accepted.literals].sort());
      }
    });

    test('scan level: every known difference file finds at least the JS value-position names', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnms-known-'));
      try {
        KNOWN.forEach(([, code, file], i) => {
          fs.mkdirSync(path.join(dir, String(i)));
          fs.writeFileSync(path.join(dir, String(i), file), code);
        });
        const nameSet = new Set(['home', 'info', 'close']);
        for (const cacheFile of [undefined, path.join(dir, '.c', 'cache.json'), path.join(dir, '.c', 'cache.json')]) {
          const js = scanProject({ sources: [dir], nameSet, scanner: 'js' });
          const rs = scanProject({ sources: [dir], nameSet, scanner: 'native', cacheFile, loadNative: () => native });
          const typeOnly = new Map(KNOWN.map(([, , file, want], i) => [path.join(dir, String(i), file), want.typeOnly?.names ?? []]));
          for (const [file, names] of js.byFile) {
            for (const n of names) {
              const has = rs.byFile.get(file)?.includes(n) ?? false;
              expect({ file, n, has: has || typeOnly.get(file)!.includes(n) }).toEqual({ file, n, has: true });
            }
          }
          const valueNames = [...js.byFile].flatMap(([file, names]) => names.filter((n) => !typeOnly.get(file)!.includes(n)));
          expect([...rs.names].sort()).toEqual(expect.arrayContaining(valueNames));
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

// native/src/entities.rs embeds a copy of @babel/parser's JSX entity table; fail if the installed Babel's table drifts.
// Runs without the binary (it reads both sources).
test('native JSX entity table matches @babel/parser', () => {
  const babelSrc = fs.readFileSync(require.resolve('@babel/parser'), 'utf8');
  const start = babelSrc.indexOf('const entities = {');
  expect(start).toBeGreaterThan(0);
  const literal = babelSrc.slice(start + 'const entities = '.length, babelSrc.indexOf('};', start) + 1);
  const babel = new Function(`return ${literal}`)() as Record<string, string>;
  const rustSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'native', 'src', 'entities.rs'), 'utf8');
  const rust: Record<string, string> = {};
  for (const m of rustSrc.matchAll(/^ {4}\("(\w+)", '\\u\{([0-9A-F]+)\}'\),$/gm)) rust[m[1]] = String.fromCodePoint(parseInt(m[2], 16));
  expect(Object.keys(rust).length).toBe(253);
  expect(rust).toEqual({ ...babel });
});
