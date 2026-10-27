"""Synthetic panel imagery for demo mode (clearly labelled, never a real capture)."""

from __future__ import annotations

import math
import random
from datetime import datetime

from PIL import Image, ImageDraw, ImageFilter


def generate_panel_image(
    loss_pct: float = 0.0,
    size: tuple[int, int] = (640, 420),
    variant: str = "auto",
    seed: int | None = None,
) -> Image.Image:
    """Draw an illustrative PV panel whose surface dirt scales with *loss_pct*.

    Used for seeded demo images and simulated camera captures. Images produced
    this way are stored with source = "demo" so the UI can label them.
    """
    rng = random.Random(seed if seed is not None else int(datetime.now().timestamp()))
    w, h = size
    img = Image.new("RGB", (w, h), (18, 34, 58))
    draw = ImageDraw.Draw(img)

    # sky gradient background
    for y in range(h):
        t = y / h
        colour = (int(24 + 40 * t), int(52 + 60 * t), int(92 + 70 * t))
        draw.line([(0, y), (w, y)], fill=colour)

    # panel frame
    margin = 28
    px0, py0, px1, py1 = margin, margin, w - margin, h - margin
    draw.rounded_rectangle([px0, py0, px1, py1], radius=8, fill=(12, 22, 40), outline=(200, 205, 215), width=4)

    cols, rows = 4, 3
    cell_w = (px1 - px0 - 20) / cols
    cell_h = (py1 - py0 - 20) / rows
    for c in range(cols):
        for r in range(rows):
            x0 = px0 + 10 + c * cell_w
            y0 = py0 + 10 + r * cell_h
            draw.rectangle(
                [x0 + 3, y0 + 3, x0 + cell_w - 3, y0 + cell_h - 3],
                fill=(28, 62, 118),
                outline=(60, 96, 150),
                width=2,
            )
            # busbars
            for b in range(1, 5):
                bx = x0 + 3 + (cell_w - 6) * b / 5
                draw.line([(bx, y0 + 5), (bx, y0 + cell_h - 5)], fill=(150, 170, 195), width=1)

    # soiling overlay
    variant = variant if variant != "auto" else (
        "heavy" if loss_pct >= 10 else "light" if loss_pct >= 4 else "clean"
    )
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    if variant in {"light", "heavy"}:
        strength = 70 if variant == "light" else 150
        dust_color = (152, 132, 96)
        for _ in range(260 if variant == "heavy" else 120):
            x = rng.uniform(px0, px1)
            y = rng.uniform(py0, py1)
            r = rng.uniform(3, 16)
            alpha = int(rng.uniform(strength * 0.35, strength))
            od.ellipse([x - r, y - r, x + r, y + r], fill=dust_color + (alpha,))
        # streaks
        for _ in range(18 if variant == "heavy" else 6):
            x = rng.uniform(px0, px1)
            od.line([(x, py0), (x + rng.uniform(-25, 25), py1)], fill=dust_color + (int(strength * 0.5),), width=rng.randint(6, 18))
    elif variant == "bird":
        for _ in range(rng.randint(1, 3)):
            cx = rng.uniform(px0 + 60, px1 - 60)
            cy = rng.uniform(py0 + 40, py1 - 40)
            rr = rng.randint(18, 42)
            od.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=(238, 238, 230, 235))
            od.ellipse([cx - rr - 12, cy + rr - 10, cx + rr + 14, cy + rr + 22], fill=(228, 226, 210, 190))
        # light dusting around
        for _ in range(60):
            x = rng.uniform(px0, px1)
            y = rng.uniform(py0, py1)
            r = rng.uniform(2, 9)
            od.ellipse([x - r, y - r, x + r, y + r], fill=(152, 132, 96, 60))

    overlay = overlay.filter(ImageFilter.GaussianBlur(1.6))
    img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")

    # timestamp-ish watermark strip (small, bottom-right)
    d = ImageDraw.Draw(img)
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    d.text((w - 130, h - 18), f"DEMO {stamp}", fill=(235, 240, 245))

    # mild exposure variation
    if variant == "clean" and math.sin(seed or 1) > 0:
        img = img.point(lambda v: min(255, int(v * 1.05)))
    return img
