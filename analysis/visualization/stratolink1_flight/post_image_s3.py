"""The image for the "Flights from a satellite view" post: Stratolink 3 from San Francisco past
Baja to New Mexico (May 17–19, 2026), over one GOES-18 scan at midday on May 18, made as in
stratolink3.py (2 km full disk, colors graded toward GeoColor, sharpened with the 0.5 km red band)
on a 16:10 frame around the whole track.

The track is drawn as in the figure: solid where GPS fixed it, dashed where it is estimated (the
dashboard's wind reconstruction through the gaps). Only public data is used.

    python post_image_s3.py   # → web/public/assets/blog/stratolink-3-southwest.jpg
"""

import numpy as np
import pandas as pd
import s3fs
import cartopy.crs as ccrs
from PIL import Image, ImageDraw

import stratolink3 as s3
from post_image import CASING, TRACK, dashed, dot

W, H = 2400, 1500
# A 16:10 frame, in stratolink3's map projection, around the track with a margin.
s3.X0, s3.X1, s3.Y0, s3.Y1 = -1_070_000, 1_060_000, -641_000, 690_000
s3.GRID_W, s3.GRID_H, s3.GRID_TAG = W, H, f"s3hdr_{W}_{s3.X0}_{s3.Y1}"  # the scan cache is per frame
SCAN = pd.Timestamp("2026-05-18T20:00Z")  # 1 p.m. PDT: cloud off Baja and over the Four Corners
SS = 2  # overlay supersampling
OUT = s3.OUT.parents[1] / "blog" / "stratolink-3-southwest.jpg"


def to_px(lon, lat):
    x, y = s3.MAP_CRS.transform_point(float(lon), float(lat), ccrs.PlateCarree())
    return (x - s3.X0) / (s3.X1 - s3.X0) * W * SS, (s3.Y1 - y) / (s3.Y1 - s3.Y0) * H * SS


def overlay(track):
    layer = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer, "RGBA")
    ts = sorted({*np.arange(track.fixes[0, 0], s3.END.timestamp(), 300.0).tolist(), *track.fixes[:, 0].tolist()})
    runs = []
    for t in ts:
        solid = track.mode(t) == "gps"
        p = to_px(*track.at(t)[::-1])
        if runs and runs[-1][0] == solid:
            runs[-1][1].append(p)
        else:
            if runs:
                runs[-1][1].append(p)
            runs.append((solid, [p]))
    w, cw = 6 * SS, 11 * SS
    for colour, width in ((CASING, cw), (TRACK, w)):
        for solid, pts in runs:
            if solid:
                draw.line(pts, fill=colour, width=width, joint="curve")
            else:
                dashed(draw, pts, colour, width, 15 * SS, 11 * SS)
    dot(draw, to_px(*track.fixes[0, 1:][::-1]), 9 * SS, TRACK, (20, 20, 19), 3 * SS)
    dot(draw, to_px(*track.fixes[-1, 1:][::-1]), 7 * SS, TRACK)
    end = to_px(*track.at(track.packet_t[-1])[::-1])
    dot(draw, end, 8 * SS, (20, 20, 19), TRACK, 3 * SS)
    return layer.resize((W, H), Image.LANCZOS)


def main():
    track = s3.Track(*s3.fetch())
    fs = s3fs.S3FileSystem(anon=True)
    item = min(s3.list_scans(fs), key=lambda s: abs(s[0] - SCAN.timestamp()))
    rgb = s3.Imagery().composite(fs, item)[0]
    image = Image.fromarray(rgb).convert("RGBA")
    image.alpha_composite(overlay(track))
    image.convert("RGB").save(OUT, quality=82, optimize=True, progressive=True)
    print(OUT, image.size, pd.Timestamp(item[0], unit="s"))


if __name__ == "__main__":
    main()
