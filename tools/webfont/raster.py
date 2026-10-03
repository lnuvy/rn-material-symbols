"""Tiny nonzero-winding rasterizer for single-path icons (M L H V Q T C Z, abs/rel)."""
import re
import numpy as np

N = 96
_TOKEN = re.compile(r'[MmLlHhVvQqTtCcZz]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?')


def polygons(d):
    ts = _TOKEN.findall(d)
    i = 0
    cmd = None
    x = y = sx = sy = 0.0
    cx = cy = None
    out, cur = [], []

    def num():
        nonlocal i
        v = float(ts[i])
        i += 1
        return v

    def quad(x0, y0, qx, qy, x1, y1):
        for t in np.linspace(0, 1, 9)[1:]:
            cur.append(((1 - t) ** 2 * x0 + 2 * (1 - t) * t * qx + t * t * x1,
                        (1 - t) ** 2 * y0 + 2 * (1 - t) * t * qy + t * t * y1))

    def cubic(x0, y0, ax, ay, bx, by, x1, y1):
        for t in np.linspace(0, 1, 13)[1:]:
            u = 1 - t
            cur.append((u ** 3 * x0 + 3 * u * u * t * ax + 3 * u * t * t * bx + t ** 3 * x1,
                        u ** 3 * y0 + 3 * u * u * t * ay + 3 * u * t * t * by + t ** 3 * y1))

    while i < len(ts):
        if re.match(r'[A-Za-z]', ts[i]):
            cmd = ts[i]
            i += 1
        if cmd in ('Z', 'z'):
            if cur:
                out.append(cur)
                cur = []
            x, y = sx, sy
            cx = None
            continue
        rel = cmd.islower()
        c = cmd.upper()
        ox, oy = (x, y) if rel else (0.0, 0.0)
        if c == 'M':
            if cur:
                out.append(cur)
            x, y = ox + num(), oy + num()
            sx, sy = x, y
            cur = [(x, y)]
            cmd = 'l' if rel else 'L'
            cx = None
        elif c == 'L':
            x, y = ox + num(), oy + num()
            cur.append((x, y))
            cx = None
        elif c == 'H':
            x = (x if rel else 0.0) + num()
            cur.append((x, y))
            cx = None
        elif c == 'V':
            y = (y if rel else 0.0) + num()
            cur.append((x, y))
            cx = None
        elif c == 'Q':
            qx, qy = ox + num(), oy + num()
            nx, ny = ox + num(), oy + num()
            quad(x, y, qx, qy, nx, ny)
            cx, cy = qx, qy
            x, y = nx, ny
        elif c == 'T':
            qx, qy = (2 * x - cx, 2 * y - cy) if cx is not None else (x, y)
            nx, ny = ox + num(), oy + num()
            quad(x, y, qx, qy, nx, ny)
            cx, cy = qx, qy
            x, y = nx, ny
        elif c == 'C':
            ax, ay = ox + num(), oy + num()
            bx, by = ox + num(), oy + num()
            nx, ny = ox + num(), oy + num()
            cubic(x, y, ax, ay, bx, by, nx, ny)
            cx = None
            x, y = nx, ny
        else:
            raise ValueError(f'unsupported command {cmd}')
    if cur:
        out.append(cur)
    return out


def raster(d, view_box=(0, -960, 960, 960), flip_y=False, scale=1.0):
    """Rasterize path d sampled over view_box. flip_y: path is in y-up font units."""
    vx, vy, vw, vh = view_box
    px = (np.arange(N) + .5) / N * vw + vx
    py = (np.arange(N) + .5) / N * vh + vy
    X, Y = np.meshgrid(px, py)
    X = X.ravel()
    Y = Y.ravel()
    if flip_y:
        Y = -Y
    w = np.zeros(X.shape, dtype=np.int32)
    for p in polygons(d):
        a = np.array(p + [p[0]]) * scale
        x0, y0, x1, y1 = a[:-1, 0], a[:-1, 1], a[1:, 0], a[1:, 1]
        up = (y0[None, :] <= Y[:, None]) & (y1[None, :] > Y[:, None])
        dn = (y1[None, :] <= Y[:, None]) & (y0[None, :] > Y[:, None])
        cross = (x1 - x0)[None, :] * (Y[:, None] - y0[None, :]) - (X[:, None] - x0[None, :]) * (y1 - y0)[None, :]
        w += (up & (cross > 0)).sum(1) - (dn & (cross < 0)).sum(1)
    return w != 0


def diff_pct(a, b):
    return float((a ^ b).sum()) / a.size * 100
