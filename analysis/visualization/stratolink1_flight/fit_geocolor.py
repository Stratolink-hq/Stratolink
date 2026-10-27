"""Learn how CIRA's GeoColor turns GOES-18 bands into color, for Stratolink 3's imagery.

SLIDER only keeps GeoColor for about three months, so May's is gone. But a recent scan has
both: GeoColor on SLIDER and the raw bands on NOAA's S3 bucket. This puts the two on
stratolink3.py's map grid, takes the daylit pixels (sun zenith under 65°),
and fits each GeoColor channel as a cubic polynomial in the log of the Rayleigh-corrected red,
synthetic green and blue that stratolink3.py computes. stratolink3.py applies the fit
(geocolor_fit.json) to May's scans in place of a hand-made tone curve.

    python fit_geocolor.py 2026-10-26T20:00
"""
from __future__ import annotations

import io
import json
import sys
from itertools import combinations_with_replacement
from pathlib import Path

import numpy as np
import pandas as pd
import requests
import s3fs
import matplotlib.pyplot as plt
from scipy.ndimage import gaussian_filter, map_coordinates

import stratolink3 as s3
from export import CACHE, band2_grid

OUT = Path(__file__).parent / "geocolor_fit.json"
SLIDER = "https://slider.cira.colostate.edu/data/imagery"
TILE, ZOOM, PAD_ROWS = 625, 3, 1000  # zoom 3: the CONUS sector at 1 km, padded to a 5000 px square
MAX_SUNZ = 65


def features(lin: np.ndarray, lo=None, hi=None) -> np.ndarray:
    """Cubic monomials of log reflectance, (n, 20). With lo and hi, each log reflectance is held
    inside the range the fit saw: over dark forest the Rayleigh correction can take blue to
    zero, and the cubic, extrapolating, would turn it bright green."""
    x = np.log(np.clip(lin.reshape(-1, 3), 0.005, 1.5))
    if lo is not None:
        x = np.clip(x, lo, hi)
    cols = [np.ones(len(x))]
    for d in (1, 2, 3):
        for combo in combinations_with_replacement(range(3), d):
            cols.append(np.prod(x[:, combo], axis=1))
    return np.stack(cols, 1)


def apply(fit: dict, lin: np.ndarray) -> np.ndarray:
    x = features(lin, np.array(fit["lo"]), np.array(fit["hi"]))
    return np.clip(x @ np.array(fit["coef"]), 0, 1).reshape(lin.shape)


def slider_geocolor(when: pd.Timestamp, img: s3.Imagery, fs):
    """The SLIDER GeoColor scan nearest `when`, on the map grid, with a mask of where it exists."""
    key = sorted(k for k in fs.ls(f"noaa-goes18/ABI-L2-CMIPC/{when:%Y/%j/%H}") if "M6C02" in k)[0]
    token = key.rsplit("/", 1)[-1].split("_")[3]
    start = s3.scan_time(token)
    x, y = band2_grid(fs, key)
    col = (img.sx - x[0]) / (x[1] - x[0]) / 2  # 0.5 km columns to zoom 3's 1 km
    row = ((img.sy - y[0]) / (y[1] - y[0]) + 2 * PAD_ROWS) / 2
    inside = (col >= 0) & (col < len(x) / 2) & (row >= PAD_ROWS) & (row < PAD_ROWS + len(y) / 2)
    r0, r1 = int(row[inside].min()) // TILE, int(row[inside].max()) // TILE
    c0, c1 = int(col[inside].min()) // TILE, int(col[inside].max()) // TILE
    mosaic = np.zeros(((r1 - r0 + 1) * TILE, (c1 - c0 + 1) * TILE, 3), np.float32)
    for r in range(r0, r1 + 1):
        for c in range(c0, c1 + 1):
            url = f"{SLIDER}/{start:%Y/%m/%d}/goes-18---conus/geocolor/{start:%Y%m%d%H%M%S}/{ZOOM:02d}/{r:03d}_{c:03d}.png"
            resp = requests.get(url, timeout=60)
            resp.raise_for_status()
            mosaic[(r - r0) * TILE:(r - r0 + 1) * TILE, (c - c0) * TILE:(c - c0 + 1) * TILE] = plt.imread(io.BytesIO(resp.content), format="png")[..., :3]
    rgb = np.dstack([map_coordinates(mosaic[..., k], [row - r0 * TILE, col - c0 * TILE], order=1, mode="nearest") for k in range(3)])
    return rgb, inside, start


def main(when: str):
    when = pd.Timestamp(when, tz="UTC")
    fs = s3fs.S3FileSystem(anon=True)
    img = s3.Imagery()
    geo, inside, start = slider_geocolor(when, img, fs)
    # The raw full-disk scan closest to the SLIDER one.
    hour = f"{s3.BUCKET}/{when:%Y/%j/%H}"
    item = min(((s3.scan_time(k.rsplit('/', 1)[-1].split('_')[3]).timestamp(), k.rsplit('/', 1)[-1].split('_')[3], k)
                for k in fs.ls(hour)), key=lambda s: abs(s[0] - start.timestamp()))
    g = img.bands(fs, item)
    lin, sunz = img.day_linear(item[0], g)
    # GeoColor's red is 0.5 km; soften it to our 2 km bands so the fit isn't chasing detail we lack.
    geo = np.dstack([gaussian_filter(geo[..., k], 1.2) for k in range(3)])
    use = inside & (sunz < MAX_SUNZ) & (geo.sum(2) > 0.02)
    use &= np.random.default_rng(0).random(use.shape) < 0.5
    logs = np.log(np.clip(lin[use], 0.005, 1.5))
    lo, hi = np.percentile(logs, 0.5, axis=0), np.percentile(logs, 99.5, axis=0)
    X, Y = features(lin[use], lo, hi), geo[use]
    coef, *_ = np.linalg.lstsq(X, Y, rcond=None)
    err = np.abs(X @ coef - Y).mean(0)
    print(f"fit on {use.sum()} pixels from {start:%Y-%m-%d %H:%M} UTC; mean abs error per channel {np.round(err * 255, 1)} (of 255)")
    fit = {"scan": f"{start:%Y-%m-%dT%H:%M:%S}Z", "max_sunz": MAX_SUNZ, "lo": np.round(lo, 4).tolist(),
           "hi": np.round(hi, 4).tolist(), "coef": np.round(coef, 6).tolist()}
    OUT.write_text(json.dumps(fit, indent=1))
    print(f"Wrote {OUT}")
    plt.imsave(CACHE.parent / "geocolor_fit_check.png", np.clip(np.concatenate([geo * inside[..., None], apply(fit, lin)], 1), 0, 1))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "2026-10-26T20:00")
