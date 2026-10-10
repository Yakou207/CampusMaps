"""Cut LXGW WenKai down to the characters this site actually uses.

The full font is ~25 MB per weight; the subset is a few hundred KB. Characters typed by
visitors (comments) that are not in the subset simply fall back to the system font.
Re-run after adding stalls or changing page text:

    .venv/bin/python tools/subset_font.py

Needs fonttools + brotli (pip install fonttools brotli) and the source fonts in
tools/font-src/ (download from https://github.com/lxgw/LxgwWenKai/releases).
"""
import re
from pathlib import Path

from fontTools import subset

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "tools" / "font-src"
OUT = ROOT / "static" / "fonts"
SOURCES = ["templates/*.html", "static/js/*.js", "data/*.csv", "static/map/campus.svg"]
WEIGHTS = {"400": "LXGWWenKai-Regular.ttf", "500": "LXGWWenKai-Medium.ttf"}
# printable ASCII, CJK punctuation and a few symbols used in the UI
BASE = "".join(chr(c) for c in range(0x20, 0x7F)) + "，。、；：？！“”‘’（）《》【】…—·～★☆–ü"


def used_text():
    text = BASE
    for pattern in SOURCES:
        for path in ROOT.glob(pattern):
            raw = path.read_text(encoding="utf-8-sig")
            if path.suffix == ".svg":  # only the label text, not the path data
                raw = " ".join(re.findall(r">([^<]+)</text>", raw))
            text += raw
    return "".join(sorted({ch for ch in text if ch.isprintable()}))


def main():
    chars = used_text()
    OUT.mkdir(parents=True, exist_ok=True)
    for weight, filename in WEIGHTS.items():
        options = subset.Options()
        options.flavor = "woff2"
        options.layout_features = ["*"]
        options.name_IDs = ["*"]
        font = subset.load_font(str(SRC / filename), options)
        subsetter = subset.Subsetter(options)
        subsetter.populate(text=chars)
        subsetter.subset(font)
        out = OUT / f"wenkai-{weight}.woff2"
        subset.save_font(font, str(out), options)
        print(f"{out.relative_to(ROOT)}: {len(chars)} chars, {out.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
