#!/usr/bin/env python3
"""Render CDN fill1 vs font fill1 for one icon side by side (CDN | font | XOR) as PNG (stdlib only)."""
import struct, sys, zlib
from pathlib import Path
import numpy as np
from fontTools.ttLib import TTFont
sys.path.insert(0, str(Path(__file__).parent))
import verify_webfont as v
from raster import raster, N

name = sys.argv[1] if len(sys.argv) > 1 else 'lab_profile'
font = TTFont(v.CACHE / 'web-font.woff2')
g = v.ligature_resolver(font)(name)
d, vb = v.cdn_path('rounded', name, 'fill1')
a = raster(d, view_box=vb)
b = raster(v.glyph_path(font, g, 1), view_box=(0, -960, 960, 960), flip_y=True, scale=960 / font['head'].unitsPerEm)
a = a.reshape(N, N)
b = b.reshape(N, N)
x = a ^ b
S = 4
def img(m, rgb):
    out = np.full((N, N, 3), 255, np.uint8); out[m] = rgb
    return np.kron(out, np.ones((S, S, 1), np.uint8))
gap = np.full((N * S, 8, 3), 200, np.uint8)
rgb = np.concatenate([img(a, (0, 0, 0)), gap, img(b, (0, 0, 0)), gap, img(x, (220, 0, 0))], axis=1)
raw = b''.join(b'\0' + rgb[r].tobytes() for r in range(rgb.shape[0]))
def chunk(t, data): c = struct.pack('>I', len(data)) + t + data; return c + struct.pack('>I', zlib.crc32(t + data))
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', rgb.shape[1], rgb.shape[0], 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
out = v.CACHE / f'{name}.png'; out.write_bytes(png)
ys, xs = np.nonzero(x)
print(out, f'diff={x.sum()/x.size*100:.2f}%', f'cdn_px={a.sum()} font_px={b.sum()} font_only={(b&~a).sum()} cdn_only={(a&~b).sum()}',
      f'diff bbox cols {xs.min()}..{xs.max()} rows {ys.min()}..{ys.max()} of {N}')
for r in range(0, N, 3):
    print(''.join('#' if a[r, c] and b[r, c] else ('C' if a[r, c] else ('F' if b[r, c] else '.')) for c in range(0, N, 2)))
