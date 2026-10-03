import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render } from '@testing-library/react-native';
import * as React from 'react';
import { MaterialIcon } from './MaterialIcon';

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

  test('filled uses f, and falls back to d when f is absent', () => {
    expect(pathOf(<MaterialIcon name="info" filled />).props.d).toBe('INFO1');
    expect(pathOf(<MaterialIcon name="check" filled />).props.d).toBe('CHECK0');
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

  test('missing icon renders an empty Svg of the same size and warns once', () => {
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
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect((console.warn as jest.Mock).mock.calls[0][0]).toContain("include: ['home']");
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
