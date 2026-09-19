#!/usr/bin/env python3
"""Draw the app icons: a sheet of paper inside camera corner marks."""
from PIL import Image, ImageDraw
import pathlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "docs"
INK = (17, 20, 23, 255)
PAPER = (245, 244, 241, 255)
MARK = (138, 180, 248, 255)
LINE = (120, 126, 132, 255)


def draw(size, padding, rounded):
    s = size * 4
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if rounded:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=INK)
    else:
        d.rectangle([0, 0, s - 1, s - 1], fill=INK)

    p = int(s * padding)
    # the sheet, tilted a touch
    sheet = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sheet)
    w, h = int(s * 0.40), int(s * 0.52)
    x0, y0 = (s - w) // 2, (s - h) // 2
    sd.rectangle([x0, y0, x0 + w, y0 + h], fill=PAPER)
    for i in range(5):
        ly = y0 + int(h * (0.20 + i * 0.145))
        lw = w - int(w * (0.22 if i == 4 else 0.12))
        sd.rectangle([x0 + int(w * 0.10), ly, x0 + int(w * 0.10) + lw - int(w * 0.10), ly + max(2, s // 110)],
                     fill=LINE)
    sheet = sheet.rotate(-6, resample=Image.BICUBIC, center=(s // 2, s // 2))
    im.alpha_composite(sheet)

    # corner marks
    arm, thick = int(s * 0.13), max(3, int(s * 0.026))
    for cx, cy, dx, dy in ((p, p, 1, 1), (s - p, p, -1, 1), (p, s - p, 1, -1), (s - p, s - p, -1, -1)):
        x1, x2 = sorted([cx, cx + dx * arm])
        d.rectangle([x1, cy - thick // 2, x2, cy + thick // 2], fill=MARK)
        y1, y2 = sorted([cy, cy + dy * arm])
        d.rectangle([cx - thick // 2, y1, cx + thick // 2, y2], fill=MARK)

    return im.resize((size, size), Image.LANCZOS)


for size, name, pad, round_ in (
    (192, "icon-192.png", 0.16, True),
    (512, "icon-512.png", 0.16, True),
    (512, "icon-maskable-512.png", 0.26, False),
):
    draw(size, pad, round_).save(OUT / name)
    print("wrote", name)
