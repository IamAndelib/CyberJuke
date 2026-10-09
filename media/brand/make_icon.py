"""Generate CyberJuke's pixel-art jukebox icon (cream on black) at all Android sizes.

Run: python3 media/brand/make_icon.py   (needs Pillow). Outputs launcher icons, splash
screens, media/brand/icon.png and media/brand/banner.png.
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
CREAM = (239, 229, 192, 255)
DIM = (168, 153, 132, 255)
AMBER = (232, 160, 64, 255)
BLACK = (0, 0, 0, 255)
CLEAR = (0, 0, 0, 0)

# 24 x 24 pixel art. C = cream, d = dim, a = amber, . = transparent
ART = """
........CCCCCCCC........
......CCC......CCC......
.....CC..CCCCCC..CC.....
....CC.CC......CC.CC....
...CC.C...dddd...C.CC...
...C.C...d....d...C.C...
..CC.C..d..aa..d..C.CC..
..C.C...d.a..a.d...C.C..
..C.C...d.a..a.d...C.C..
..C.C...d..aa..d...C.C..
..C.C....d....d....C.C..
..C.C.....dddd.....C.C..
..C.CCCCCCCCCCCCCCCC.C..
..C..................C..
..C.CCCCCCCCCCCCCCCC.C..
..C.C.C.C.C.C.C.C.CC.C..
..C.CC.C.C.C.C.C.C.C.C..
..C.C.C.C.C.C.C.C.CC.C..
..C.CCCCCCCCCCCCCCCC.C..
..C......aa..aa......C..
..CCCCCCCCCCCCCCCCCCCC..
..C..................C..
..CCCC............CCCC..
........................
""".strip("\n").splitlines()
COLORS = {"C": CREAM, "d": DIM, "a": AMBER}
N = len(ART)
assert all(len(r) == N for r in ART), [len(r) for r in ART]


def art(scale: int) -> Image.Image:
    im = Image.new("RGBA", (N * scale, N * scale), CLEAR)
    px = im.load()
    for y, row in enumerate(ART):
        for x, ch in enumerate(row):
            if ch in COLORS:
                for dy in range(scale):
                    for dx in range(scale):
                        px[x * scale + dx, y * scale + dy] = COLORS[ch]
    return im


def canvas(size: int, art_frac: float, bg=BLACK, round_mask=False) -> Image.Image:
    im = Image.new("RGBA", (size, size), bg)
    scale = max(1, int(size * art_frac) // N)
    a = art(scale)
    off = ((size - a.width) // 2, (size - a.height) // 2)
    im.alpha_composite(a, off)
    if round_mask:
        from PIL import ImageDraw
        m = Image.new("L", (size, size), 0)
        ImageDraw.Draw(m).ellipse((0, 0, size - 1, size - 1), fill=255)
        out = Image.new("RGBA", (size, size), CLEAR)
        out.paste(im, (0, 0), m)
        return out
    return im


DENS = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
res = ROOT / "android/app/src/main/res"
for d, f in DENS.items():
    legacy = int(48 * f)
    fg = int(108 * f)
    canvas(legacy, 0.80).save(res / f"mipmap-{d}/ic_launcher.png")
    canvas(legacy, 0.72, round_mask=True).save(res / f"mipmap-{d}/ic_launcher_round.png")
    # adaptive foreground: art inside the 72dp safe zone (~0.6 of 108dp)
    canvas(fg, 0.56, bg=CLEAR).save(res / f"mipmap-{d}/ic_launcher_foreground.png")

# Splash screens: black with the jukebox centered (sizes match Capacitor's defaults).
for p in res.glob("drawable*/splash.png"):
    w, h = Image.open(p).size
    im = Image.new("RGBA", (w, h), BLACK)
    a = art(max(2, min(w, h) // 3 // N))
    im.alpha_composite(a, ((w - a.width) // 2, (h - a.height) // 2))
    im.convert("RGB").save(p)

media = ROOT / "media/brand"
canvas(512, 0.80).save(media / "icon.png")

# Banner: 1280x640, icon left, checkerboard shadow strip.
W, H = 1280, 640
b = Image.new("RGBA", (W, H), BLACK)
px = b.load()
for y in range(H - 40, H):
    for x in range(W):
        if (x // 4 + y // 4) % 2 == 0:
            px[x, y] = DIM
a = art(16)
b.alpha_composite(a, (120, (H - 40 - a.height) // 2))
from PIL import ImageDraw, ImageFont
d = ImageDraw.Draw(b)
fonts = ROOT / "public/fonts"
big = ImageFont.truetype(str(fonts / "departure-mono-regular.woff2"), 120)
small = ImageFont.truetype(str(fonts / "jetbrains-mono-latin-400-normal.woff2"), 36)
d.text((560, 180), "CYBERJUKE", font=big, fill=CREAM)
d.text((566, 340), "The Cyberspace Jukebox,", font=small, fill=DIM)
d.text((566, 390), "as a music app for Android.", font=small, fill=DIM)
b.convert("RGB").save(media / "banner.png")
print("ok")
