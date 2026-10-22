/**
 * Snaps a normalized path (viewBox 0 -960 960 960; commands M L H V Q T Z, absolute or relative) to integer
 * coordinates and re-encodes it with relative commands, implicit repeats and minimal separators.
 *
 * Points are snapped in absolute space, so rounding never accumulates along a path. The largest shift of a point
 * is 0.5 unit for explicit points; a T command's implied control point is the reflection of the previous snapped one
 * and can move up to 2 units. One unit is 1/40 px at 24 px. Over all rounded paths this shortens the text by about
 * 14% and its gzip size by about 22% (docs/poc and scripts/lib/quantize.test.ts).
 */

const TOKEN = /[MmLlHhVvQqTtZz]|-?(?:\d+\.?\d*|\.\d+)/g;
const ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, Q: 4, T: 2, Z: 0 };

export interface Segment {
  cmd: 'M' | 'L' | 'H' | 'V' | 'Q' | 'T' | 'Z';
  /** absolute values: x,y pairs; H holds x, V holds y */
  pts: number[];
}

/** Absolute segments with implicit repeats expanded. Repeated pairs after M become L, as in SVG. */
export function parsePath(d: string): Segment[] {
  const tokens = d.match(TOKEN) ?? [];
  const out: Segment[] = [];
  let cmd = '';
  let i = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z]$/.test(t)) {
      cmd = t;
      i += 1;
      if (cmd === 'Z' || cmd === 'z') {
        out.push({ cmd: 'Z', pts: [] });
        cx = sx;
        cy = sy;
        continue;
      }
    }
    if (!cmd || cmd === 'Z' || cmd === 'z') throw new Error(`number without command at token ${i}`);
    const up = cmd.toUpperCase() as Segment['cmd'];
    const rel = cmd !== up;
    const n = ARITY[up];
    const vals = tokens.slice(i, i + n).map(Number);
    if (vals.length < n || vals.some((v) => Number.isNaN(v))) throw new Error(`incomplete ${cmd} at token ${i}`);
    i += n;
    let pts: number[];
    if (up === 'H') {
      cx = vals[0] + (rel ? cx : 0);
      pts = [cx];
    } else if (up === 'V') {
      cy = vals[0] + (rel ? cy : 0);
      pts = [cy];
    } else {
      pts = [];
      for (let k = 0; k < n; k += 2) pts.push(vals[k] + (rel ? cx : 0), vals[k + 1] + (rel ? cy : 0));
      cx = pts[pts.length - 2];
      cy = pts[pts.length - 1];
    }
    out.push({ cmd: up, pts });
    if (up === 'M') {
      sx = cx;
      sy = cy;
      cmd = rel ? 'l' : 'L';
    }
  }
  return out;
}

function num(v: number): string {
  return v === 0 ? '0' : String(v);
}

/** Integer-grid re-encoding. `grid` is units per 960 (960 keeps the viewBox and only drops fractions). */
export function quantizePath(d: string, grid = 960): string {
  const scale = grid / 960;
  const segs = parsePath(d).map((s) => ({ cmd: s.cmd, pts: s.pts.map((p) => Math.round(p * scale)) }));
  let out = '';
  let last = '';
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  segs.forEach((seg, index) => {
    if (seg.cmd === 'Z') {
      out += 'z';
      last = 'z';
      cx = sx;
      cy = sy;
      return;
    }
    let letter: string;
    let nums: number[];
    const p = seg.pts;
    if (seg.cmd === 'M') {
      letter = index === 0 ? 'M' : 'm';
      nums = index === 0 ? [p[0], p[1]] : [p[0] - cx, p[1] - cy];
      cx = p[0];
      cy = p[1];
      sx = cx;
      sy = cy;
    } else if (seg.cmd === 'H') {
      letter = 'h';
      nums = [p[0] - cx];
      cx = p[0];
    } else if (seg.cmd === 'V') {
      letter = 'v';
      nums = [p[0] - cy];
      cy = p[0];
    } else {
      letter = seg.cmd.toLowerCase();
      nums = [];
      for (let k = 0; k < p.length; k += 2) nums.push(p[k] - cx, p[k + 1] - cy);
      cx = p[p.length - 2];
      cy = p[p.length - 1];
    }
    // A repeated command letter can be omitted, except M/m whose repeats would read as l.
    let piece = letter === last && letter !== 'M' && letter !== 'm' ? '' : letter;
    let prev = piece === '' ? out.slice(-1) : piece;
    for (const n of nums) {
      let s = num(n);
      if (!s.startsWith('-') && /\d/.test(prev)) s = ` ${s}`;
      piece += s;
      prev = s.slice(-1);
    }
    out += piece;
    last = letter;
  });
  return out;
}

/** Absolute end and control points (T reflections resolved), for displacement checks in tests and the build. */
export function pathPoints(d: string): Array<[number, number]> {
  const res: Array<[number, number]> = [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let qx: number | null = null;
  let qy: number | null = null;
  for (const { cmd, pts } of parsePath(d)) {
    if (cmd === 'Q') {
      res.push([pts[0], pts[1]], [pts[2], pts[3]]);
      [qx, qy, cx, cy] = pts;
    } else if (cmd === 'T') {
      const rx: number = qx === null ? cx : 2 * cx - qx;
      const ry: number = qy === null ? cy : 2 * cy - (qy as number);
      res.push([rx, ry], [pts[0], pts[1]]);
      qx = rx;
      qy = ry;
      cx = pts[0];
      cy = pts[1];
    } else {
      if (cmd === 'H') cx = pts[0];
      else if (cmd === 'V') cy = pts[0];
      else if (cmd === 'Z') [cx, cy] = [sx, sy];
      else [cx, cy] = pts;
      if (cmd === 'M') [sx, sy] = [cx, cy];
      if (cmd !== 'Z') res.push([cx, cy]);
      qx = null;
      qy = null;
    }
  }
  return res;
}

/** Largest coordinate difference between two paths with the same command structure, in viewBox units. */
export function maxShift(a: string, b: string): number {
  const pa = pathPoints(a);
  const pb = pathPoints(b);
  if (pa.length !== pb.length) throw new Error(`point count differs: ${pa.length} vs ${pb.length}`);
  let worst = 0;
  for (let i = 0; i < pa.length; i += 1) worst = Math.max(worst, Math.abs(pa[i][0] - pb[i][0]), Math.abs(pa[i][1] - pb[i][1]));
  return worst;
}
