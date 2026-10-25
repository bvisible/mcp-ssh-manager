#!/usr/bin/env python3
"""
Draw the CLI's home screen for the README, from the CLI itself.

The picture this replaces was a screenshot taken by hand of the 3.1 menu, in
another terminal application, with somebody's avatar in the corner: it showed a
version nobody runs and leaked a little of the machine it was taken on. This
runs the real `ssh-manager` menu in a pseudo-terminal, against a stand-in home
holding three demo servers, reads the colours it prints, and draws the screen
in a plain terminal window. After any change to the menu, run it again.

What is real: every character and colour the menu prints. What is not: the
servers (three names on the loopback) and the home directory. The desktop app
part of the status line is read from this machine's /Applications.

Pillow is the only dependency (`uv run --with pillow python3 scripts/render-cli-menu.py`).

Usage: python3 scripts/render-cli-menu.py [out.png]   (default: docs/images/ssh-manager-cli-menu.png)
"""
import os
import pathlib
import re
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'docs' / 'images' / 'ssh-manager-cli-menu.png'
FONT = '/System/Library/Fonts/Menlo.ttc'   # index 0 regular, 1 bold

SCALE = 2
COLS = 78
CELL_W, CELL_H = 8 * SCALE, 17 * SCALE     # Menlo 13pt advance and line height
FONT_SIZE = 13 * SCALE
PAD_X, PAD_Y = 22 * SCALE, 18 * SCALE
BAR = 34 * SCALE
SHADOW = 40 * SCALE
RADIUS = 11 * SCALE

GROUND = (20, 20, 19)          # #141413, the icon's black
BAR_TOP = (38, 37, 35)
TEXT = (230, 227, 221)
LIGHTS = [(255, 95, 87), (254, 188, 46), (40, 200, 64)]

# The handful of SGR colours the menu uses, mapped to what a dark terminal
# shows for them. 166 is the application's orange (#c04500 at 256 colours).
SGR_COLOURS = {
    '30': (60, 60, 60), '31': (231, 96, 85), '32': (95, 191, 131), '33': (227, 169, 59),
    '34': (127, 176, 234), '35': (200, 140, 220), '36': (90, 200, 210), '37': TEXT,
    '90': (138, 134, 127), '38;5;166': (215, 95, 0),
}

DEMO_ENV = (
    'SSH_SERVER_PRODUCTION_HOST=127.0.0.1\nSSH_SERVER_PRODUCTION_USER=deploy\n'
    'SSH_SERVER_STAGING_HOST=127.0.0.1\nSSH_SERVER_STAGING_USER=deploy\n'
    'SSH_SERVER_BACKUP_HOST=127.0.0.1\nSSH_SERVER_BACKUP_USER=root\n'
)


def capture() -> str:
    """Run the menu in a pseudo-terminal, answer `q`, and return what it drew."""
    with tempfile.TemporaryDirectory(prefix='cli-menu-') as home:
        state = pathlib.Path(home, '.ssh-manager')
        state.mkdir()
        (state / '.env').write_text(DEMO_ENV)
        env = {'PATH': os.environ['PATH'], 'HOME': home, 'TERM': 'xterm-256color',
               'COLUMNS': str(COLS), 'LINES': '30'}
        # `script` gives the menu a terminal, so it draws exactly what a person
        # sees; piped, it would print its plain non-interactive output instead.
        result = subprocess.run(['script', '-q', '/dev/null', 'bash', str(ROOT / 'cli' / 'ssh-manager')],
                                input='q\n', capture_output=True, text=True, env=env, timeout=60)
    screen = result.stdout
    # Keep what follows the last clear-screen: the home screen itself.
    cleared = [m.end() for m in re.finditer(r'\x1b\[2J', screen)]
    if not cleared:
        sys.exit('the menu never drew its screen:\n' + screen[:500])
    screen = screen[cleared[-1]:].replace('\r', '')
    lines = screen.split('\n')
    # Up to and including the prompt line; the echoed `q` and the farewell are not the screen.
    end = next((i for i, line in enumerate(lines) if '›' in line), len(lines) - 1)
    return '\n'.join(lines[:end + 1]).strip('\n')


def spans(line: str):
    """Split a line into (text, colour, bold) runs, following its SGR codes."""
    colour, bold, out = TEXT, False, []
    for part in re.split(r'(\x1b\[[0-9;]*m)', line):
        match = re.fullmatch(r'\x1b\[([0-9;]*)m', part)
        if not match:
            if part:
                out.append((re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', part), colour, bold))
            continue
        codes = match.group(1) or '0'
        if codes.startswith('38;5;'):
            colour = SGR_COLOURS.get(codes, TEXT)
            continue
        for code in codes.split(';'):
            if code in ('0', ''):
                colour, bold = TEXT, False
            elif code == '1':
                bold = True
            elif code in SGR_COLOURS:
                colour = SGR_COLOURS[code]
    return out


def render(screen: str, out: pathlib.Path) -> pathlib.Path:
    lines = screen.split('\n')
    regular = ImageFont.truetype(FONT, FONT_SIZE, index=0)
    heavy = ImageFont.truetype(FONT, FONT_SIZE, index=1)
    w = PAD_X * 2 + COLS * CELL_W
    h = BAR + PAD_Y * 2 + len(lines) * CELL_H

    window = Image.new('RGBA', (w, h), (*GROUND, 255))
    d = ImageDraw.Draw(window)
    d.rectangle([0, 0, w, BAR], fill=(*BAR_TOP, 255))
    for i, colour in enumerate(LIGHTS):
        x = 14 * SCALE + i * 20 * SCALE
        y = (BAR - 12 * SCALE) // 2
        d.ellipse([x, y, x + 12 * SCALE, y + 12 * SCALE], fill=(*colour, 255))
    d.text((w // 2, BAR // 2), 'ssh-manager', font=regular, fill=(150, 146, 139), anchor='mm')

    for row, line in enumerate(lines):
        col = 0
        for text, colour, bold in spans(line):
            for char in text:
                if char == '\t':
                    col += 8 - col % 8
                    continue
                d.text((PAD_X + col * CELL_W, BAR + PAD_Y + row * CELL_H), char,
                       font=heavy if bold else regular, fill=colour)
                col += 1

    mask = Image.new('L', window.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius=RADIUS, fill=255)
    window.putalpha(mask)

    canvas = Image.new('RGBA', (w + SHADOW * 2, h + SHADOW * 2), (0, 0, 0, 0))
    shadow = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([SHADOW, SHADOW + 8 * SCALE, SHADOW + w, SHADOW + h + 8 * SCALE],
                                             radius=RADIUS, fill=(0, 0, 0, 90))
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(14 * SCALE)))
    canvas.alpha_composite(window, (SHADOW, SHADOW))
    canvas.save(out, optimize=True)
    return out


def main():
    out = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else OUT
    made = render(capture(), out)
    print(f'  {made.relative_to(ROOT) if made.is_relative_to(ROOT) else made}  {made.stat().st_size // 1024} Ko')


if __name__ == '__main__':
    main()
