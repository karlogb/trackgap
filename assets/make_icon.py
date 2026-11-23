#!/usr/bin/env python3
"""TrackGap — ikona 1200x1200 pre Shopify App Store.

Motiv: stlpcovy graf, kde jeden stlpec chyba (medzera = "gap"). Presne to,
co produkt robi — ukazuje diery v merani.
"""
from PIL import Image, ImageDraw

S = 1200
BG1 = (15, 92, 74)      # tmava zelena
BG2 = (29, 143, 138)    # tyrkysova
BAR = (255, 255, 255)
GAP = (215, 44, 13)     # cervena — chybajuci stlpec

img = Image.new("RGB", (S, S), BG1)
d = ImageDraw.Draw(img)

# diagonalny gradient
for y in range(S):
    for_x = y / S
    r = int(BG1[0] + (BG2[0] - BG1[0]) * for_x)
    g = int(BG1[1] + (BG2[1] - BG1[1]) * for_x)
    b = int(BG1[2] + (BG2[2] - BG1[2]) * for_x)
    d.line([(0, y), (S, y)], fill=(r, g, b))

# stlpce: vysky navrhnute tak, aby stvrty bol viditelne "vypadnuty"
heights = [0.42, 0.58, 0.72, 0.34, 0.80, 0.64]
missing_idx = 3

n = len(heights)
margin = S * 0.16
avail = S - 2 * margin
bw = avail / (n * 1.55)
gap = (avail - n * bw) / (n - 1)
base_y = S - margin

for i, h in enumerate(heights):
    x0 = margin + i * (bw + gap)
    x1 = x0 + bw
    bh = avail * h
    y0 = base_y - bh
    color = GAP if i == missing_idx else BAR
    # zaoblene stlpce
    d.rounded_rectangle([x0, y0, x1, base_y], radius=int(bw * 0.22), fill=color)

    # chybajuci stlpec ma naznacenu "stratenu" cast prerusovanou ciarou
    if i == missing_idx:
        full_h = avail * 0.68
        top = base_y - full_h
        step = 26
        y = top
        while y < y0 - 10:
            d.line([(x0, y), (x1, y)], fill=(255, 255, 255, 90), width=7)
            y += step

# zakladna ciara
d.rounded_rectangle(
    [margin - 10, base_y, S - margin + 10, base_y + 14], radius=7,
    fill=(255, 255, 255))

img.save(str(__import__("pathlib").Path(__file__).resolve().parent / "icon-1200.png"), "PNG", optimize=True)
print("ikona ulozena: assets/icon-1200.png")
