import { extractLiterals } from './extractLiterals';

const lits = (code: string, file = 'a.tsx') => [...extractLiterals(code, file).literals].sort();

test('JSX attributes, expression containers and ternaries', () => {
  expect(lits(`<MaterialIcon name='info' /> ; <X name={'close'} /> ; <Y name={on ? 'check' : 'remove'} />`)).toEqual(['check', 'close', 'info', 'remove']);
});

test('object configs and arrays (dynamic names come from here)', () => {
  expect(lits(`export const MENU = [{ iconName: 'home' }, { iconName: "settings" }];`, 'menu.ts')).toEqual(['home', 'settings']);
});

test('skips type aliases, interfaces, annotations and literal types', () => {
  const code = `
    type Name = 'home' | 'search';
    interface P { icon: 'close'; }
    function f(n: 'check'): 'done' { return x; }
    const g = (n: Array<'apps'>) => n;
    let h: { a: 'menu' };
    class C implements I<'star'> {}
  `;
  expect(lits(code, 'types.ts')).toEqual([]);
});

test('keeps values inside as / satisfies / enums / object keys', () => {
  const code = `
    const a = 'info' as Name;
    const b = { x: 'close' } satisfies Cfg;
    enum E { A = 'home' }
    const m = { 'search': 1 };
    const t = ['check', 'remove'] as const;
  `;
  expect(lits(code, 'v.ts')).toEqual(['check', 'close', 'home', 'info', 'remove', 'search']);
});

test('template literals without expressions only', () => {
  expect(lits('const a = `info`; const b = `${x}_filled`;', 'tpl.ts')).toEqual(['info']);
});

test('ignores import/export specifiers, directives and non-icon-shaped strings', () => {
  const code = `'use strict'; import x from 'react'; export * from 'home'; const a = 'Home'; const b = 'arrow-back'; const c = 'two words';`;
  expect(lits(code, 'i.js')).toEqual([]);
});

test('.d.ts files contribute nothing', () => {
  expect(extractLiterals(`declare const a: 'home'; export const b = 'info';`, 'x.d.ts')).toEqual({ literals: new Set(), parsed: true });
});

test('syntax error falls back to regex and reports parsed=false', () => {
  const result = extractLiterals(`const a = 'info'; <div name='close' `, 'broken.tsx');
  expect(result.parsed).toBe(false);
  expect([...result.literals].sort()).toEqual(['close', 'info']);
});

test('.ts files parse generics without jsx ambiguity', () => {
  expect(lits(`const f = <T,>(x: T) => x; const a = f('home');`, 'g.ts')).toEqual(['home']);
});

test('namespace bodies keep value literals', () => {
  expect(lits(`namespace N { export const a = 'home' }`, 'ns.ts')).toEqual(['home']);
});

test('pins value positions next to type annotations', () => {
  expect(lits(`function f(n: Name = 'home') {}`, 'p1.ts')).toEqual(['home']);
  expect(lits(`class C { x: Name = 'close' }`, 'p2.ts')).toEqual(['close']);
  expect(lits(`const a: Name = 'info'`, 'p3.ts')).toEqual(['info']);
  expect(lits(`useState<Name>('check')`, 'p4.tsx')).toEqual(['check']);
  expect(lits(`<Foo<Name> name='star' />`, 'p5.tsx')).toEqual(['star']);
});

test('.d.mts and .d.cts files contribute nothing', () => {
  expect(extractLiterals(`export const b = 'info';`, 'x.d.mts').literals.size).toBe(0);
  expect(extractLiterals(`export const b = 'info';`, 'x.d.cts').literals.size).toBe(0);
});

test('template literal expressions are walked', () => {
  expect(lits('const a = `${open ? \'expand_less\' : \'expand_more\'}`;', 'tpl.ts')).toEqual(['expand_less', 'expand_more']);
  expect(lits('<MaterialIcon name={`${x ? \'home\' : \'info\'}`} />')).toEqual(['home', 'info']);
  expect(lits('const b = `${base}_filled`;', 'tpl.ts')).toEqual([]);
});
