"""Draws the NoteAI icon (notepad + AI sparkle) and writes assets/icon.ico and assets/icon.png."""
import math
import os

from PIL import Image, ImageChops, ImageDraw, ImageFilter

S = 1024  # drawing size; downscaled for every icon size
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "assets")


def vertical_gradient(size, top, bottom):
    w, h = size
    grad = Image.new("RGBA", (1, h))
    for y in range(h):
        t = y / max(1, h - 1)
        grad.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,))
    return grad.resize((w, h))


def diagonal_gradient(size, stops, box):
    w, h = size
    x0, y0, x1, y1 = box
    img = Image.new("RGBA", size)
    px = img.load()
    for y in range(h):
        for x in range(w):
            t = min(1.0, max(0.0, ((x - x0) + (y - y0)) / ((x1 - x0) + (y1 - y0))))
            for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
                if t0 <= t <= t1:
                    k = (t - t0) / (t1 - t0)
                    px[x, y] = tuple(round(a + (b - a) * k) for a, b in zip(c0, c1)) + (255,)
                    break
    return img


def sparkle_points(cx, cy, r, exponent=2.6, steps=240):
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        pts.append((cx + r * math.copysign(abs(c) ** exponent, c), cy + r * math.copysign(abs(s) ** exponent, s)))
    return pts


def mask_from(draw_fn):
    m = Image.new("L", (S, S), 0)
    draw_fn(ImageDraw.Draw(m))
    return m


def paste_fill(base, fill, mask):
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    layer.paste(fill, (0, 0), mask)
    base.alpha_composite(layer)


def draw():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    page = (150, 120, 820, 930)
    radius = 110

    # soft shadow
    shadow = mask_from(lambda d: d.rounded_rectangle((page[0] + 10, page[1] + 30, page[2] + 10, page[3] + 30), radius, fill=120))
    paste_fill(img, Image.new("RGBA", (S, S), (10, 20, 50, 255)), shadow.filter(ImageFilter.GaussianBlur(28)))

    # page body
    body = mask_from(lambda d: d.rounded_rectangle(page, radius, fill=255))
    paste_fill(img, vertical_gradient((S, S), (255, 255, 255), (236, 241, 250)), body)

    # blue header band, clipped to the page's rounded top
    band = ImageChops.multiply(body, mask_from(lambda d: d.rectangle((0, 0, S, 330), fill=255)))
    paste_fill(img, vertical_gradient((S, S), (86, 156, 255), (37, 99, 235)), band)

    # spiral binding rings
    d = ImageDraw.Draw(img)
    for x in (290, 420, 550, 680):
        d.rounded_rectangle((x - 30, 62, x + 30, 205), 30, fill=(30, 58, 138, 255))
        d.rounded_rectangle((x - 14, 78, x + 14, 189), 14, fill=(219, 232, 255, 255))

    # text lines
    for y, length in ((440, 470), (545, 400), (650, 300), (755, 210)):
        d.rounded_rectangle((250, y, 250 + length, y + 44), 22, fill=(178, 192, 219, 255))

    # AI sparkle with a white halo so it reads on any taskbar color
    big = sparkle_points(715, 735, 255, exponent=3.0)
    small = sparkle_points(920, 470, 92, exponent=3.0)
    halo = mask_from(lambda m: (m.polygon(big, fill=255), m.polygon(small, fill=255))).filter(ImageFilter.MaxFilter(41))
    paste_fill(img, Image.new("RGBA", (S, S), (255, 255, 255, 255)), halo)
    star = mask_from(lambda m: (m.polygon(big, fill=255), m.polygon(small, fill=255)))
    paste_fill(img, diagonal_gradient((S, S), [(0.0, (139, 92, 246)), (0.5, (236, 72, 153)), (1.0, (251, 146, 60))], (460, 380, 1015, 990)), star)
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    art = draw()
    sizes = [256, 128, 64, 48, 40, 32, 24, 20, 16]
    images = [art.resize((s, s), Image.LANCZOS) for s in sizes]
    images[0].save(os.path.join(OUT, "icon.ico"), sizes=[(s, s) for s in sizes], append_images=images[1:])
    art.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "icon.png"))
    preview = Image.new("RGBA", (620, 300), (32, 32, 32, 255))
    x = 10
    for s in (256, 128, 64, 48, 32, 24, 16):
        preview.alpha_composite(art.resize((s, s), Image.LANCZOS), (x, 20))
        x += s + 12
    x = 10
    for s in (64, 48, 32, 24, 16):
        light = Image.new("RGBA", (s + 12, s + 12), (243, 243, 243, 255))
        light.alpha_composite(art.resize((s, s), Image.LANCZOS), (6, 6))
        preview.alpha_composite(light, (x, 200))
        x += s + 24
    preview.save(os.path.join(OUT, "icon-preview.png"))
    print("wrote", os.path.abspath(OUT))


if __name__ == "__main__":
    main()
