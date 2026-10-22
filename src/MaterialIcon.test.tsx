import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render } from '@testing-library/react-native';
import * as React from 'react';
import { MaterialIcon, MISSING_ICON_WARN_DELAY_MS, resolveIcon } from './MaterialIcon';

const fixture = require('rn-material-symbols/registry');

const svgOf = (ui: React.ReactElement) => render(ui).UNSAFE_root.findByType('Svg' as never);
const pathOf = (ui: React.ReactElement) => render(ui).UNSAFE_root.findByType('Path' as never);

/** Counts every `generated/names` reference vs. those inside an `import type` / `export type` statement. */
function namesReferenceCounts(source: string) {
  const total = source.match(/generated\/names/g)?.length ?? 0;
  const typeOnly = source.match(/^\s*(?:import|export)\s+type\s[^;]*generated\/names/gm)?.length ?? 0;
  return { total, typeOnly };
}

describe('MaterialIcon', () => {
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  test('draws the unfilled path with defaults', () => {
    const svg = svgOf(<MaterialIcon name="info" />);
    expect(svg.props).toMatchObject({ width: 24, height: 24, viewBox: '0 -960 960 960' });
    expect(pathOf(<MaterialIcon name="info" />).props).toMatchObject({ d: 'INFO0', fill: 'black' });
  });

  test('filled uses f; an icon bundled without the requested shape renders empty and reports it', () => {
    jest.useFakeTimers();
    try {
      expect(pathOf(<MaterialIcon name="info" filled />).props.d).toBe('INFO1');
      // the fixture has `check` in its unfilled shape only, as the generated registry does for unfilled-only uses
      const view = render(<MaterialIcon name="check" filled />);
      expect(view.UNSAFE_root.findAllByType('Path' as never)).toHaveLength(0);
      jest.advanceTimersByTime(MISSING_ICON_WARN_DELAY_MS);
      expect((console.warn as jest.Mock).mock.calls[0][0]).toContain("'check' (rounded) is bundled without its filled shape");
      // the unfilled shape still renders
      expect(pathOf(<MaterialIcon name="check" />).props.d).toBe('CHECK0');
    } finally {
      jest.useRealTimers();
    }
  });

  test('size and color', () => {
    expect(svgOf(<MaterialIcon name="info" size={16} />).props).toMatchObject({ width: 16, height: 16 });
    expect(pathOf(<MaterialIcon name="info" color="#1C7ED6" />).props.fill).toBe('#1C7ED6');
  });

  test('rotate becomes a transform placed before the user style', () => {
    const style = { opacity: 0.5 };
    expect(svgOf(<MaterialIcon name="info" rotate={90} style={style} />).props.style).toEqual([{ transform: [{ rotate: '90deg' }] }, style]);
    expect(svgOf(<MaterialIcon name="info" style={style} />).props.style).toBe(style);
  });

  test('passes other SvgProps through', () => {
    expect(svgOf(<MaterialIcon name="info" testID="icon" />).props.testID).toBe('icon');
  });

  test('resolves aliases', () => {
    expect(pathOf(<MaterialIcon name={'info_outline' as never} />).props.d).toBe('INFO0');
  });

  describe('missing icon', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('renders an empty Svg of the same size and warns once, after the delay', () => {
      const view = render(
        <>
          <MaterialIcon name="home" size={20} />
          <MaterialIcon name="home" size={20} />
        </>,
      );
      const svgs = view.UNSAFE_root.findAllByType('Svg' as never);
      expect(svgs).toHaveLength(2);
      expect(svgs[0].props).toMatchObject({ width: 20, height: 20 });
      expect(view.UNSAFE_root.findAllByType('Path' as never)).toHaveLength(0);
      expect(console.warn).not.toHaveBeenCalled();
      jest.advanceTimersByTime(MISSING_ICON_WARN_DELAY_MS);
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect((console.warn as jest.Mock).mock.calls[0][0]).toContain("include: ['home']");
      // re-renders and later timers never warn again for the same name
      view.rerender(<MaterialIcon name="home" size={24} />);
      jest.runAllTimers();
      expect(console.warn).toHaveBeenCalledTimes(1);
    });

    test('does not warn when the registry gains the icon before the delay ends (HMR registry update)', () => {
      render(<MaterialIcon name="star" />);
      fixture.icons.rounded.star = { d: 'STAR0' };
      try {
        jest.advanceTimersByTime(MISSING_ICON_WARN_DELAY_MS);
        expect(console.warn).not.toHaveBeenCalled();
        expect(pathOf(<MaterialIcon name="star" />).props.d).toBe('STAR0');
      } finally {
        delete fixture.icons.rounded.star;
      }
      // a later genuine miss of the same name still warns
      render(<MaterialIcon name="star" />);
      jest.advanceTimersByTime(MISSING_ICON_WARN_DELAY_MS);
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect((console.warn as jest.Mock).mock.calls[0][0]).toContain("include: ['star']");
    });

    test('checks the registry module as it is at warning time, not the object captured at import', () => {
      const replaced = { ...fixture, icons: { rounded: { ...fixture.icons.rounded, bolt: { d: 'BOLT0' } } } };
      render(<MaterialIcon name="bolt" />);
      const mod = require.cache?.[require.resolve('rn-material-symbols/registry')];
      expect(mod).toBeDefined();
      const original = mod!.exports;
      mod!.exports = replaced;
      try {
        jest.advanceTimersByTime(MISSING_ICON_WARN_DELAY_MS);
        expect(console.warn).not.toHaveBeenCalled();
      } finally {
        mod!.exports = original;
      }
    });
  });

  describe('never throws (worst case: an empty icon and a console message)', () => {
    const odd: unknown[] = [undefined, null, 123, {}, [], 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', ''];

    test('resolveIcon returns undefined for malformed registries and odd names or variants', () => {
      const regs: unknown[] = [undefined, null, {}, { icons: {} }, { aliases: {} }, { icons: null, aliases: null }, 'x', { icons: { rounded: { home: 'not-an-object' } }, aliases: {} }];
      for (const reg of regs) expect(() => resolveIcon(reg as never, 'rounded', 'home')).not.toThrow();
      for (const reg of regs) expect(resolveIcon(reg as never, 'rounded', 'home')).toBeUndefined();
      for (const name of odd) expect(resolveIcon(fixture, 'rounded', name as never)).toBeUndefined();
      for (const variant of odd) expect(resolveIcon(fixture, variant as never, 'info')).toBeUndefined();
      // an alias entry that is not a string is ignored rather than used as a key
      expect(resolveIcon({ ...fixture, aliases: { info: 42 } } as never, 'rounded', 'info')?.d).toBe('INFO0');
    });

    test('odd names and variants render an empty Svg without throwing', () => {
      jest.useFakeTimers();
      try {
        for (const value of odd) {
          expect(() => render(<MaterialIcon name={value as never} />)).not.toThrow();
          expect(() => render(<MaterialIcon name="info" variant={value as never} />)).not.toThrow();
          expect(render(<MaterialIcon name={value as never} />).UNSAFE_root.findAllByType('Path' as never)).toHaveLength(0);
        }
        expect(() => jest.runAllTimers()).not.toThrow();
      } finally {
        jest.useRealTimers();
      }
    });

    test('a throwing console does not break rendering', () => {
      jest.useFakeTimers();
      (console.warn as jest.Mock).mockImplementation(() => {
        throw new Error('console broke');
      });
      try {
        expect(() => render(<MaterialIcon name={'console_throws' as never} />)).not.toThrow();
        expect(() => jest.runAllTimers()).not.toThrow();
      } finally {
        jest.useRealTimers();
      }
    });

    test('release builds log console.error once per name, immediately', () => {
      const g = globalThis as { __DEV__?: boolean };
      const dev = g.__DEV__;
      const error = jest.spyOn(console, 'error').mockImplementation(() => {});
      g.__DEV__ = false;
      try {
        render(
          <>
            <MaterialIcon name={'release_miss' as never} />
            <MaterialIcon name={'release_miss' as never} />
          </>,
        );
        expect(error).toHaveBeenCalledTimes(1);
        expect(error.mock.calls[0][0]).toContain("[rn-material-symbols] 'release_miss' (rounded)");
        expect(console.warn).not.toHaveBeenCalled();
      } finally {
        g.__DEV__ = dev;
      }
    });
  });

  test('runtime sources never value-import the generated names list (keeps the 3,927-name list out of app bundles)', () => {
    for (const file of ['MaterialIcon.tsx', 'types.ts', 'messages.ts', 'constants.ts', 'index.ts']) {
      const source = readFileSync(path.join(__dirname, file), 'utf8');
      const { total, typeOnly } = namesReferenceCounts(source);
      expect({ file, typeOnly }).toEqual({ file, typeOnly: total });
    }
  });

  test('the type-only guard rejects every value-level reference form', () => {
    const bad = [
      "import { type X, VALUE } from './generated/names';",
      "const n = require('./generated/names');",
      "export { V } from './generated/names';",
      "const n = import('./generated/names');",
      "import X from './generated/names';",
    ];
    for (const sample of bad) {
      const { total, typeOnly } = namesReferenceCounts(sample);
      expect(total).toBe(1);
      expect(typeOnly).toBe(0);
    }
    const good = [
      "import type { A } from './generated/names';",
      "export type {\n  A,\n  B,\n} from './generated/names';",
    ];
    for (const sample of good) {
      const { total, typeOnly } = namesReferenceCounts(sample);
      expect(total).toBe(1);
      expect(typeOnly).toBe(1);
    }
  });
});
