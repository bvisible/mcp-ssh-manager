#!/usr/bin/env python3
"""
Wrap the raw UI captures in a window, so a README reader sees a product rather
than a rectangle of pixels.

Two frames, because the thing genuinely runs two ways and they do not look the
same to the person using it:

  browser  a tab pointed at the local control plane — what `npx mcp-ssh-manager
           --ui` gives you
  app      the packaged desktop build, whose window is `titleBarStyle:
           'hiddenInset'`: no title bar at all, traffic lights floating over the
           sidebar at (14, 14). Those numbers are read off
           desktop/electron/main.js rather than invented, so the picture keeps
           matching the product when the product moves.

Composited with Pillow rather than rendered through headless Chrome: Chrome 152
does not return from --headless on this machine, and a compositor we control is
one less thing that can quietly stop working before a release.

Everything below is in device pixels. The captures are 2x, so a 12pt CSS
traffic light is 24px here.

Usage: python3 scripts/frame-screenshots.py [name ...]   (default: every v4-*.png)
"""
import pathlib
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
IMAGES = ROOT / 'docs' / 'images'
RAW = IMAGES / '.raw'
FONT = '/System/Library/Fonts/SFNS.ttf'

SCALE = 2
PAD = 44 * SCALE          # room for the shadow to fall into
BAR = 42 * SCALE          # browser chrome height
LIGHT = 12 * SCALE        # traffic light diameter
GAP = 8 * SCALE

# Warm neutrals, pulled toward the interface's own palette so the frame reads as
# part of the same object rather than a stock mockup dropped around it.
CHROME_TOP, CHROME_BOT = (243, 240, 238), (234, 230, 227)
HAIRLINE = (217, 211, 206)
PILL_BG, PILL_EDGE, PILL_TEXT = (255, 255, 255), (222, 216, 211), (111, 103, 99)
LIGHTS = [(255, 95, 87), (254, 188, 46), (40, 200, 64)]


def rounded_mask(size, radius):
    mask = Image.new('L', size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1],
                                           radius=radius, fill=255)
    return mask


def vertical_gradient(size, top, bottom):
    w, h = size
    strip = Image.new('RGB', (1, h))
    px = strip.load()
    for y in range(h):
        t = y / max(h - 1, 1)
        px[0, y] = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))
    return strip.resize(size, Image.BILINEAR)


def draw_lights(canvas, left, top):
    """The three macOS window buttons, with the faint inner edge they really have."""
    d = ImageDraw.Draw(canvas, 'RGBA')
    for i, colour in enumerate(LIGHTS):
        x = left + i * (LIGHT + GAP)
        d.ellipse([x, top, x + LIGHT, top + LIGHT], fill=(*colour, 255),
                  outline=(0, 0, 0, 28), width=max(1, SCALE // 2))


def browser_bar(width):
    """Chrome: traffic lights on the left, one address pill centred."""
    bar = vertical_gradient((width, BAR), CHROME_TOP, CHROME_BOT).convert('RGBA')
    d = ImageDraw.Draw(bar)
    d.line([(0, BAR - 1), (width, BAR - 1)], fill=HAIRLINE, width=1)
    draw_lights(bar, 16 * SCALE, (BAR - LIGHT) // 2)

    pw, ph = 340 * SCALE, 24 * SCALE
    px, py = (width - pw) // 2, (BAR - ph) // 2
    d.rounded_rectangle([px, py, px + pw, py + ph], radius=6 * SCALE,
                        fill=PILL_BG, outline=PILL_EDGE, width=1)

    # A padlock, then the address. The real URL carries a session token; showing
    # the origin alone is the honest short form and keeps the token out of a
    # picture that ends up in a README.
    label = 'localhost:7315'
    font = ImageFont.truetype(FONT, 11 * SCALE + 1)
    tw = d.textlength(label, font=font)
    lock_w = 9 * SCALE
    start = px + (pw - (lock_w + 6 * SCALE + tw)) / 2
    ly = py + ph / 2
    d.rounded_rectangle([start, ly - 3 * SCALE, start + lock_w, ly + 3 * SCALE],
                        radius=1.4 * SCALE, fill=(138, 130, 125))
    d.arc([start + 1.6 * SCALE, ly - 6.4 * SCALE, start + lock_w - 1.6 * SCALE, ly],
          start=180, end=360, fill=(138, 130, 125), width=round(1.2 * SCALE))
    d.text((start + lock_w + 6 * SCALE, ly), label, font=font,
           fill=PILL_TEXT, anchor='lm')
    return bar


def frame(src: pathlib.Path, kind: str, out: pathlib.Path) -> pathlib.Path:
    shot = Image.open(src).convert('RGB')
    w, h = shot.size
    bar_h = BAR if kind == 'browser' else 0
    radius = (10 if kind == 'browser' else 12) * SCALE

    window = Image.new('RGBA', (w, h + bar_h), (252, 252, 252, 255))
    if bar_h:
        window.paste(browser_bar(w), (0, 0))
    window.paste(shot, (0, bar_h))
    if kind == 'app':
        # hiddenInset puts the lights over the content itself, at (14, 14).
        draw_lights(window, 14 * SCALE, 14 * SCALE)

    window.putalpha(rounded_mask(window.size, radius))

    canvas = Image.new('RGBA', (w + PAD * 2, h + bar_h + PAD * 2), (0, 0, 0, 0))

    # Two shadows: a tight one that seats the window, and a wide soft one that
    # gives it height. One alone reads as either a sticker or a smudge.
    for blur, offset, alpha, inset in ((3 * SCALE, 1 * SCALE, 40, 0),
                                       (22 * SCALE, 14 * SCALE, 52, 6 * SCALE)):
        layer = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
        ImageDraw.Draw(layer).rounded_rectangle(
            [PAD + inset, PAD + offset + inset,
             PAD + w - inset, PAD + h + bar_h + offset - inset],
            radius=radius, fill=(28, 22, 18, alpha))
        canvas.alpha_composite(layer.filter(ImageFilter.GaussianBlur(blur)))

    canvas.alpha_composite(window, (PAD, PAD))

    # A hairline so the light window keeps an edge against a light README.
    edge = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(edge).rounded_rectangle(
        [PAD, PAD, PAD + w, PAD + h + bar_h], radius=radius,
        outline=(28, 22, 18, 38), width=max(1, SCALE // 2))
    canvas.alpha_composite(edge)

    canvas.save(out, optimize=True)
    return out


def main():
    """Frame each raw capture with the chrome it was captured for.

    The pairing is not cosmetic: a capture taken with `?shell=macos` already
    leaves 28px clear at the top of the rail for the window buttons, and one
    taken without it does not. Framing an app capture as a browser (or the
    reverse) puts the traffic lights on top of the sidebar's own controls.
    """
    raws = RAW.glob('*.png')
    names = sys.argv[1:]
    if names:
        raws = [RAW / f'{n}.png' for n in names]
    made = 0
    for src in sorted(raws):
        if not src.exists():
            print(f'  ! {src.name}: pas de source')
            continue
        kind = 'app' if src.stem.endswith('-app') else 'browser'
        out = frame(src, kind, IMAGES / src.name)
        print(f'  {out.name:<28} {out.stat().st_size // 1024:>4} Ko')
        made += 1
    if not made:
        sys.exit(f'aucune capture dans {RAW} — lancer scripts/capture-screenshots.mjs')


if __name__ == '__main__':
    main()
