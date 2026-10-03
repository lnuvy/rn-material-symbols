#!/usr/bin/env python3
"""Gate G1: compare a Material Symbols web font against Google Fonts CDN opsz-24 SVGs.

usage: python3 tools/webfont/verify_webfont.py FONT.woff2 [--names used.txt] [--style rounded]
"""
import argparse
import json
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

sys.path.insert(0, str(Path(__file__).parent))
from raster import diff_pct, raster  # noqa: E402

HERE = Path(__file__).parent
CACHE = HERE / '.cache'
METADATA_URL = 'https://fonts.google.com/metadata/icons?key=material_symbols&incomplete=1'
CDN = 'https://fonts.gstatic.com/s/i/short-term/release'


def http_get(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return r.read().decode()


def symbol_names():
    raw = http_get(METADATA_URL)
    data = json.loads(raw[raw.index('{'):])
    return sorted(i['name'] for i in data['icons']
                  if not any(f.startswith('Material Symbols') for f in i['unsupported_families']))


def cdn_path(style, name, axis):
    f = CACHE / f'{style}.{axis}.{name}.svg'
    if not f.exists():
        CACHE.mkdir(exist_ok=True)
        f.write_text(http_get(f'{CDN}/materialsymbols{style}/{name}/{axis}/24px.svg'))
    svg = f.read_text()
    m = re.search(r'viewBox="([^"]+)"', svg)
    vb = tuple(map(float, m.group(1).split())) if m else (0, 0, 24, 24)
    return re.search(r'\sd="([^"]+)"', svg).group(1), vb


def ligature_resolver(font):
    cmap = font.getBestCmap()
    ligs = {}
    for lookup in font['GSUB'].table.LookupList.Lookup:
        for st in lookup.SubTable:
            if lookup.LookupType == 7:
                st = st.ExtSubTable
            if not hasattr(st, 'ligatures'):
                continue
            for first, entries in st.ligatures.items():
                for lig in entries:
                    ligs[(first, *lig.Component)] = lig.LigGlyph

    def resolve(name):
        return ligs.get(tuple(cmap.get(ord(ch)) for ch in name))
    return resolve


def glyph_path(font, glyph, fill):
    location = {'FILL': fill} if 'fvar' in font and any(a.axisTag == 'FILL' for a in font['fvar'].axes) else None
    gs = font.getGlyphSet(location=location) if location else font.getGlyphSet()
    pen = SVGPathPen(gs)
    gs[glyph].draw(pen)
    return pen.getCommands()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('font')
    ap.add_argument('--names', help='only compare these names (one per line), e.g. names used in a private monorepo')
    ap.add_argument('--style', default='rounded', choices=['rounded', 'outlined', 'sharp'])
    args = ap.parse_args()

    font = TTFont(args.font)
    upem = font['head'].unitsPerEm
    axes = [(a.axisTag, a.minValue, a.defaultValue, a.maxValue) for a in font['fvar'].axes] if 'fvar' in font else []
    print(f'unitsPerEm={upem} axes={axes}')
    print('opsz axis present: ' + ('YES -> see design R-2' if any(a[0] == 'opsz' for a in axes) else 'no'))

    names = symbol_names()
    if args.names:
        wanted = set(Path(args.names).read_text().split())
        names = [n for n in names if n in wanted]
    resolve = ligature_resolver(font)

    # calibration: 'close' must match almost exactly, otherwise the coordinate mapping is wrong
    with ThreadPoolExecutor(32) as ex:
        list(ex.map(lambda n: [cdn_path(args.style, n, a) for a in ('default', 'fill1')], names))

    rows, unresolved = [], []
    scale = 960 / upem
    for name in names:
        glyph = resolve(name)
        if glyph is None:
            unresolved.append(name)
            continue
        for fill, axis in ((0, 'default'), (1, 'fill1')):
            d_cdn, vb = cdn_path(args.style, name, axis)
            a = raster(d_cdn, view_box=vb)
            b = raster(glyph_path(font, glyph, fill), view_box=(0, -960, 960, 960), flip_y=True, scale=scale)
            pct = diff_pct(a, b)
            rows.append((name, fill, pct, 'DIFF' if pct >= 0.5 else 'ok'))

    calib = [r for r in rows if r[0] == 'close' and r[1] == 0]
    if calib and calib[0][2] >= 0.5:
        print(f'CALIBRATION FAILED: close differs {calib[0][2]:.2f}% — coordinate mapping is wrong, '
              'fall back to the Playwright browser render route (fallback A of the original plan)')
        sys.exit(2)

    (HERE / 'report.tsv').write_text(''.join(f'{n}\t{f}\t{p:.2f}\t{s}\n' for n, f, p, s in rows))
    diffs = sorted({r[0] for r in rows if r[3] == 'DIFF'})
    print(f'compared={len(rows)} unresolved_ligatures={len(unresolved)} diff_icons={len(diffs)}')
    print('diff icons:', ' '.join(diffs[:100]))
    if unresolved:
        print('unresolved:', ' '.join(unresolved[:50]))


if __name__ == '__main__':
    main()
