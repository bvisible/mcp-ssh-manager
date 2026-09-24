#!/usr/bin/env python3
"""
Put a screenshot — or the whole demo video — inside a laptop.

A rectangle of interface at the top of a README reads as a screenshot. The same
rectangle inside a laptop reads as software someone is using. That is the entire
argument for this file.

The laptop is drawn here, in code, rather than pulled from a mockup PSD or a
stock image: it composites at whatever size the content is, it has no licence
attached, and it stays a generic aluminium laptop rather than an imitation of a
particular manufacturer's product.

Everything is proportional to the screen, so a 1440x900 recording and a 2880x1800
still both come out looking like the same machine.

Usage:
  python3 scripts/macbook-mockup.py image  <in.png> <out.png>
  python3 scripts/macbook-mockup.py video  <in.mp4> <out.mp4> <out.gif>
"""
import pathlib
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFilter

# Proportions, as fractions of the screen width. Measured off a 14" laptop:
# thin bezels, a deeper chin under the screen, a base a little wider than the lid.
BEZEL = 0.0125          # sides and top of the lid
CHIN = 0.021            # below the screen, where the hinge is
LID_RADIUS = 0.017
BASE_OVERHANG = 0.028   # how far the base sticks out past the lid on each side
BASE_HEIGHT = 0.017
NOTCH_W = 0.105         # the finger recess in the front edge
PAD = 0.075             # room around everything for the shadow

BODY_LIGHT = (72, 74, 78)
BODY_DARK = (38, 39, 43)
BASE_TOP = (96, 98, 103)
BASE_BOTTOM = (44, 45, 49)
SCREEN_SURROUND = (18, 18, 20)


def _gradient(size, top, bottom):
    w, h = size
    strip = Image.new('RGB', (1, h))
    px = strip.load()
    for y in range(h):
        t = y / max(h - 1, 1)
        px[0, y] = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))
    return strip.resize(size, Image.BILINEAR)


def stage(size):
    """The dark ground the laptop stands on, for formats without an alpha channel.

    GIF and h264 cannot carry the soft shadow, so the choice is a flat colour or
    a deliberate one. A near-black radial gradient reads as a product stage, sits
    correctly on both a light and a dark README, and makes the pale interface on
    the screen the brightest thing in the frame — which is where a reader should
    be looking.
    """
    w, h = size
    small = Image.new('RGB', (64, 64))
    px = small.load()
    cx, cy = 32, 26
    for y in range(64):
        for x in range(64):
            d = (((x - cx) / 40) ** 2 + ((y - cy) / 34) ** 2) ** 0.5
            t = min(1.0, d)
            px[x, y] = (round(26 - 16 * t), round(26 - 16 * t), round(31 - 17 * t))
    return small.resize(size, Image.BICUBIC)


def _rounded(size, radius):
    mask = Image.new('L', size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1],
                                           radius=radius, fill=255)
    return mask


