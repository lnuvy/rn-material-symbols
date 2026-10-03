import { assertWithinViewBox, normalizePath, parseSymbolSvg } from './svg';

describe('parseSymbolSvg', () => {
  test('reads d and viewBox', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 -960 960 960" width="24"><path d="M480-438Z"/></svg>';
    expect(parseSymbolSvg(svg, 't')).toEqual({ d: 'M480-438Z', viewBox: [0, -960, 960, 960] });
  });

  test('falls back to width/height when viewBox is missing (legacy 24x24 files)', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" height="24" width="24"><path d="M6.4 19Z"/></svg>';
    expect(parseSymbolSvg(svg, 't').viewBox).toEqual([0, 0, 24, 24]);
  });

  test('rejects more than one path', () => {
    const svg = '<svg viewBox="0 -960 960 960"><path d="M0 0Z"/><path d="M1 1Z"/></svg>';
    expect(() => parseSymbolSvg(svg, 'x/y')).toThrow('x/y: expected 1 <path>, got 2');
  });

  test('rejects unexpected elements and path attributes', () => {
    expect(() => parseSymbolSvg('<svg viewBox="0 -960 960 960"><g><path d="M0 0Z"/></g></svg>', 'g')).toThrow('g: unexpected elements g');
    expect(() => parseSymbolSvg('<svg viewBox="0 -960 960 960"><path fill-rule="evenodd" d="M0 0Z"/></svg>', 'fr')).toThrow('fr: unexpected path attributes fill-rule');
  });
});

describe('normalizePath', () => {
  test('returns already-normalized paths byte-identical', () => {
    const d = 'M480-438 270-228q-9 9-21 9t-21-9Z';
    expect(normalizePath(d, [0, -960, 960, 960])).toBe(d);
  });

  test('scales 24x24 coordinates and shifts absolute y by -960', () => {
    expect(normalizePath('M1 2H3V4h1v1q1 1 2 2T5 5Z', [0, 0, 24, 24])).toBe('M40 -880H120V-800h40v40q40 40 80 80T200 -760Z');
  });

  test('handles the legacy "0 96 960 960" viewBox', () => {
    expect(normalizePath('M160 896q-33 0-56.5-23.5Z', [0, 96, 960, 960])).toBe('M160 -160q-33 0 -56.5 -23.5Z');
  });

  test('keeps implicit repeated pairs after M', () => {
    expect(normalizePath('M0 0 24 24', [0, 0, 24, 24])).toBe('M0 -960 960 0');
  });

  test('rounds to 2 decimals and never prints -0', () => {
    expect(normalizePath('M0.0001 24h-0.0001', [0, 0, 24, 24])).toBe('M0 0h0');
  });

  test('rejects unsupported commands and non-square viewBoxes', () => {
    expect(() => normalizePath('M0 0C1 1 2 2 3 3', [0, 0, 24, 24])).toThrow('unsupported command C');
    expect(() => normalizePath('M0 0Z', [0, 0, 24, 20])).toThrow('non-square viewBox 24x20');
  });
});

describe('leading m', () => {
  test('treats a leading m as absolute', () => {
    expect(normalizePath('m1 2h3', [0, 0, 24, 24])).toBe('M40 -880h120');
  });

  test('keeps implicit pairs after a leading m relative', () => {
    expect(normalizePath('m1 2 3 4', [0, 0, 24, 24])).toBe('M40 -880l120 160');
  });

  test('returns an already-normalized path starting with m byte-identical', () => {
    const d = 'm480-438 270-228q-9 9-21 9Z';
    expect(normalizePath(d, [0, -960, 960, 960])).toBe(d);
  });
});

describe('assertWithinViewBox', () => {
  test('accepts in-bounds absolute and relative paths', () => {
    expect(() => assertWithinViewBox('M480-438 270-228q-11 11-28 11t-28-11H100V-900Z', 'ok')).not.toThrow();
  });

  test('rejects an off-canvas path', () => {
    expect(() => assertWithinViewBox('M40 100h10', 'bad')).toThrow('bad: path leaves the viewBox (40,100)');
  });

  test('rejects an out-of-bounds control point', () => {
    expect(() => assertWithinViewBox('M0-500q2000 0 10 10', 'ctl')).toThrow('ctl: path leaves the viewBox');
  });
});
