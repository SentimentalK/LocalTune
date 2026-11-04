#!/usr/bin/env python3
"""Generate the LocalTune PWA icons (A · Soft Vinyl style).

Warm-white canvas, ink-green record with grooves and a centre hole.
Supersampled 4x and downscaled so edges are clean on every DPI.

Usage: python3 scripts/icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

BG = (246, 245, 241)      # #f6f5f1
INK = (31, 92, 69)        # #1f5c45
GROOVE = (42, 107, 82)    # slightly lighter ink for the grooves

OUT_DIR = Path(__file__).resolve().parent.parent / "src" / "icons"
SUPERSAMPLE = 4

# The maskable icon keeps its artwork inside the 80% safe circle.
ICONS = [
    ("icon-192.png", 192, 0.86),
    ("icon-512.png", 512, 0.86),
    ("icon-maskable-512.png", 512, 0.66),
]


def render(size: int, disc_ratio: float) -> Image.Image:
    canvas = size * SUPERSAMPLE
    image = Image.new("RGB", (canvas, canvas), BG)
    draw = ImageDraw.Draw(image)

    centre = canvas / 2
    radius = canvas * disc_ratio / 2
    draw.ellipse(
        (centre - radius, centre - radius, centre + radius, centre + radius),
        fill=INK,
    )

    for fraction in (0.82, 0.68, 0.54):
        groove = radius * fraction
        width = max(1, round(canvas * 0.0035))
        draw.ellipse(
            (centre - groove, centre - groove, centre + groove, centre + groove),
            outline=GROOVE,
            width=width,
        )

    hole = radius * 0.1
    draw.ellipse((centre - hole, centre - hole, centre + hole, centre + hole), fill=BG)

    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, size, ratio in ICONS:
        path = OUT_DIR / name
        render(size, ratio).save(path, "PNG", optimize=True)
        saved = Image.open(path)
        assert saved.size == (size, size), f"{name}: {saved.size}"
        print(f"{path.relative_to(OUT_DIR.parent.parent)} {saved.size[0]}x{saved.size[1]}")


if __name__ == "__main__":
    main()
