#!/usr/bin/env python3
"""Build App Store screenshots from the audited Google Play web-demo captures."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "store-assets" / "google-play" / "phone-screenshots"
OUTPUT_ROOT = ROOT / "store-assets" / "app-store"
OUTPUT_DIR = OUTPUT_ROOT / "iphone-6.9-screenshots"
ICON_PATH = ROOT / "assets" / "images" / "icon.png"

WIDTH = 1290
HEIGHT = 2796
POSTER_WIDTH = 1160
POSTER_HEIGHT = POSTER_WIDTH * 16 // 9
POSTER_X = (WIDTH - POSTER_WIDTH) // 2
POSTER_Y = 150
RADIUS = 30

BOLD_FONT = "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf"
MONO_FONT = "/usr/share/fonts/truetype/noto/NotoSansMono-Regular.ttf"


def mix(start: tuple[int, int, int], end: tuple[int, int, int], amount: float):
    return tuple(round(left + (right - left) * amount) for left, right in zip(start, end))


def background() -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT))
    draw = ImageDraw.Draw(image)
    top = (5, 19, 33)
    bottom = (9, 43, 48)
    for y in range(HEIGHT):
        progress = y / (HEIGHT - 1)
        draw.line((0, y, WIDTH, y), fill=mix(top, bottom, progress))
    glow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(
        (WIDTH * 0.15, HEIGHT * 0.25, WIDTH * 1.25, HEIGHT * 0.9),
        fill=(14, 67, 66, 78),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(190))
    return Image.alpha_composite(image.convert("RGBA"), glow).convert("RGB")


def rounded(image: Image.Image, radius: int) -> Image.Image:
    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, image.width, image.height), radius, fill=255)
    result = image.convert("RGBA")
    result.putalpha(mask)
    return result


def build(source: Path, destination: Path):
    canvas = background()
    poster = Image.open(source).convert("RGB").resize(
        (POSTER_WIDTH, POSTER_HEIGHT), Image.Resampling.LANCZOS
    )
    poster = rounded(poster, RADIUS)

    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle(
        (
            POSTER_X - 14,
            POSTER_Y - 4,
            POSTER_X + POSTER_WIDTH + 14,
            POSTER_Y + POSTER_HEIGHT + 34,
        ),
        RADIUS + 14,
        fill=(0, 0, 0, 145),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(34))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow)
    canvas.alpha_composite(poster, (POSTER_X, POSTER_Y))

    icon = Image.open(ICON_PATH).convert("RGBA").resize((104, 104), Image.Resampling.LANCZOS)
    title_font = ImageFont.truetype(BOLD_FONT, 48)
    detail_font = ImageFont.truetype(MONO_FONT, 22)
    title = "TELEMOB"
    detail = "UNOFFICIAL  •  OPEN SOURCE  •  MOBILE SSH"

    draw = ImageDraw.Draw(canvas)
    title_box = draw.textbbox((0, 0), title, font=title_font)
    detail_box = draw.textbbox((0, 0), detail, font=detail_font)
    text_width = max(title_box[2], detail_box[2])
    group_width = icon.width + 32 + text_width
    group_x = (WIDTH - group_width) // 2
    group_y = POSTER_Y + POSTER_HEIGHT + 150

    canvas.alpha_composite(icon, (group_x, group_y))
    text_x = group_x + icon.width + 32
    draw.text((text_x, group_y + 2), title, font=title_font, fill=(245, 242, 233, 255))
    draw.text((text_x, group_y + 68), detail, font=detail_font, fill=(135, 158, 167, 255))

    line_y = group_y + 142
    draw.line((group_x, line_y, group_x + group_width, line_y), fill=(103, 218, 194, 150), width=2)

    destination.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(destination, "PNG", optimize=True)


def preview(files: list[Path]):
    thumb_width = 276
    thumb_height = round(thumb_width * HEIGHT / WIDTH)
    gap = 24
    margin = 30
    preview_width = margin * 2 + thumb_width * 3 + gap * 2
    preview_height = margin * 2 + thumb_height * 2 + gap
    image = Image.new("RGB", (preview_width, preview_height), (4, 17, 29))
    for index, path in enumerate(files):
        thumb = Image.open(path).convert("RGB").resize(
            (thumb_width, thumb_height), Image.Resampling.LANCZOS
        )
        x = margin + (index % 3) * (thumb_width + gap)
        y = margin + (index // 3) * (thumb_height + gap)
        image.paste(thumb, (x, y))
    image.save(OUTPUT_ROOT / "iphone-6.9-screenshots-preview.png", "PNG", optimize=True)


def main():
    sources = sorted(SOURCE_DIR.glob("*.png"))
    if len(sources) != 6:
        raise SystemExit(f"Expected six source screenshots, found {len(sources)}")
    outputs = []
    for source in sources:
        destination = OUTPUT_DIR / source.name
        build(source, destination)
        outputs.append(destination)
    preview(outputs)
    for output in outputs:
        print(output.relative_to(ROOT))


if __name__ == "__main__":
    main()
