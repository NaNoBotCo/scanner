#!/usr/bin/env python3
"""A synthetic photo of a page: text on paper, tilted in perspective on a desk,
with uneven light. Used to exercise detection, warp, filters and export."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import pathlib, random

OUT = pathlib.Path(__file__).resolve().parent / "testdata"
OUT.mkdir(exist_ok=True)
random.seed(7)

PW, PH = 1240, 1754          # the page itself, A4-ish at 150 dpi
page = Image.new("RGB", (PW, PH), (252, 251, 248))
d = ImageDraw.Draw(page)
try:
    big = ImageFont.truetype("/System/Library/Fonts/Supplemental/Times New Roman.ttf", 54)
    body = ImageFont.truetype("/System/Library/Fonts/Supplemental/Times New Roman.ttf", 34)
except OSError:
    big = body = ImageFont.load_default()

d.text((90, 120), "TEST PAGE", font=big, fill=(10, 10, 10))
lines = [
    "1. This page exists to give the scanner something to read.",
    "2. The lines are long enough to show whether the text stayed sharp.",
    "3. The paper is tilted, so the corner finder has work to do.",
    "4. The light falls unevenly, so the flattening has work to do.",
    "5. Nothing here means anything.",
]
y = 260
for i in range(28):
    text = lines[i % len(lines)] if i % 3 else ""
    d.text((90, y), text, font=body, fill=(24, 24, 28))
    y += 52
d.rectangle([90, y + 40, 600, y + 44], fill=(20, 20, 20))
d.text((90, y + 60), "Signature", font=body, fill=(40, 40, 60))

# desk background
BW, BH = 1600, 2100
bg = Image.new("RGB", (BW, BH), (78, 62, 48))
bd = ImageDraw.Draw(bg)
for i in range(0, BH, 14):
    bd.line([(0, i), (BW, i)], fill=(88 + random.randint(-8, 8), 70, 54), width=6)
bg = bg.filter(ImageFilter.GaussianBlur(2))

# put the page on the desk in perspective
dst = [(250, 210), (1385, 300), (1300, 1880), (170, 1760)]
def coeffs(src, dst):
    m = []
    for (x, y), (u, v) in zip(dst, src):
        m.append([x, y, 1, 0, 0, 0, -x * u, -y * u])
        m.append([0, 0, 0, x, y, 1, -x * v, -y * v])
    import numpy
    A = numpy.matrix(m, dtype=float)
    B = numpy.array(src).reshape(8)
    return numpy.array(numpy.dot(numpy.linalg.inv(A.T * A) * A.T, B)).reshape(8)

src = [(0, 0), (PW, 0), (PW, PH), (0, PH)]
warped = page.transform((BW, BH), Image.PERSPECTIVE, coeffs(src, dst),
                        Image.BICUBIC, fillcolor=(0, 0, 0))
mask = Image.new("L", (BW, BH), 0)
ImageDraw.Draw(mask).polygon(dst, fill=255)
bg.paste(warped, (0, 0), mask)

# uneven light: bright top-left, the shadow of a hand bottom-right
light = Image.new("L", (BW, BH), 0)
ld = ImageDraw.Draw(light)
for i in range(60):
    ld.ellipse([-400 + i * 8, -500 + i * 10, 1500 + i * 12, 1800 + i * 14], outline=255 - i * 3, width=30)
light = light.filter(ImageFilter.GaussianBlur(160))
shot = Image.composite(bg, Image.eval(bg, lambda v: int(v * 0.42)), light)
shot = shot.filter(ImageFilter.GaussianBlur(0.6))
shot.save(OUT / "desk.jpg", quality=88)
print("wrote", OUT / "desk.jpg", shot.size)