def layout(screen_w, screen_h):
    """Every coordinate the mockup needs, derived from the screen size."""
    u = lambda f: max(1, round(screen_w * f))          # noqa: E731
    bezel, chin, pad = u(BEZEL), u(CHIN), u(PAD)
    lid_w = screen_w + bezel * 2
    lid_h = screen_h + bezel + chin
    base_w = lid_w + u(BASE_OVERHANG) * 2
    base_h = u(BASE_HEIGHT)
    return {
        'pad': pad, 'bezel': bezel, 'chin': chin,
        'lid': (lid_w, lid_h), 'base': (base_w, base_h),
        'lid_radius': u(LID_RADIUS), 'notch_w': u(NOTCH_W),
        'canvas': (base_w + pad * 2, lid_h + base_h + pad * 2),
        'lid_xy': (pad + (base_w - lid_w) // 2, pad),
        'screen_xy': (pad + (base_w - lid_w) // 2 + bezel, pad + bezel),
    }


def chrome(screen_w, screen_h, shadow=True):
    """The laptop, with a transparent hole where the screen goes.

    `shadow=False` for formats whose alpha is one bit (GIF): a soft shadow there
    does not fade, it bands into a grey halo with a hard edge, which looks worse
    than no shadow at all.
    """
    L = layout(screen_w, screen_h)
    canvas = Image.new('RGBA', L['canvas'], (0, 0, 0, 0))

    # A soft shadow on the ground, wider and flatter than the machine itself.
    if shadow:
        cast = Image.new('RGBA', L['canvas'], (0, 0, 0, 0))
        bx = L['pad'] + round(L['base'][0] * 0.02)
        by = L['pad'] + L['lid'][1]
        ImageDraw.Draw(cast).rounded_rectangle(
            [bx, by, L['canvas'][0] - bx, by + L['base'][1] + round(L['pad'] * 0.55)],
            radius=L['base'][1], fill=(10, 10, 14, 120))
        canvas.alpha_composite(cast.filter(ImageFilter.GaussianBlur(L['pad'] * 0.30)))

    # The lid, in three layers, outside in: a thin aluminium rim, the black
    # glass front that covers rim-to-screen, and then a hole.
    #
    # The hole is the whole point. Without it the frame is opaque where the
    # screen should be and composites straight over the content — which is
    # exactly what the first version did, and it produced a very convincing
    # picture of a laptop that was switched off.
    lid_w, lid_h = L['lid']
    rim = max(1, round(screen_w * 0.004))
    lid = _gradient(L['lid'], BODY_LIGHT, BODY_DARK).convert('RGBA')
    lid.putalpha(_rounded(L['lid'], L['lid_radius']))

    glass_r = max(2, round(L['lid_radius'] * 0.82))
    d = ImageDraw.Draw(lid)
    d.rounded_rectangle([rim, rim, lid_w - 1 - rim, lid_h - 1 - rim],
                        radius=glass_r, fill=SCREEN_SURROUND)

    # The camera sits on the glass, above the screen.
    cam = max(2, round(screen_w * 0.0032))
    cx, cy = lid_w // 2, max(cam + 1, L['bezel'] // 2)
    d.ellipse([cx - cam, cy - cam, cx + cam, cy + cam], fill=(52, 54, 60))

    # Punch the screen out of the lid's alpha, with rounded corners so the
    # content is clipped by them rather than squared off against the glass.
    hole = Image.new('L', L['lid'], 255)
    ImageDraw.Draw(hole).rounded_rectangle(
        [L['bezel'], L['bezel'], L['bezel'] + screen_w - 1, L['bezel'] + screen_h - 1],
        radius=max(2, round(L['lid_radius'] * 0.42)), fill=0)
    lid.putalpha(Image.composite(lid.getchannel('A'), Image.new('L', L['lid'], 0), hole))

    canvas.alpha_composite(lid, L['lid_xy'])

    # The base, seen almost edge-on: a shallow slab, wider than the lid, with a
    # recess cut into the front edge.
    base_w, base_h = L['base']
    base = _gradient((base_w, base_h), BASE_TOP, BASE_BOTTOM).convert('RGBA')
    mask = Image.new('L', (base_w, base_h), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, base_w - 1, base_h - 1],
                         radius=round(base_h * 0.45), fill=255)
    md.rectangle([0, 0, base_w - 1, base_h // 2], fill=255)   # square at the hinge
    nx = L['notch_w'] // 2
    md.rounded_rectangle(
        [base_w // 2 - nx, base_h - round(base_h * 0.72),
         base_w // 2 + nx, base_h + round(base_h * 0.4)],
        radius=round(base_h * 0.35), fill=0)                   # the finger recess
    base.putalpha(mask)
    canvas.alpha_composite(base, (L['pad'], L['pad'] + L['lid'][1]))

    return canvas, L


def place(content: Image.Image, frame: Image.Image, L) -> Image.Image:
    """Drop one screen's worth of content into a prepared frame."""
    out = frame.copy()
    out.alpha_composite(content.convert('RGBA'), L['screen_xy'])
    # The lid is composited again so its rounded screen corners clip the content.
    return out


def wrap_image(src: pathlib.Path, dst: pathlib.Path):
    content = Image.open(src).convert('RGB')
    frame, L = chrome(*content.size)
    canvas = Image.new('RGBA', L['canvas'], (0, 0, 0, 0))
    canvas.alpha_composite(content.convert('RGBA'), L['screen_xy'])
    canvas.alpha_composite(frame)
    canvas.save(dst, optimize=True)
    return dst


def ground_for(name, size):
    """The surface the laptop stands on.

    `transparent` returns None and the caller keeps the alpha channel — but it
    is a trap for this particular job, kept only because it is occasionally the
    right answer for a still. GIF alpha is one bit, and transparency defeats the
    inter-frame compression that makes an animated GIF small: this clip is
    **11.4 MB** transparent against 357 KB on a solid ground. The README ships a
    light and a dark version instead, swapped by `prefers-color-scheme`.
    """
    if name == 'transparent':
        return None
    if name == 'stage':
        return stage(size).convert('RGBA')
    fill = {'light': (255, 255, 255, 255), 'dark': (13, 17, 23, 255)}.get(name)
    if fill is None:
        fill = tuple(int(name.lstrip('#')[i:i + 2], 16) for i in (0, 2, 4)) + (255,)
    return Image.new('RGBA', size, fill)


def wrap_video(src: pathlib.Path, out_mp4: pathlib.Path, out_gif: pathlib.Path,
               gif_width=1000, fps=12, background='light'):
    """Composite every frame into the laptop, then re-encode.

    ffmpeg could overlay a PNG in one pass, but the frame has a transparent
    screen hole and soft shadow edges — compositing in Pillow keeps the alpha
    correct at both, and the cost is a few seconds on a twenty-second clip.
    """
    work = pathlib.Path(tempfile.mkdtemp(prefix='macbook-'))
    try:
        # Extract and re-encode at the SAME rate. Pulling frames at the mp4's own
        # 24 fps and then declaring them 10 fps on the way back in stretched a
        # 22-second clip to 54 without changing a single pixel.
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(src),
                        '-vf', f'fps={fps}', str(work / 'in-%05d.png')], check=True)
        shots = sorted(work.glob('in-*.png'))
        if not shots:
            raise SystemExit('ffmpeg produced no frames')

        with Image.open(shots[0]) as first:
            frame, L = chrome(*first.size, shadow=(background != 'transparent'))

        ground = ground_for(background, L['canvas'])
        mp4_stem = 'mp4' if ground is None else 'out'
        for i, shot in enumerate(shots):
            with Image.open(shot) as content:
                canvas = (ground.copy() if ground is not None
                          else Image.new('RGBA', L['canvas'], (0, 0, 0, 0)))
                canvas.alpha_composite(content.convert('RGBA'), L['screen_xy'])
                canvas.alpha_composite(frame)
            if ground is None:
                # Keep the alpha for the GIF, and write a second, white-backed
                # copy for the mp4: h264 has no alpha channel, and handing
                # ffmpeg transparent frames makes it flatten them onto black.
                canvas.save(work / f'out-{i:05d}.png')
                flat = Image.new('RGB', canvas.size, (255, 255, 255))
                flat.paste(canvas, mask=canvas.getchannel('A'))
                flat.save(work / f'mp4-{i:05d}.png')
            else:
                canvas.convert('RGB').save(work / f'out-{i:05d}.png')

        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(fps),
                        '-i', str(work / f'{mp4_stem}-%05d.png'),
                        '-vf', 'scale=2000:-2:flags=lanczos,format=yuv420p',
                        '-c:v', 'libx264', '-crf', '20', '-preset', 'slow',
                        '-movflags', '+faststart', '-r', '24', str(out_mp4)], check=True)

        # GIF alpha is one bit: a pixel is either fully there or fully gone.
        # reserve_transparent keeps a palette slot for "gone", alpha_threshold
        # decides the cut. Anything soft — the drop shadow especially — has to
        # go, or it bands into a grey halo.
        gif_palette = ':reserve_transparent=1' if background == 'transparent' else ''
        gif_use = ':alpha_threshold=128' if background == 'transparent' else ''
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(fps),
                        '-i', str(work / 'out-%05d.png'),
                        '-vf', f'scale={gif_width}:-2:flags=lanczos,'
                               'split[a][b];'
                               f'[a]palettegen=max_colors=192{gif_palette}[p];'
                               f'[b][p]paletteuse=dither=bayer:bayer_scale=3{gif_use}',
                        '-loop', '0', str(out_gif)], check=True)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return out_mp4, out_gif


def main():
    if len(sys.argv) < 4:
        sys.exit(__doc__.strip().splitlines()[-3].strip())
    mode = sys.argv[1]
    if mode == 'image':
        out = wrap_image(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]))
        print(f'  {out}  {out.stat().st_size // 1024} Ko')
    elif mode == 'video':
        background = sys.argv[5] if len(sys.argv) > 5 else 'light'
        mp4, gif = wrap_video(pathlib.Path(sys.argv[2]),
                              pathlib.Path(sys.argv[3]), pathlib.Path(sys.argv[4]),
                              background=background)
        for f in (mp4, gif):
            print(f'  {f}  {f.stat().st_size // 1024} Ko')
    else:
        sys.exit(f'unknown mode: {mode}')


if __name__ == '__main__':
    main()
