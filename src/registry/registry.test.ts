import path from 'node:path';

const stub = require('./stub');
const all = require('./all');

test('stub registry is empty and says so', () => {
  expect(stub).toEqual({ mode: 'stub', icons: {}, aliases: {} });
});

test('all registry lazily loads icon modules by name', () => {
  expect(all.mode).toBe('all');
  expect(all.icons.rounded.close.d).toContain('q-11 11-28 11');
  expect(all.icons.outlined.close).toBeDefined();
  expect(all.icons.rounded.not_an_icon_name).toBeUndefined();
  expect(all.icons.rounded['../../package']).toBeUndefined();
  expect(all.aliases.access_time).toBe(require(path.join(__dirname, '..', '..', 'data', 'aliases.json')).access_time);
});
