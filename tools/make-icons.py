"""
make-icons: every B-Side icon, from one square picture.

    python3 tools/make-icons.py [tools/icon-source.png]

The source is a square render (1024 or larger) with the art edge to edge and no
corners of its own. From it:

  mobile/ios/.../AppIcon-512@2x.png  1024 square, opaque. iOS cuts its own
                                     rounded corners and refuses an icon with
                                     alpha, so this one is never rounded.
  public/apple-touch-icon.png        180 square, opaque: "Add to Home Screen"
                                     in Safari, which also rounds it itself.
  public/icon.png                    512, Apple's continuous corners (a
                                     superellipse, not a rounded rectangle),
                                     transparent outside: the browser tab and
                                     the window icon on Windows and Linux.
  public/icon-mac.png                1024 on macOS's icon grid: the rounded
                                     shape at 824 px, centred, with the soft
                                     shadow every Dock icon has.

Files in public/ are copied into each web build, so the hub serves them and the
desktop app finds them beside index.html. Needs Pillow.
"""
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'tools', 'icon-source.png')
IOS = os.path.join(ROOT, 'mobile', 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'AppIcon-512@2x.png')
PUBLIC = os.path.join(ROOT, 'public')

# The mask is drawn this many times larger, then scaled down, for a smooth edge.
SUPERSAMPLE = 4
# 5 is close to the curve Apple's icon mask follows.
EXPONENT = 5.0
# macOS: an 824 px shape on a 1024 canvas, a little lower than centre for its shadow.
MAC_SHAPE, MAC_SHADOW_DROP, MAC_SHADOW_BLUR, MAC_SHADOW_ALPHA = 824, 12, 14, 110


def squircle(size: int) -> Image.Image:
    big = size * SUPERSAMPLE
    r = big / 2
    points = []
    for i in range(2000):
        t = 2 * math.pi * i / 2000
        c, s = math.cos(t), math.sin(t)
        points.append((r + r * math.copysign(abs(c) ** (2 / EXPONENT), c),
                       r + r * math.copysign(abs(s) ** (2 / EXPONENT), s)))
    mask = Image.new('L', (big, big), 0)
    ImageDraw.Draw(mask).polygon(points, fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def rounded(art: Image.Image, size: int) -> Image.Image:
    out = art.resize((size, size), Image.LANCZOS).convert('RGBA')
    out.putalpha(squircle(size))
    return out


def mac(art: Image.Image) -> Image.Image:
    inset = (1024 - MAC_SHAPE) // 2
    shadow = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
    dark = Image.new('RGBA', (MAC_SHAPE, MAC_SHAPE), (0, 0, 0, 255))
    dark.putalpha(squircle(MAC_SHAPE).point(lambda a: a * MAC_SHADOW_ALPHA // 255))
    shadow.paste(dark, (inset, inset + MAC_SHADOW_DROP), dark)
    shadow = shadow.filter(ImageFilter.GaussianBlur(MAC_SHADOW_BLUR))
    shape = rounded(art, MAC_SHAPE)
    shadow.paste(shape, (inset, inset), shape)
    return shadow


def main() -> None:
    art = Image.open(SOURCE).convert('RGB')
    if art.width != art.height or art.width < 1024:
        sys.exit(f'{SOURCE} is {art.width}x{art.height}; it needs to be square and at least 1024.')
    os.makedirs(PUBLIC, exist_ok=True)
    art.resize((1024, 1024), Image.LANCZOS).save(IOS)
    art.resize((180, 180), Image.LANCZOS).save(os.path.join(PUBLIC, 'apple-touch-icon.png'))
    rounded(art, 512).save(os.path.join(PUBLIC, 'icon.png'))
    mac(art).save(os.path.join(PUBLIC, 'icon-mac.png'))
    print(f'icons written from {os.path.relpath(SOURCE, ROOT)}')


if __name__ == '__main__':
    main()
