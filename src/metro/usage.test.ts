import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadNative } from './nativeScanner';
import { summarizeFile } from './usage';
import { withMaterialSymbols } from './withMaterialSymbols';

// JS engine only (the native binary is exercised by the parity suite)
jest.mock('./nativeScanner', () => ({ ...jest.requireActual('./nativeScanner'), loadNative: jest.fn() }));
const loadNativeMock = loadNative as jest.MockedFunction<typeof loadNative>;
beforeEach(() => {
  loadNativeMock.mockReset();
  loadNativeMock.mockReturnValue(null);
});

const createdTempDirs: string[] = [];
afterAll(() => {
  for (const dir of createdTempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const IMPORT = "import { MaterialIcon } from 'rn-material-symbols';\n";

function project(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rnms-usage-'));
  createdTempDirs.push(root);
  for (const [rel, code] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), code);
  }
  return root;
}

type Reg = { icons: Record<string, Record<string, { d?: string; f?: string }>>; aliases: Record<string, string> };

/** runs the plugin in usage mode and returns { variant: { name: 'd' | 'f' | 'df' } } plus log lines */
function collect(files: Record<string, string>, options: Record<string, unknown> = {}) {
  const root = project(files);
  const lines: string[] = [];
  withMaterialSymbols({ projectRoot: root }, { watch: false, log: (l: string) => lines.push(l), ...options });
  const code = fs.readFileSync(path.join(root, 'node_modules', '.cache', 'rn-material-symbols', 'registry.js'), 'utf8');
  const mod = { exports: {} as Reg };
  new Function('module', code)(mod);
  const shapes: Record<string, Record<string, string>> = {};
  for (const [variant, icons] of Object.entries(mod.exports.icons)) {
    shapes[variant] = {};
    for (const [name, icon] of Object.entries(icons)) shapes[variant][name] = `${icon.d ? 'd' : ''}${icon.f ? 'f' : ''}`;
  }
  return { shapes, aliases: mod.exports.aliases, lines, log: lines.join('\n') };
}

test('only rendered names, in the shapes rendered; unrelated strings are not icons', () => {
  const { shapes } = collect({
    'App.tsx': `${IMPORT}
      log('home'); const k = { returnKeyType: 'search' };
      export const A = () => <>
        <MaterialIcon name="info" />
        <MaterialIcon name="star" filled />
        <MaterialIcon name="check" filled={false} />
        <MaterialIcon name="bolt" filled={on} />
      </>;`,
  });
  expect(shapes).toEqual({ rounded: { bolt: 'df', check: 'd', info: 'd', star: 'f' } });
});

test('conditionals, logical operators, templates and in-file constants', () => {
  const { shapes } = collect({
    'App.tsx': `${IMPORT}
      const OPEN = 'expand_less' as const;
      export function A({ open }: { open: boolean }) {
        const fallback = open ? 'close' : 'menu';
        return <>
          <MaterialIcon name={open ? OPEN : 'expand_more'} />
          <MaterialIcon name={\`\${open ? 'add' : 'remove'}\`} />
          <MaterialIcon name={x ?? fallback} />
        </>;
      }`,
  });
  // x is undeclared: that use falls back to the file's icon-shaped strings (and says so)
  expect(Object.keys(shapes.rounded)).toEqual(expect.arrayContaining(['expand_less', 'expand_more', 'add', 'remove', 'close', 'menu']));
});

test('object and array maps, in this file and imported, with dynamic keys', () => {
  const { shapes, log } = collect({
    'tabs.ts': "export const TABS = [{ key: 'a', icon: 'settings' }, { key: 'b', icon: 'person' }];\nexport const UNUSED = ['delete'];",
    'filters.ts': "export const FILTER_ICON = { fast: 'electric_bolt', near: 'near_me' } as const;",
    'App.tsx': `${IMPORT}
      import { TABS } from './tabs';
      import { FILTER_ICON } from './filters';
      const LOCAL = { a: 'bookmark', b: 'share' };
      export const A = ({ k, i }: { k: 'a' | 'b'; i: number }) => <>
        <MaterialIcon name={TABS[0].icon} />
        <MaterialIcon name={LOCAL[k]} />
        <MaterialIcon name={FILTER_ICON[k as keyof typeof FILTER_ICON]} filled />
      </>;`,
  });
  expect(shapes.rounded).toEqual({ bookmark: 'd', electric_bolt: 'f', near_me: 'f', settings: 'd', share: 'd' });
  expect(log).not.toContain('could not be resolved');
});

test('import alias, namespace import, local re-binding and createElement', () => {
  const { shapes } = collect({
    'App.tsx': `
      import { MaterialIcon as Icon } from 'rn-material-symbols';
      import * as RMS from 'rn-material-symbols';
      import React from 'react';
      const Glyph = Icon;
      export const A = () => <>
        <Icon name="info" />
        <RMS.MaterialIcon name="home" />
        <Glyph name="star" filled />
        {React.createElement(Icon, { name: 'bolt' })}
      </>;`,
  });
  expect(shapes.rounded).toEqual({ bolt: 'd', home: 'd', info: 'd', star: 'f' });
});

test('wrappers: props mapped to name and filled, defaults, spread, chains, and memo', () => {
  const { shapes, log } = collect({
    'ui/AppIcon.tsx': `${IMPORT}
      export function AppIcon({ icon, active = false }: { icon: string; active?: boolean }) {
        return <MaterialIcon name={icon as never} filled={active} size={20} />;
      }`,
    'ui/Spread.tsx': `${IMPORT}
      import { memo } from 'react';
      export const SpreadIcon = memo((props: any) => <MaterialIcon size={16} {...props} />);`,
    'ui/TabIcon.tsx': `
      import { AppIcon } from './AppIcon';
      export const TabIcon = ({ tab }: { tab: string }) => <AppIcon icon={tab} active />;`,
    'Screen.tsx': `
      import { AppIcon } from './ui/AppIcon';
      import { SpreadIcon } from './ui/Spread';
      import { TabIcon } from './ui/TabIcon';
      const note = 'search';
      export const S = () => <>
        <AppIcon icon="home" active />
        <AppIcon icon="close" />
        <SpreadIcon name="star" filled={sel} />
        <TabIcon tab="person" />
      </>;`,
  });
  expect(shapes.rounded).toEqual({ close: 'd', home: 'f', person: 'f', star: 'df' });
  expect(log).not.toContain('search');
});

test('a barrel re-exporting MaterialIcon, and a default-exported wrapper', () => {
  const { shapes } = collect({
    'ui/index.ts': "export { MaterialIcon } from 'rn-material-symbols';\nexport { MaterialIcon as Icon } from 'rn-material-symbols';",
    'ui/Glyph.tsx': `${IMPORT}export default function Glyph({ name }: { name: string }) { return <MaterialIcon name={name as never} />; }`,
    'App.tsx': `
      import { MaterialIcon, Icon } from './ui';
      import G from './ui/Glyph';
      export const A = () => <><MaterialIcon name="info" /><Icon name="home" filled /><G name="bolt" /></>;`,
  });
  expect(shapes.rounded).toEqual({ bolt: 'd', home: 'f', info: 'd' });
});

test('variants and legacy aliases', () => {
  const { shapes, aliases } = collect({
    'App.tsx': `${IMPORT}export const A = () => <><MaterialIcon name="info" variant="outlined" /><MaterialIcon name="access_time" /></>;`,
  });
  expect(shapes).toEqual({ outlined: { info: 'd' }, rounded: { schedule: 'd' } });
  expect(aliases).toEqual({ access_time: 'schedule' });
});

test('unresolvable names include the strings of the file and its imports, and say so', () => {
  const { shapes, log } = collect({
    'icons.ts': "export function getIcon(t: string) { return t === 'a' ? 'alarm' : 'bolt'; }",
    'menu.ts': "export const MENU = [{ icon: 'settings' }, { icon: 'logout' }];",
    'far.ts': "export const NOT_IMPORTED = 'delete';",
    'App.tsx': `${IMPORT}
      import { getIcon } from './icons';
      import { MENU } from './menu';
      export const A = ({ t }: { t: string }) => <>
        <MaterialIcon name={getIcon(t)} />
        {MENU.map((item) => <MaterialIcon key={item.icon} name={item.icon} />)}
      </>;`,
  });
  expect(Object.keys(shapes.rounded).sort()).toEqual(['alarm', 'bolt', 'logout', 'settings']);
  expect(log).toContain('App.tsx:6: name could not be resolved (the result of a function call');
  expect(log).toContain("App.tsx:7: name could not be resolved ('item' is a parameter of a function that is not a component");
  expect(log).toContain('· 2 uses · 2 files included conservatively ·');
  expect(log).not.toContain("'delete'");
});

test('MaterialIcon passed as a value, and a wrapper with no traced call sites, are reported', () => {
  const { log } = collect({
    'ui/Unused.tsx': `${IMPORT}export const Unused = ({ n }: { n: string }) => <MaterialIcon name={n as never} />;`,
    'App.tsx': `${IMPORT}export const A = () => <Button icon={MaterialIcon} label="home" />;`,
  });
  expect(log).toContain('MaterialIcon is used as a value here');
  expect(log).toContain('icon wrapper (Unused) has no call sites that could be traced');
});

test("collect: 'literals' keeps the 0.2 behavior", () => {
  const { shapes } = collect({ 'App.tsx': `${IMPORT}log('home'); export const A = () => <MaterialIcon name="info" />;` }, { collect: 'literals' });
  expect(shapes.rounded).toEqual({ home: 'df', info: 'df' });
});

test('summaries survive a JSON round trip (they are cached on disk)', () => {
  const s = summarizeFile(`${IMPORT}export const W = ({ icon }: any) => <MaterialIcon name={icon} />;`, '/x/W.tsx');
  const copy = JSON.parse(JSON.stringify(s));
  expect(copy).toEqual(s);
  expect(copy.sites[0].inWrapper).toBeDefined();
});

test('a file that does not parse falls back to its strings with a diagnostic', () => {
  const { shapes, log } = collect({ 'Broken.tsx': `${IMPORT}export const A = () => <MaterialIcon name="info" ;; 'home'` });
  expect(Object.keys(shapes.rounded).sort()).toEqual(['home', 'info']);
  expect(log).toContain('could not parse this file');
});

test('a rescan picks up an edit: new name, new shape, and a wrapper call site in an untouched file (cached summaries)', () => {
  const root = project({
    'ui/AppIcon.tsx': `${IMPORT}export function AppIcon({ icon }: { icon: string }) { return <MaterialIcon name={icon as never} />; }`,
    'App.tsx': `${IMPORT}export const A = () => <MaterialIcon name="info" />;`,
    'Other.tsx': "import { AppIcon } from './ui/AppIcon';\nexport const O = () => <AppIcon icon=\"home\" />;",
  });
  let rescan: () => void = () => {};
  withMaterialSymbols({ projectRoot: root }, {
    watch: true,
    log: () => {},
    startWatcher: (_roots: string[], onChange: () => void) => {
      rescan = onChange;
      return () => {};
    },
  });
  const registry = path.join(root, 'node_modules', '.cache', 'rn-material-symbols', 'registry.js');
  const shapesNow = () => {
    const mod = { exports: {} as Reg };
    new Function('module', fs.readFileSync(registry, 'utf8'))(mod);
    return Object.fromEntries(Object.entries(mod.exports.icons.rounded).map(([n, i]) => [n, `${i.d ? 'd' : ''}${i.f ? 'f' : ''}`]));
  };
  expect(shapesNow()).toEqual({ home: 'd', info: 'd' });
  // a later mtime than the cached one, even on coarse-mtime filesystems
  const touch = (rel: string, code: string) => {
    fs.writeFileSync(path.join(root, rel), code);
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(root, rel), t, t);
  };
  touch('App.tsx', `${IMPORT}export const A = () => <><MaterialIcon name="info" filled /><MaterialIcon name="star" /></>;`);
  rescan();
  expect(shapesNow()).toEqual({ home: 'd', info: 'f', star: 'd' });
  expect(fs.existsSync(path.join(root, 'node_modules', '.cache', 'rn-material-symbols', 'usage-cache.json'))).toBe(true);
  require('./withMaterialSymbols').__stopAllWatchers();
});
