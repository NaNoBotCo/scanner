#!/usr/bin/env python3
"""A synthetic photo of a signature on paper: blue ink, warm uneven light,
a shadow down one side. Used to exercise the ink lift."""
from PIL import Image, ImageDraw, ImageFilter
import pathlib, math, random

OUT = pathlib.Path(__file__).resolve().parent / "testdata"
random.seed(11)
W, H = 1500, 900

paper = Image.new("RGB", (W, H), (243, 240, 232))
d = ImageDraw.Draw(paper)
for _ in range(2500):                       # paper grain
    x, y = random.randrange(W), random.randrange(H)
    d.point((x, y), fill=(228 + random.randint(-6, 6),) * 3)

ink = Image.new("RGBA", (W, H), (0, 0, 0, 0))
di = ImageDraw.Draw(ink)
pts = []
for i in range(600):
    t = i / 600
    x = 180 + t * 1140
    y = 520 - 150 * math.sin(t * math.pi * 4.3) - 60 * math.sin(t * math.pi * 11) - 70 * t
    pts.append((x, y))
for w, a in ((16, 90), (11, 180), (8, 255)):
    di.line(pts, fill=(22, 40, 120, a), width=w, joint="curve")
di.line([(200, 660), (1180, 640)], fill=(22, 40, 120, 210), width=5)
ink = ink.filter(ImageFilter.GaussianBlur(1.1))
paper.paste(ink, (0, 0), ink)

light = Image.new("L", (W, H), 0)
ld = ImageDraw.Draw(light)
for i in range(50):
    ld.ellipse([-500 + i * 14, -700 + i * 18, 1200 + i * 16, 1400 + i * 16], outline=255 - i * 4, width=34)
light = light.filter(ImageFilter.GaussianBlur(170))
shot = Image.composite(paper, Image.eval(paper, lambda v: int(v * 0.38)), light)
shot = shot.filter(ImageFilter.GaussianBlur(0.7))
shot.save(OUT / "signature-photo.jpg", quality=88)
print("wrote", OUT / "signature-photo.jpg", shot.size)
