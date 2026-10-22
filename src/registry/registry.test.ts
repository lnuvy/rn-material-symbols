import path from 'node:path';

const stub = require('./stub');
const all = require('./all');

test('stub registry is empty and says so', () => {
  expect(stub).toEqual({ mode: 'stub', icons: {}, aliases: {} });
});

test('all registry lazily loads both shapes of any icon by name', () => {
  expect(all.mode).toBe('all');
  expect(all.icons.rounded.close.d).toContain('q-11 11-28 11');
  expect(all.icons.outlined.close).toBeDefined();
  expect(all.icons.rounded.not_an_icon_name).toBeUndefined();
  expect(all.icons.rounded['../../package']).toBeUndefined();
  expect(all.icons.rounded.constructor).toBeUndefined();
  // FILL 1 differs for info; for an icon without a separate FILL 1 path, f is the same string as d
  expect(all.icons.rounded.info.f).not.toBe(all.icons.rounded.info.d);
  const same = Object.entries(require(path.join(__dirname, '..', '..', 'icons', 'rounded.json'))).find(([, v]) => !(v as { f?: string }).f)?.[0] as string;
  expect(all.icons.rounded[same].f).toBe(all.icons.rounded[same].d);
  expect(all.aliases.access_time).toBe(require(path.join(__dirname, '..', '..', 'data', 'aliases.json')).access_time);
});
