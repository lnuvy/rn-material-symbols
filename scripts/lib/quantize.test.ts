import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { maxShift, parsePath, pathPoints, quantizePath } from './quantize';

test('relative and absolute forms parse to the same absolute points', () => {
  expect(pathPoints('M10 20l5 5h3v-2q1 1 2 2t4 0z')).toEqual(pathPoints('M10 20L15 25H18V23Q19 24 20 25T24 25Z'));
});

test('implicit repeats after M become L, and H/V after z start from the subpath start', () => {
  expect(parsePath('m10 10 5 5').map((s) => s.cmd)).toEqual(['M', 'L']);
  expect(pathPoints('M10 10h5zh2')).toEqual([[10, 10], [15, 10], [12, 10]]);
});

test('quantizePath drops fractions and keeps the structure', () => {
  const d = 'M480-280q17 0 28.5-11.5T520-320q0-17-11.5-28.5T480-360z';
  const q = quantizePath(d);
  expect(q).not.toMatch(/\./);
  expect(parsePath(q).map((s) => s.cmd)).toEqual(parsePath(d).map((s) => s.cmd));
  expect(maxShift(d, q)).toBeLessThanOrEqual(2);
  expect(quantizePath(q)).toBe(q); // idempotent
});

test('separators: a space only between two non-negative numbers', () => {
  expect(quantizePath('M10 20L15 25L5 30')).toBe('M10 20l5 5-10 5');
  expect(quantizePath('M0 0H10V10H0Z')).toBe('M0 0h10v10h-10z');
});

test('every rounded icon quantizes within 2 units (0.05 px at 24 px) and the set shrinks', () => {
  const data = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'data', 'rounded.json'), 'utf8')) as Record<string, { d: string; f?: string }>;
  const before: string[] = [];
  const after: string[] = [];
  let worst = 0;
  for (const icon of Object.values(data)) {
    for (const d of icon.f === undefined ? [icon.d] : [icon.d, icon.f]) {
      const q = quantizePath(d);
      worst = Math.max(worst, maxShift(d, q));
      before.push(d);
      after.push(q);
    }
  }
  expect(worst).toBeLessThanOrEqual(2);
  const chars = after.join('\n').length / before.join('\n').length;
  const gz = gzipSync(after.join('\n'), { level: 9 }).length / gzipSync(before.join('\n'), { level: 9 }).length;
  expect(chars).toBeLessThan(0.9);
  expect(gz).toBeLessThan(0.8);
});
