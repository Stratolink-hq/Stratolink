"""The image for the "Flights from a satellite view" post: Stratolink 1 over one GOES-18
GeoColor scan, zoomed out from the figure's 380 km square to a 900 × 562 km frame so the
0.5 km SLIDER imagery is shown near its native resolution.

The track, fan and markers come from the public flight.json, so the launch area stays masked.

    python post_image.py   # → web/public/assets/blog/stratolink-1-coast.jpg
"""

import json

import cartopy.crs as ccrs
import numpy as np
from PIL import Image, ImageDraw

import export as ex

W, H = 2400, 1500
M_PX = 375.0  # map metres per pixel
X0, Y1 = -565_000.0, 291_000.0  # top-left corner in the figure's map coordinates
SCAN = "s20262962106188"  # 2:06 p.m., just before the figure's last frame
SS = 2  # overlay supersampling
OUT = ex.SITE_ASSETS.parents[1] / "blog" / "stratolink-1-coast.jpg"

TRACK, CASING, FAN = (255, 206, 0), (0, 0, 0, 90), (154, 214, 242, 72)


def scan_angles():
    xs = X0 + (np.arange(W) + 0.5) * M_PX
    ys = Y1 - (np.arange(H) + 0.5) * M_PX
    X, Y = np.meshgrid(xs, ys)
    lonlat = ccrs.PlateCarree().transform_points(ex.MAP_CRS, X, Y)
    gx, gy = ex.GOES_PROJ(lonlat[..., 0], lonlat[..., 1])
    return gx / 35_786_023.0, gy / 35_786_023.0


def to_px(u, v):
    """The figure's 0–1 map coordinates to overlay pixels."""
    x, y = u * 2 * ex.HALF_M - ex.HALF_M, ex.HALF_M - v * 2 * ex.HALF_M
    return (x - X0) / M_PX * SS, (Y1 - y) / M_PX * SS


def dashed(draw, pts, fill, width, dash, gap):
    """A dashed polyline, with the pattern carried across vertices."""
    on, left = True, dash
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        seg = np.hypot(x1 - x0, y1 - y0)
        at = 0.0
        while at < seg:
            step = min(left, seg - at)
            a, b = at / seg, (at + step) / seg
            if on:
                draw.line([(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a), (x0 + (x1 - x0) * b, y0 + (y1 - y0) * b)],
                          fill=fill, width=width)
            at += step
            left -= step
            if left <= 0:
                on = not on
                left = dash if on else gap


def dot(draw, xy, r, fill, outline=None, width=0):
    x, y = xy
    draw.ellipse([x - r, y - r, x + r, y + r], fill=fill, outline=outline, width=width)


def overlay(data):
    layer = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer, "RGBA")
    for path in data["fan"]["paths"]:
        draw.line([to_px(u, v) for u, v in path], fill=FAN, width=2 * SS, joint="curve")

    f = data["frames"]
    pts = [to_px(u, v) for u, v in zip(f["u"], f["v"])]
    gps = [p for p, m in zip(pts, f["mode"]) if m == "gps"]
    after = pts[len(gps) - 1:]
    w, cw = int(6 * SS), int(11 * SS)
    draw.line(gps, fill=CASING, width=cw, joint="curve")
    dashed(draw, after, CASING, cw, 15 * SS, 11 * SS)
    draw.line(gps, fill=TRACK, width=w, joint="curve")
    dashed(draw, after, TRACK, w, 15 * SS, 11 * SS)

    ev, launch = data["events"], data["launch"]
    dot(draw, to_px(launch["u"], launch["v"]), 9 * SS, TRACK, (20, 20, 19), 3 * SS)
    dot(draw, to_px(ev["lastFix"]["u"], ev["lastFix"]["v"]), 7 * SS, TRACK)
    dot(draw, to_px(ev["lastPacket"]["u"], ev["lastPacket"]["v"]), 8 * SS, (20, 20, 19), TRACK, 3 * SS)
    return layer.resize((W, H), Image.LANCZOS)


def main():
    data = json.loads((ex.SITE_ASSETS / "flight.json").read_text())
    x, y = ex.band2_grid(None, None)  # cached from the figure's export
    sx, sy = scan_angles()
    rgb = ex.geocolor(ex.scan_time(SCAN), x, y, sx, sy)
    if rgb is None:
        raise SystemExit(f"SLIDER no longer has scan {SCAN}")
    image = Image.fromarray(rgb).convert("RGBA")
    image.alpha_composite(overlay(data))
    image.convert("RGB").save(OUT, quality=82, optimize=True, progressive=True)
    print(OUT, image.size)


if __name__ == "__main__":
    main()
