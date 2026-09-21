#!/usr/bin/env python3
"""
Regenerate the Tabler icon subset used by src/index.css.

    cd webapp && python3 scripts/build-icon-subset.py

The full webfont is 820 KB of glyphs and 247 KB of CSS for ~5,900 icons, all
of it downloaded before the first screen paints; this app renders under fifty.
The subset is the SAME font with the unused glyphs dropped, so class names,
glyph shapes and metrics are identical — nothing in the UI shifts.

Run this after adding an `<Icon name="ti-…">` the subset does not yet carry:
the icon renders as a blank box until you do, and this script exits non-zero
if a name used in src/ does not exist in the Tabler font at all (a typo).

Requires: fontTools and brotli (`python3 -m pip install fonttools brotli`).
"""

import pathlib
import re
import subprocess
import sys

WEBAPP = pathlib.Path(__file__).resolve().parent.parent
PACKAGE = WEBAPP / "node_modules/@tabler/icons-webfont/dist"
OUT_DIR = WEBAPP / "src/assets"
OUT_FONT = OUT_DIR / "tabler-icons-subset.woff2"
OUT_CSS = OUT_DIR / "tabler-icons-subset.css"


def main() -> int:
    css = (PACKAGE / "tabler-icons.min.css").read_text()
    # `.ti-check:before{content:"\ea5e"}` → {"ti-check": "ea5e"}
    mapping = dict(re.findall(r'\.(ti-[a-z0-9-]+):before\{content:"\\([0-9a-f]+)"\}', css))

    used: set[str] = set()
    for path in WEBAPP.glob("src/**/*"):
        if path.is_file() and path.suffix in (".ts", ".tsx", ".css"):
            used.update(re.findall(r"\bti-[a-z0-9-]+\b", path.read_text()))

    known = sorted(name for name in used if name in mapping)
    missing = sorted(name for name in used if name not in mapping)
    if missing:
        print(f"error: not Tabler icon names: {', '.join(missing)}", file=sys.stderr)
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    codepoints = sorted({int(mapping[name], 16) for name in known})
    subprocess.run(
        [
            sys.executable,
            "-m",
            "fontTools.subset",
            str(PACKAGE / "fonts/tabler-icons.woff2"),
            "--unicodes=" + ",".join(f"U+{cp:04x}" for cp in codepoints),
            "--flavor=woff2",
            "--layout-features=",
            "--no-hinting",
            "--desubroutinize",
            f"--output-file={OUT_FONT}",
        ],
        check=True,
    )

    rules = "".join(f'.{name}:before {{ content: "\\{mapping[name]}"; }}\n' for name in known)
    OUT_CSS.write_text(
        f"""/*
 * Tabler Icons 3.31.0 by tabler — https://tabler.io
 * License: https://github.com/tabler/tabler-icons/blob/master/LICENSE
 *
 * GENERATED — do not edit by hand. Regenerate with scripts/build-icon-subset.py
 * after adding an icon (the script fails loudly on a name the font lacks).
 *
 * The full webfont is 820 KB of glyphs plus 247 KB of CSS for ~5,900 icons;
 * this app renders {len(known)}. Everything below is the same font and the same
 * class names — `<i class="ti ti-check">` is unchanged, and so are the glyph
 * metrics, because this IS the Tabler font with the unused glyphs removed.
 */
@font-face {{
    font-family: "tabler-icons";
    font-style: normal;
    font-weight: 400;
    font-display: block;
    src: url("./tabler-icons-subset.woff2") format("woff2");
}}

.ti {{
    font-family: "tabler-icons" !important;
    speak: none;
    font-style: normal;
    font-weight: normal;
    font-variant: normal;
    text-transform: none;
    line-height: 1;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
}}

{rules}"""
    )
    print(f"{len(known)} glyphs · {OUT_FONT.stat().st_size:,} bytes → {OUT_FONT.relative_to(WEBAPP)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
