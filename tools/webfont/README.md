# Gate G1 — Google Fonts web font vs. CDN SVG paths

Question: do the per-icon SVG paths from the Google Fonts CDN (`fonts.gstatic.com/s/i/short-term/release/materialsymbols*/…/24px.svg`, opsz 24) render the same as the Material Symbols variable web font that many apps use today?

## How to run

```bash
python3 -m venv tools/webfont/.venv
tools/webfont/.venv/bin/pip install fonttools brotli numpy
tools/webfont/.venv/bin/python tools/webfont/verify_webfont.py <web-font.woff2> [--names names.txt]
tools/webfont/.venv/bin/python tools/webfont/lab_profile_png.py lab_profile   # visual diff PNG
```

`--names` limits the comparison to a list of names (one per line), e.g. the icon names an app actually uses. Outputs go to `tools/webfont/.cache/` (git-ignored).

## Result (2026-10-01, fontTools 4.66.1, style rounded, CDN opsz 24, `default` and `fill1`)

- Calibration: `close` differs by 0.00% in both fills (threshold 0.5%), so the coordinate mapping is correct.
- The web font has `unitsPerEm=960`, a `FILL 0..1` axis and **no opsz axis**.
- Names used by one private production app (303 names, 606 comparisons): 0 unresolved, 5 differ (`android animation block lab_profile switch`). Four of them are not used as icons in that app (they occur as plain strings: platform names, CSS values, prop names). The only real difference is **`lab_profile` with FILL=1: 0.90%** (83 px on a 96×96 grid, near the magnifier handle at the bottom right). FILL=0 matches.
- Full comparison (3,721 of 3,927 names, both fills = 7,442 rows): 206 names are missing from the font (newer icons; the web font is an older snapshot than the CDN), 104 icons differ (redesigned icons such as `car_defrost_*`, `brightness_*`, `reset_*`).

## Verdict

G1 does not pass strictly: one icon in real use (`lab_profile`, filled) differs by 0.90%, above the 0.5% threshold. The difference is very likely invisible at 24 px (Estimated). Whether to accept it, special-case it, or ship the web-font outline for that icon is an open project decision.

Not covered: the outlined and sharp styles, sizes other than 24 px, and icon names built dynamically at runtime.
