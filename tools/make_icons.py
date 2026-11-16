"""Genera los iconos PNG de la PWA. Solo hace falta ejecutarlo si se quiere cambiar el icono.

Uso (requiere Pillow):  python3 tools/make_icons.py

Los iconos son cuadrados opacos a sangre completa (iOS no admite transparencia en el
icono de la pantalla de inicio) y el dibujo queda dentro de la zona segura "maskable".
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "icons"
BG = (15, 118, 110)  # #0f766e
FG = (255, 255, 255)
FONTS = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def font(size):
    for path in FONTS:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    raise SystemExit("No se encontró una fuente TrueType; ajusta FONTS.")


def make(size, name):
    scale = 4  # se dibuja grande y se reduce para suavizar bordes
    s = size * scale
    img = Image.new("RGB", (s, s), BG)
    draw = ImageDraw.Draw(img)
    f = font(int(s * 0.44))
    box = draw.textbbox((0, 0), "S/", font=f)
    x = (s - (box[2] - box[0])) / 2 - box[0]
    y = (s - (box[3] - box[1])) / 2 - box[1]
    draw.text((x, y), "S/", font=f, fill=FG)
    img.resize((size, size), Image.LANCZOS).save(OUT / name, optimize=True)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    make(180, "apple-touch-icon.png")
    make(192, "icon-192.png")
    make(512, "icon-512.png")
    print("Iconos generados en", OUT)
