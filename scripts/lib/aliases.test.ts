import { buildAliases, type IconData, type Variant } from './aliases';

const v = (rounded: Record<string, IconData>, outlined = rounded, sharp = rounded): Record<Variant, Record<string, IconData>> => ({ rounded, outlined, sharp });

test('aliases a legacy name when its paths equal a symbol in every variant', () => {
  const symbols = v({ schedule: { d: 'S' }, zzz: { d: 'Z' } });
  const legacy = v({ access_time: { d: 'S' } });
  expect(buildAliases(symbols, legacy)).toEqual({ aliases: { access_time: 'schedule' }, standalone: v({}) });
});

test('keeps a legacy icon standalone when any variant differs', () => {
  const symbols = v({ schedule: { d: 'S' } }, { schedule: { d: 'S2' } });
  const legacy = v({ access_time: { d: 'S' } }, { access_time: { d: 'OTHER' } });
  expect(buildAliases(symbols, legacy)).toEqual({
    aliases: {},
    standalone: v({ access_time: { d: 'S' } }, { access_time: { d: 'OTHER' } }, { access_time: { d: 'S' } }),
  });
});

test('compares the filled path too and picks the alphabetically first twin', () => {
  const symbols = v({ b_twin: { d: 'X', f: 'XF' }, a_twin: { d: 'X', f: 'XF' }, c: { d: 'X' } });
  const legacy = v({ old: { d: 'X', f: 'XF' } });
  expect(buildAliases(symbols, legacy).aliases).toEqual({ old: 'a_twin' });
});

test('skips legacy names that already exist as symbols', () => {
  const symbols = v({ home: { d: 'H' } });
  const legacy = v({ home: { d: 'H' } });
  expect(buildAliases(symbols, legacy)).toEqual({ aliases: {}, standalone: v({}) });
});
