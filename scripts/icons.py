#!/usr/bin/env python3
"""Generate the LocalTune vinyl PWA icons.

A flat warm-white tile (rounded for the `any` icons, full-bleed for the
`maskable` ones) carries an ink-black record, three grooves, an ink-green
label and a punched centre hole. Geometry is authored in 512-unit space,
rendered at 4x and downscaled with LANCZOS so edges stay clean on every DPI.

Usage: python3 scripts/icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

BG = (246, 245, 241)        # #f6f5f1
RECORD = (20, 20, 22)       # #141416
GROOVE = (42, 42, 46)       # #2a2a2e
LABEL = (31, 92, 69)        # #1f5c45

OUT_DIR = Path(__file__).resolve().parent.parent / "src" / "icons"
SUPERSAMPLE = 4

CANVAS = 512.0
CORNER_RADIUS = CANVAS * 0.22
GROOVE_FRACTIONS = (0.84, 0.68, 0.52)

# `any` keeps the record inside a rounded tile; `maskable` fills the square and
# pulls the record inside the 80% safe zone (176 / 512 = 0.6875 of the radius).
VARIANTS = {
    "any": {"disc_radius": 190.0, "groove_width": 2.0, "rounded": True},
    "maskable": {"disc_radius": 176.0, "groove_width": 1.8, "rounded": False},
}

OUTPUTS = [
    ("icon-192.png", 192, "any"),
    ("icon-512.png", 512, "any"),
    ("icon-maskable-192.png", 192, "maskable"),
    ("icon-maskable-512.png", 512, "maskable"),
    ("icon-180.png", 180, "any"),
]


def render(size: int, variant: str) -> Image.Image:
    spec = VARIANTS[variant]
    canvas = size * SUPERSAMPLE
    scale = canvas / CANVAS
    image = Image.new("RGBA", (canvas, canvas), BG + (0,))
    draw = ImageDraw.Draw(image)

    if spec["rounded"]:
        draw.rounded_rectangle(
            (0, 0, canvas - 1, canvas - 1),
            radius=CORNER_RADIUS * scale,
            fill=BG + (255,),
        )
    else:
        draw.rectangle((0, 0, canvas - 1, canvas - 1), fill=BG + (255,))

    centre = canvas / 2
    radius = spec["disc_radius"] * scale

    def circle(fraction: float) -> tuple[float, float, float, float]:
        r = radius * fraction
        return (centre - r, centre - r, centre + r, centre + r)

    draw.ellipse(circle(1.0), fill=RECORD + (255,))

    groove_width = max(1, round(spec["groove_width"] * scale))
    for fraction in GROOVE_FRACTIONS:
        draw.ellipse(circle(fraction), outline=GROOVE + (255,), width=groove_width)

    draw.ellipse(circle(0.34), fill=LABEL + (255,))
    draw.ellipse(circle(0.07), fill=BG + (255,))

    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    expected = {name for name, _, _ in OUTPUTS}

    # Drop outputs from earlier revisions so the directory holds no orphans.
    for stale in OUT_DIR.glob("*.png"):
        if stale.name not in expected:
            stale.unlink()

    for name, size, variant in OUTPUTS:
        path = OUT_DIR / name
        render(size, variant).save(path, "PNG", optimize=True)
        with Image.open(path) as saved:
            assert saved.size == (size, size), f"{name}: {saved.size}"
            print(f"{path.relative_to(OUT_DIR.parent.parent)} {saved.size[0]}x{saved.size[1]}")


if __name__ == "__main__":
    main()
