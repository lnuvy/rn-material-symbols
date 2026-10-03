export type ViewBox = [number, number, number, number];

export interface ParsedSymbolSvg {
  d: string;
  viewBox: ViewBox;
}

export function parseSymbolSvg(svg: string, label: string): ParsedSymbolSvg {
  const tags = [...svg.matchAll(/<([a-zA-Z][\w:-]*)/g)].map((m) => m[1]);
  const unexpected = [...new Set(tags.filter((t) => t !== 'svg' && t !== 'path'))];
  if (unexpected.length > 0) throw new Error(`${label}: unexpected elements ${unexpected.join(',')}`);

  const paths = [...svg.matchAll(/<path\b([^>]*?)\/?>/g)];
  if (paths.length !== 1) throw new Error(`${label}: expected 1 <path>, got ${paths.length}`);

  const attrs = paths[0][1];
  const extra = [...attrs.matchAll(/([a-zA-Z:-]+)=/g)].map((m) => m[1]).filter((a) => a !== 'd');
  if (extra.length > 0) throw new Error(`${label}: unexpected path attributes ${extra.join(',')}`);

  const d = /(?:^|\s)d="([^"]+)"/.exec(attrs)?.[1];
  if (!d) throw new Error(`${label}: <path> has no d`);

  const vb = /viewBox="([^"]+)"/.exec(svg)?.[1];
  let viewBox: number[];
  if (vb) {
    viewBox = vb.trim().split(/[\s,]+/).map(Number);
  } else {
    const w = Number(/\swidth="([\d.]+)"/.exec(svg)?.[1]);
    const h = Number(/\sheight="([\d.]+)"/.exec(svg)?.[1]);
    viewBox = [0, 0, w, h];
  }
  if (viewBox.length !== 4 || viewBox.some((n) => !Number.isFinite(n))) throw new Error(`${label}: invalid viewBox`);
  return { d, viewBox: viewBox as ViewBox };
}

const TOKEN = /[MmLlHhVvQqTtZz]|[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
const ARITY: Record<string, number> = { M: 2, L: 2, T: 2, H: 1, V: 1, Q: 4, Z: 0 };

function fmt(v: number): string {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) || r === 0 ? '0' : String(r);
}

export function normalizePath(d: string, [vx, vy, vw, vh]: ViewBox): string {
  if (vw !== vh) throw new Error(`non-square viewBox ${vw}x${vh}`);
  if (vx === 0 && vy === -960 && vw === 960) return d;

  const k = 960 / vw;
  const tokens = d.match(TOKEN) ?? [];
  let out = '';
  let cmd = '';
  let i = 0;
  let leadingM = false; // first command written as `m`: absolute for its first pair, `l` after
  let afterLeadingM = false;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z]$/.test(t)) {
      cmd = t;
      i += 1;
      if (!(cmd.toUpperCase() in ARITY)) throw new Error(`unsupported command ${cmd}`);
      leadingM = out === '' && cmd === 'm';
      afterLeadingM = false;
      out += leadingM ? 'M' : cmd;
      if (cmd === 'Z' || cmd === 'z') continue;
    } else {
      if (!cmd || cmd === 'Z' || cmd === 'z') throw new Error(`number without command at token ${i}`);
      if (afterLeadingM) {
        cmd = 'l';
        afterLeadingM = false;
        out += 'l';
      } else {
        out += ' ';
      }
    }
    const c = cmd.toUpperCase();
    const n = ARITY[c];
    const nums = tokens.slice(i, i + n).map(Number);
    if (nums.length < n || nums.some((v) => Number.isNaN(v))) throw new Error(`incomplete ${cmd} at token ${i}`);
    i += n;
    const rel = cmd !== c && !leadingM;
    const mapped = nums.map((v, j) => {
      if (rel) return v * k;
      const axis = c === 'H' ? 'x' : c === 'V' ? 'y' : j % 2 === 0 ? 'x' : 'y';
      return axis === 'x' ? (v - vx) * k : (v - vy) * k - 960;
    });
    out += mapped.map(fmt).join(' ');
    if (leadingM) {
      leadingM = false;
      afterLeadingM = true;
    }
  }
  return out;
}

const MIN_X = -48;
const MAX_X = 1008;
const MIN_Y = -1008;
const MAX_Y = 48;

/** Throws if any endpoint or control point of a normalized path leaves the viewBox (5% pad). */
export function assertWithinViewBox(d: string, label: string): void {
  const tokens = d.match(TOKEN) ?? [];
  let cmd = '';
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let i = 0;
  const check = (px: number, py: number) => {
    if (px < MIN_X || px > MAX_X || py < MIN_Y || py > MAX_Y) throw new Error(`${label}: path leaves the viewBox (${px},${py})`);
  };
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) {
      cmd = tokens[i];
      i += 1;
      if (cmd === 'Z' || cmd === 'z') {
        x = sx;
        y = sy;
        continue;
      }
    }
    const c = cmd.toUpperCase();
    const n = ARITY[c];
    if (n === undefined || n === 0) throw new Error(`${label}: bad command ${cmd}`);
    const nums = tokens.slice(i, i + n).map(Number);
    if (nums.length < n || nums.some((v) => Number.isNaN(v))) throw new Error(`${label}: incomplete ${cmd}`);
    i += n;
    const rel = cmd !== c;
    const bx = rel ? x : 0;
    const by = rel ? y : 0;
    if (c === 'H') {
      x = nums[0] + bx;
      check(x, y);
    } else if (c === 'V') {
      y = nums[0] + by;
      check(x, y);
    } else {
      for (let j = 0; j < n; j += 2) {
        check(nums[j] + bx, nums[j + 1] + by);
      }
      x = nums[n - 2] + bx;
      y = nums[n - 1] + by;
      if (c === 'M') {
        sx = x;
        sy = y;
        cmd = rel ? 'l' : 'L';
      }
    }
  }
}
