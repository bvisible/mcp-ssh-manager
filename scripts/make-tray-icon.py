#!/usr/bin/env python3
"""
The menu-bar icon, at the two sizes macOS asks for.

macOS menu-bar icons are *template* images: black pixels plus an alpha channel,
no colour. The system then paints them — dark on a light bar, light on a dark
one, inverted again when the menu is open. Shipping the brand's orange mark here
would look wrong in at least two of those four states, which is why this is a
separate glyph rather than a resize of resources/icon.png.

At 16 points there is room for one idea. The brand mark's chevron-and-prompt is
that idea; the AI sparks are dropped because at this size they are three grey
pixels that read as dirt.

Filenames matter: Electron looks for `<name>Template.png` and `<name>Template@2x.png`
and only treats the image as a template when the name ends in `Template`.

Usage: python3 scripts/make-tray-icon.py
"""
import pathlib

from PIL import Image, ImageDraw

OUT = pathlib.Path(__file__).resolve().parent.parent / 'desktop' / 'electron' / 'resources'


def glyph(size):
    """A chevron and a prompt bar, drawn at 4x and downsampled for clean edges."""
    scale = 4
    s = size * scale
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    stroke = max(2, round(s * 0.105))
    pad = round(s * 0.16)
    mid = s // 2

    # >  — the chevron, vertically centred on the upper two thirds
    top = round(s * 0.20)
    bottom = round(s * 0.66)
    d.line([(pad, top), (mid + round(s * 0.02), (top + bottom) // 2), (pad, bottom)],
           fill=(0, 0, 0, 255), width=stroke, joint='curve')

    # _  — the prompt, sitting under the chevron's point
    bar_y = round(s * 0.80)
    d.line([(mid + round(s * 0.10), bar_y), (s - pad, bar_y)],
           fill=(0, 0, 0, 255), width=stroke)

    return img.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for size, name in ((16, 'trayTemplate.png'), (32, 'trayTemplate@2x.png')):
        path = OUT / name
        glyph(size).save(path)
        print(f'  {name:<24} {size}x{size}  {path.stat().st_size} o')


if __name__ == '__main__':
    main()
