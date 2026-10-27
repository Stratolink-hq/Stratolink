"""Stratolink 3 from launch to just past Albuquerque (May 17–19, 2026), for the second flight
figure in "Flights from a satellite view". Writes the figure's data and backgrounds straight
into the site:

    web/public/assets/flights/stratolink-3/flight.json
    web/public/assets/flights/stratolink-3/background-geocolor.mp4   satellite
    web/public/assets/flights/stratolink-3/background-map.mp4        paper map, clouds, night

Only what the public dashboard shows is used: telemetry from its API (launch-area positions
masked) and its wind reconstruction through the gaps (/api/forecast?view=history).

Track. A fix is a GPS position that differs from the one before; from 18:20 to 22:46 UTC on
May 17 the receiver repeated one position while the balloon kept climbing, and those repeats
are not fixes. Fixes under two hours apart are joined with straight lines. Longer gaps follow
the dashboard's wind reconstruction, except where the reconstruction itself is built on the
repeated position; there the line runs straight between the fixes either side. Altitude comes
from pressure (standard atmosphere), since the GPS altitude froze with the position.

Imagery. SLIDER and GIBS no longer hold GeoColor for May, so this builds its own from the
GOES-18 full disk on NOAA's S3 bucket (ABI-L2-MCMIPF, all bands at 2 km, every 10 minutes):
true color by day, infrared cloud by night over a dark land and sea, blended across twilight.
The day side is Rayleigh corrected with pyspectral, as in Satpy's true color, then graded to
look like CIRA's GeoColor: a log stretch with per-channel black points (a near-black ocean), a
synthetic green with little near-infrared, per-channel gammas fitted so desert land matches
GeoColor's mean color (from a SLIDER image of the same region, Oct. 26, 2026) and a gentle
S-curve, all dialed about halfway back toward neutral. Only the compressed chunks over the map are fetched. Frames
every 5 minutes; Scans (export.py) moves the clouds between scans. Needs pyspectral, which
downloads its spectral responses and Rayleigh tables on first use.

    python stratolink3.py              # data and both backgrounds
    python stratolink3.py --json-only
    python stratolink3.py --test       # three composites as PNGs in ../output, for tuning
"""
from __future__ import annotations

import json
import math
import subprocess
import zlib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import requests
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import cartopy.crs as ccrs
import cartopy.feature as cfeature
import h5py
import pyproj
import s3fs
from scipy.ndimage import gaussian_filter, map_coordinates, median_filter

from export import CACHE, GOES_PROJ, SEA, LAND, COAST, SHADOW, Scans, clock, over, scan_time, smoothstep

DEVICE = "stratolink-3"
START = pd.Timestamp("2026-05-17T15:30:00Z")
END = pd.Timestamp("2026-05-20T00:00:00Z")  # half an hour after the last packet of May 19
SITE = "https://stratolink.org"
OUT = Path(__file__).resolve().parents[3] / "web" / "public" / "assets" / "flights" / "stratolink-3"
STEP_S, FPS = 300.0, 24  # five minutes of flight per frame
GPS_GAP_S = 2 * 3600  # fixes closer than this are joined with a straight line
HEARD_S = 30 * 60  # a packet within this long means the balloon is still being heard

# Map: Lambert conformal, San Francisco to past Albuquerque and down to the loop off Baja.
MAP_CRS = ccrs.LambertConformal(central_longitude=-113.6, central_latitude=32.8, standard_parallels=(29.5, 36.5))
X0, X1, Y0, Y1 = -850_000, 880_000, -710_000, 662_000  # metres
GRID_W = 1200
GRID_H = round(GRID_W * (Y1 - Y0) / (X1 - X0))
GRID_TAG = f"s3_{GRID_W}"
GEOD = pyproj.Geod(ellps="WGS84")
TZ = "America/Los_Angeles"

CITIES = [("Los Angeles", 34.0522, -118.2437), ("San Diego", 32.7157, -117.1611), ("Las Vegas", 36.1699, -115.1398),
          ("Phoenix", 33.4484, -112.0740), ("Tucson", 32.2226, -110.9747), ("Hermosillo", 29.0729, -110.9559),
          ("Albuquerque", 35.0844, -106.6504)]
OCEAN = [(-121.2, 30.8), (-120.6, 29.0), (-119.5, 28.2)]  # candidate spots for the ocean label

BUCKET = "noaa-goes18/ABI-L2-MCMIPF"
BANDS = ("C01", "C02", "C03", "C13")
NIGHT_SEA, NIGHT_LAND = np.array([0.035, 0.065, 0.11]), np.array([0.075, 0.08, 0.09])


# ── telemetry ────────────────────────────────────────────────────────────────

def fetch():
    fields = "time,lat,lon,altitude_m,pressure,gps_speed,gps_heading,temperature,ambient_lux,uv_index,rssi,gateways"
    r = requests.get(f"{SITE}/api/telemetry", params={"resource": "telemetry", "device_id": f"eq.{DEVICE}", "select": fields,
                                                      "time": f"gte.{START.isoformat()}", "order": "time.asc", "limit": "1000"}, timeout=30)
    r.raise_for_status()
    df = pd.DataFrame(r.json())
    df["time"] = pd.to_datetime(df["time"], utc=True, format="ISO8601")
    df = df[(df["time"] >= START) & (df["time"] <= END)].reset_index(drop=True)
    df["gateways"] = [g if isinstance(g, list) else [] for g in df["gateways"]]
    r = requests.get(f"{SITE}/api/forecast", params={"device": DEVICE, "view": "history"}, timeout=60)
    r.raise_for_status()
    recon = pd.DataFrame(r.json()["observed"]["reconstructed_track"])
    recon["t"] = pd.to_datetime(recon["time_utc"], utc=True, format="ISO8601").map(lambda x: x.timestamp())
    return df, recon[["t", "lat", "lon"]].sort_values("t").to_numpy()


class Track:
    """Positions at any time from fixes and the reconstruction, and what was known at the time."""

    def __init__(self, df: pd.DataFrame, recon: np.ndarray):
        rows = df.dropna(subset=["lat", "lon"])
        rows = rows[rows["altitude_m"] > 300]
        fixes, last = [], None
        for row in rows.itertuples():
            if last is not None and abs(row.lat - last[0]) < 1e-6 and abs(row.lon - last[1]) < 1e-6:
                continue  # a repeat of the previous position, not a new fix
            last = (row.lat, row.lon)
            fixes.append((row.time.timestamp(), row.lat, row.lon))
        self.fixes = np.array(fixes)
        self.packets = df
        self.packet_t = np.array([t.timestamp() for t in df["time"]])
        self.gps_spans = []
        pts = [tuple(self.fixes[0])]
        for (ta, la, oa), (tb, lb, ob) in zip(self.fixes[:-1], self.fixes[1:]):
            inner = recon[(recon[:, 0] > ta + 1) & (recon[:, 0] < tb - 1)]
            parked = np.any((np.abs(inner[:, 1] - la) < 1e-3) & (np.abs(inner[:, 2] - oa) < 1e-3) & (inner[:, 0] > ta + 3600))
            if tb - ta <= GPS_GAP_S:
                self.gps_spans.append((ta, tb))
            elif len(inner) and not parked:
                pts += [tuple(p) for p in inner]
            pts.append((tb, lb, ob))
        tail = recon[recon[:, 0] > self.fixes[-1, 0] + 1]
        pts += [tuple(p) for p in tail[tail[:, 0] <= END.timestamp() + 3600]]
        self.pts = np.array(pts)
        # Pressure altitude, with single-packet spikes removed.
        p = df["pressure"].to_numpy(float)
        ok = ~np.isnan(p)
        self.p_t, self.p = self.packet_t[ok], median_filter(p[ok], 5, mode="nearest")

    def at(self, t: float):
        i = int(np.clip(np.searchsorted(self.pts[:, 0], t) - 1, 0, len(self.pts) - 2))
        (ta, la, oa), (tb, lb, ob) = self.pts[i], self.pts[i + 1]
        w = float(np.clip((t - ta) / (tb - ta), 0, 1))
        return la + w * (lb - la), oa + w * (ob - oa)

    def altitude(self, t: float) -> float:
        p = float(np.interp(t, self.p_t, self.p))
        return 44_330.8 * (1 - (p / 1013.25) ** 0.190263)

    def mode(self, t: float) -> str:
        if any(a <= t <= b for a, b in self.gps_spans) or np.min(np.abs(self.fixes[:, 0] - t)) < 60:
            return "gps"
        i = int(np.searchsorted(self.packet_t, t, side="right")) - 1
        return "est" if i >= 0 and t - self.packet_t[i] < HEARD_S else "silent"

    def velocity(self, t: float):
        (la, oa), (lb, ob) = self.at(t - 600), self.at(t + 600)
        az, _, d = GEOD.inv(oa, la, ob, lb)
        return d / 1200, az % 360


# ── imagery ──────────────────────────────────────────────────────────────────

def to_uv(lon, lat):
    x, y = MAP_CRS.transform_point(float(lon), float(lat), ccrs.PlateCarree())
    return round(float((x - X0) / (X1 - X0)), 5), round(float((Y1 - y) / (Y1 - Y0)), 5)


def target_grid():
    X, Y = np.meshgrid(np.linspace(X0, X1, GRID_W), np.linspace(Y1, Y0, GRID_H))
    ll = ccrs.PlateCarree().transform_points(MAP_CRS, X, Y)
    gx, gy = GOES_PROJ(ll[..., 0], ll[..., 1])
    return ll[..., 0], ll[..., 1], gx / 35_786_023.0, gy / 35_786_023.0


def solar_position(t: float, lat, lon):
    """(cos zenith, azimuth in degrees from north) of the sun, to well under a degree."""
    d = t / 86400.0 - 10957.5  # days since J2000
    g = np.radians((357.529 + 0.98560028 * d) % 360)
    q = (280.459 + 0.98564736 * d) % 360
    lam = np.radians(q + 1.915 * np.sin(g) + 0.020 * np.sin(2 * g))
    eps = np.radians(23.439 - 0.00000036 * d)
    ra, dec = np.arctan2(np.cos(eps) * np.sin(lam), np.cos(lam)), np.arcsin(np.sin(eps) * np.sin(lam))
    ha = np.radians(((18.697374558 + 24.06570982441908 * d) % 24) * 15 + lon) - ra
    lat = np.radians(lat)
    mu = np.sin(lat) * np.sin(dec) + np.cos(lat) * np.cos(dec) * np.cos(ha)
    az = np.degrees(np.arctan2(-np.sin(ha), np.tan(dec) * np.cos(lat) - np.sin(lat) * np.cos(ha))) % 360
    return mu, az


def solar_cos_zenith(t: float, lat, lon):
    return solar_position(t, lat, lon)[0]


def satellite_look(lat, lon, sat_lon=-137.2, h=35_786_023.0, a=6_378_137.0):
    """(zenith, azimuth) in degrees of GOES-18 as seen from each point (spherical Earth)."""
    phi, lam, sl = np.radians(lat), np.radians(lon), np.radians(sat_lon)
    p = np.stack([a * np.cos(phi) * np.cos(lam), a * np.cos(phi) * np.sin(lam), a * np.sin(phi)])
    v = np.array([(a + h) * np.cos(sl), (a + h) * np.sin(sl), 0.0])[:, None, None] - p
    east = np.stack([-np.sin(lam), np.cos(lam), np.zeros_like(lam)])
    north = np.stack([-np.sin(phi) * np.cos(lam), -np.sin(phi) * np.sin(lam), np.cos(phi)])
    up = np.stack([np.cos(phi) * np.cos(lam), np.cos(phi) * np.sin(lam), np.sin(phi)])
    ve, vn, vu = (v * east).sum(0), (v * north).sum(0), (v * up).sum(0)
    return np.degrees(np.arccos(vu / np.sqrt(ve ** 2 + vn ** 2 + vu ** 2))), np.degrees(np.arctan2(ve, vn)) % 360


def list_scans(fs):
    scans = []
    hour = START.to_pydatetime().replace(minute=0) - timedelta(hours=1)
    while hour <= END.to_pydatetime() + timedelta(hours=1):
        for key in fs.ls(f"{BUCKET}/{hour:%Y/%j/%H}"):
            s_tok, e_tok = key.rsplit("/", 1)[-1].split("_")[3:5]
            mid = scan_time(s_tok) + (scan_time("s" + e_tok[1:]) - scan_time(s_tok)) / 2
            if START - timedelta(minutes=15) <= mid <= END + timedelta(minutes=15):
                scans.append((mid.timestamp(), s_tok, key))
        hour += timedelta(hours=1)
    return sorted(scans)


def read_region(fs, key, rows, cols):
    """The chunks of four bands covering rows × cols, fetched by byte range and decoded here
    (gzip and, if used, HDF5's byte shuffle); about 2 s per scan instead of a minute through
    xarray. NOAA's chunking has changed over time (226 px squares in May 2026, 24-row strips
    by October), so any chunk shape is handled."""
    url = f"https://noaa-goes18.s3.amazonaws.com/{key.split('/', 1)[1]}"
    with fs.open(key, block_size=2**16, cache_type="bytes") as fh:
        f = h5py.File(fh)
        ch, cw = f["CMI_C01"].chunks
        r0, r1, c0, c1 = rows[0] // ch, rows[1] // ch, cols[0] // cw, cols[1] // cw
        jobs = []
        for band in BANDS:
            d = f[f"CMI_{band}"]
            scale, offset, fill = (float(d.attrs[k][0]) for k in ("scale_factor", "add_offset", "_FillValue"))
            for r in range(r0, r1 + 1):
                for c in range(c0, c1 + 1):
                    info = d.id.get_chunk_info_by_coord((r * ch, c * cw))
                    jobs.append((band, r - r0, c - c0, info.byte_offset, info.size, scale, offset, fill, d.shuffle))
    out = {b: np.full(((r1 - r0 + 1) * ch, (c1 - c0 + 1) * cw), np.nan, np.float32) for b in BANDS}

    def get(job):
        band, r, c, off, size, scale, offset, fill, shuffled = job
        raw = np.frombuffer(zlib.decompress(requests.get(url, headers={"Range": f"bytes={off}-{off + size - 1}"}, timeout=60).content), np.uint8)
        if shuffled:
            b = raw.reshape(2, -1)
            raw = np.stack([b[0], b[1]], axis=1).reshape(-1)
        v = raw.view("<i2").reshape(ch, cw).astype(np.float32)
        v[v == fill] = np.nan
        out[band][r * ch:(r + 1) * ch, c * cw:(c + 1) * cw] = v * scale + offset

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(get, jobs))
    return out, r0 * ch, c0 * cw


def fd_grid(fs, key):
    """Scan angles of the full disk's 2 km pixel centres (x along columns, y down rows)."""
    path = CACHE / "fd2km_grid.npz"
    if not path.exists():
        with fs.open(key, block_size=2**16, cache_type="bytes") as fh:
            f = h5py.File(fh)
            axis = lambda v: f[v][:] * float(f[v].attrs["scale_factor"][0]) + float(f[v].attrs["add_offset"][0])
            np.savez(path, x=axis("x"), y=axis("y"))
    z = np.load(path)
    return z["x"], z["y"]


# The day grade (see the docstring): about halfway between a plain log stretch and GeoColor's look.
# The full fit (gammas 0.908, 0.993, 0.726 on the 20:00 UTC May 18 scan) read too red and contrasty.
BLACK = np.array([0.028, 0.028, 0.034])  # reflectance mapped to black, per channel
GREEN = (0.46, 0.08, 0.46)  # synthetic green from red, near-infrared and blue
GAMMA = np.array([0.954, 0.996, 0.863])  # halfway from neutral to the fitted gammas
SATURATION, S_CURVE = 1.0, 0.15
GEOCOLOR_FIT = Path(__file__).parent / "geocolor_fit.json"  # from fit_geocolor.py; replaces the grade above when present


class Imagery:
    def __init__(self):
        from pyspectral.rayleigh import Rayleigh
        self.lon, self.lat, self.sx, self.sy = target_grid()
        self.land = gshhs("black", "none", 0)[..., 3] > 0.5
        self.satz, self.sataz = satellite_look(self.lat, self.lon)
        self.rayleigh = Rayleigh("GOES-18", "abi", atmosphere="us-standard", aerosol_type="rayleigh_only")

    def composite(self, fs, item):
        """(rgb uint8, cloud alpha uint8, daylight 0–1) for one scan."""
        return self._compose(item[0], self.bands(fs, item))

    def bands(self, fs, item):
        """The scan's four bands on the map grid, cached."""
        t, token, key = item
        path = CACHE / f"mcmip_{token}_{GRID_TAG}.npz"
        if not path.exists():
            x, y = fd_grid(fs, key)
            col = (self.sx - x[0]) / (x[1] - x[0])
            row = (self.sy - y[0]) / (y[1] - y[0])
            bands, rr, cc = read_region(fs, key, (int(row.min()) - 2, int(row.max()) + 3), (int(col.min()) - 2, int(col.max()) + 3))
            grid = {b: map_coordinates(np.nan_to_num(v, nan=0.0 if b != "C13" else 290.0), [row - rr, col - cc], order=1, mode="nearest")
                    for b, v in bands.items()}
            np.savez_compressed(path, **grid)
        return np.load(path)

    def day_linear(self, t, g):
        """(Rayleigh-corrected red, synthetic green, blue reflectance, sun zenith in degrees)."""
        mu0, sunaz = solar_position(t, self.lat, self.lon)
        m = np.clip(mu0, 0.12, 1)
        sunz = np.degrees(np.arccos(m))
        azid = np.abs(sunaz - self.sataz)
        azid = np.where(azid > 180, 360 - azid, azid)
        refl = {b: g[b] / m * 100 for b in ("C01", "C02", "C03")}  # sun-normalised, percent
        fade = 1 - 0.6 * smoothstep(70, 88, sunz)  # less correction as the sun gets low, as in Satpy
        for b in ("C01", "C02"):
            refl[b] = refl[b] - fade * self.rayleigh.get_reflectance(sunz, self.satz, azid, b, refl["C02"])
        r, n, b = (np.clip(refl[k] / 100, 0, 1.2) for k in ("C02", "C03", "C01"))
        return np.dstack([r, GREEN[0] * r + GREEN[1] * n + GREEN[2] * b, b]), sunz

    def _compose(self, t, g):
        mu0 = solar_cos_zenith(t, self.lat, self.lon)
        day = smoothstep(0.03, 0.22, mu0)[..., None]
        m = np.clip(mu0, 0.12, 1)
        lin, _ = self.day_linear(t, g)
        if GEOCOLOR_FIT.exists():
            from fit_geocolor import apply
            rgb = apply(json.loads(GEOCOLOR_FIT.read_text()), lin)
        else:
            rgb = np.clip(np.log(np.maximum(lin, BLACK) / BLACK) / np.log(1 / BLACK), 0, 1) ** GAMMA
            luma = (rgb @ np.array([0.299, 0.587, 0.114]))[..., None]
            rgb = np.clip(luma + (rgb - luma) * SATURATION, 0, 1)
            rgb = np.clip(rgb + S_CURVE * rgb * (1 - rgb) * (rgb - 0.5) * 2, 0, 1)
        bt = g["C13"]
        ir = np.clip((282 - bt) / (282 - 205), 0, 1) ** 0.85  # cold tops white, warm surfaces dark
        base = np.where(self.land[..., None], NIGHT_LAND, NIGHT_SEA)
        night = base * (1 - ir[..., None]) + np.array([0.86, 0.88, 0.92]) * ir[..., None]
        img = rgb * day + night * (1 - day)
        # Cloud for the paper map: cold tops at any hour, bright tops by day (higher bar over land).
        vis = np.where(self.land, smoothstep(0.42, 0.68, g["C02"] / m), smoothstep(0.16, 0.40, g["C02"] / m))
        alpha = np.maximum(np.clip((276 - bt) / 30, 0, 1), vis * day[..., 0])
        return ((img * 255 + 0.5).astype(np.uint8), (alpha * 255 + 0.5).astype(np.uint8), day[..., 0])

    def load(self):
        fs = s3fs.S3FileSystem(anon=True)
        scans = list_scans(fs)
        print(f"{len(scans)} GOES-18 full-disk scans")
        CACHE.mkdir(parents=True, exist_ok=True)

        def one(item):
            out = self.composite(fs, item)
            return item[0], out

        done = []
        with ThreadPoolExecutor(max_workers=6) as pool:
            for k, res in enumerate(pool.map(one, scans)):
                done.append(res)
                if k % 25 == 0:
                    print(f"  scan {k}/{len(scans)}")
        times = np.array([t for t, _ in done])
        return times, [o[0] for _, o in done], [np.repeat(o[1][..., None], 3, 2) for _, o in done], [o[2] for _, o in done]


def gshhs(face: str, edge: str, lw: float, borders: bool = False) -> np.ndarray:
    fig = plt.figure(figsize=(GRID_W / 100, GRID_H / 100), dpi=100)
    fig.patch.set_alpha(0)
    ax = fig.add_axes([0, 0, 1, 1], projection=MAP_CRS)
    ax.set_extent([X0, X1, Y0, Y1], crs=MAP_CRS)
    ax.spines["geo"].set_visible(False)
    ax.patch.set_alpha(0)
    ax.add_feature(cfeature.GSHHSFeature(scale="h", levels=[1], facecolor=face, edgecolor=edge, linewidth=lw))
    if borders:
        ax.add_feature(cfeature.BORDERS.with_scale("10m"), edgecolor=edge, linewidth=lw * 0.8)
        ax.add_feature(cfeature.STATES.with_scale("10m"), edgecolor=edge, linewidth=lw * 0.45)
    fig.canvas.draw()
    rgba = np.asarray(fig.canvas.buffer_rgba()).astype(np.float32) / 255
    plt.close(fig)
    return rgba


def render(style: str, frames, out: Path):
    """Encode the frames (a generator of float RGB) to H.264 for the web."""
    ffmpeg = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{GRID_W}x{GRID_H}",
         "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-crf", "27", "-preset", "slow", "-g", "12",
         "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)], stdin=subprocess.PIPE)
    for k, img in enumerate(frames):
        ffmpeg.stdin.write((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8).tobytes())
        if k % 100 == 0:
            print(f"  {style} frame {k}")
    ffmpeg.stdin.close()
    if ffmpeg.wait():
        raise SystemExit("ffmpeg failed")
    print(f"Wrote {out}")


def backgrounds(times, sats, clouds, days, frame_t):
    sat = Scans(times, sats)
    cloud = Scans(times, clouds)
    coast = gshhs("none", "white", 0.6, borders=True)
    render("geocolor", (over(sat.at(t)[0].astype(np.float32) / 255, coast, 0.3) for t in frame_t),
           OUT / "background-geocolor.mp4")
    paper = over(np.ones((GRID_H, GRID_W, 3), np.float32) * matplotlib.colors.to_rgb(SEA), gshhs(LAND, "none", 0))
    paper = over(paper, gshhs("none", COAST, 0.7, borders=True))
    shade = np.array(matplotlib.colors.to_rgb(SHADOW))
    navy = np.array([0.16, 0.2, 0.3])
    lon, lat = target_grid()[:2]

    def map_frame(t):
        a = cloud.at(t)[0][..., 0].astype(np.float32) / 255
        blurred = gaussian_filter(a, 3)
        shadow = np.zeros_like(blurred)
        shadow[4:, 3:] = blurred[:-4, :-3] * 0.32
        img = paper * (1 - shadow[..., None]) + shade * shadow[..., None]
        img = img * (1 - a[..., None] * 0.94) + 0.99 * a[..., None] * 0.94
        night = 1 - smoothstep(0.0, 0.15, solar_cos_zenith(t, lat, lon))
        return img * (1 - 0.42 * night[..., None]) + navy * 0.42 * night[..., None]

    render("map", (map_frame(t) for t in frame_t), OUT / "background-map.mp4")


# ── data ─────────────────────────────────────────────────────────────────────

def flight_json(track: Track, frame_t: np.ndarray, scan_t: np.ndarray) -> dict:
    nan = lambda v: None if v is None or (isinstance(v, float) and math.isnan(v)) else v
    frames = {k: [] for k in ("u", "v", "alt", "mode", "speed", "heading", "packet", "scan", "night", "status")}
    statuses = []
    fixes_t = track.fixes[:, 0]
    for t in frame_t:
        lat, lon = track.at(t)
        mode = track.mode(t)
        speed, heading = track.velocity(t)
        k = int(np.searchsorted(track.packet_t, t, side="right")) - 1
        last_fix = fixes_t[fixes_t <= t].max()
        status = {"gps": "Tracked by GPS",
                  "est": f"No new GPS fix since {clock(last_fix)} · estimated",
                  "silent": f"Silent since {clock(track.packet_t[max(k, 0)])} · estimated"}[mode]
        if status not in statuses:
            statuses.append(status)
        u, v = to_uv(lon, lat)
        for key, value in (("u", u), ("v", v), ("alt", round(track.altitude(t))), ("mode", mode),
                           ("speed", round(speed, 1)), ("heading", round(heading)), ("packet", k),
                           ("scan", float(scan_t[np.argmin(np.abs(scan_t - t))])),
                           ("night", int(solar_cos_zenith(t, lat, lon) < -0.05)), ("status", statuses.index(status))):
            frames[key].append(value)

    # The drawn line: runs of one mode, sampled every frame, with the fixes themselves in place.
    samples = sorted({*frame_t.tolist(), *[t for t in fixes_t if frame_t[0] <= t <= frame_t[-1]]})
    segments = []
    for t in samples:
        mode = track.mode(t)
        point = [round(t, 1), *to_uv(*track.at(t)[::-1])]
        if not segments or segments[-1]["kind"] != mode:
            if segments:
                segments[-1]["pts"].append(point)
            segments.append({"kind": mode, "pts": [point]})
        else:
            segments[-1]["pts"].append(point)

    packets = []
    for row in track.packets.itertuples():
        located = [g for g in row.gateways if g.get("lat") is not None and g.get("lon") is not None]
        packets.append({"t": row.time.timestamp(), "temperature": nan(row.temperature), "lux": None, "uv": None,
                        "heardBy": len(row.gateways), "receivers": [to_uv(g["lon"], g["lat"]) for g in located]})
    gateways = sorted({(round(g["lat"], 4), round(g["lon"], 4)) for row in track.packets.itertuples()
                       for g in row.gateways if g.get("lat") is not None and g.get("lon") is not None})

    f = track.fixes
    pos = lambda t: dict(zip(("u", "v"), to_uv(*track.at(t)[::-1])))
    stuck_t = f[np.argmax(np.diff(f[:, 0]) > GPS_GAP_S), 0]  # the fix the receiver then repeated
    after_stuck = f[f[:, 0] > stuck_t][0, 0]
    before_dark = track.packet_t[np.argmax(np.diff(track.packet_t) > 12 * 3600)]
    heard_again = track.packet_t[track.packet_t > before_dark + 12 * 3600][0]
    loop_t = track.pts[np.argmin(np.where((track.pts[:, 0] > before_dark) & (track.pts[:, 0] < heard_again), track.pts[:, 1], 99)), 0]
    last_fix, last_packet = f[-1, 0], track.packet_t[-1]
    gap_h = round((heard_again - before_dark) / 3600)
    labels = [
        {"t": 0, **pos(f[0, 0]), "marker": "launch", "lines": [["Launched from San Francisco, May 17", "lead"]], "short": [["Launch, May 17", "lead"]]},
        {"t": stuck_t, **pos(stuck_t), "lines": [[f"GPS stuck at {clock(stuck_t)}", "lead"], [f"Line straight to the {clock(after_stuck)} fix", "muted"]],
         "short": [[f"GPS stuck, {clock(stuck_t)}", "lead"]]},
        {"t": before_dark, **pos(before_dark), "side": "left", "lines": [[f"Last packet before dark, {clock(before_dark)}", "lead"], [f"Then silent for {gap_h} hours", "muted"]],
         "short": [[f"Silent from {clock(before_dark)}", "lead"], [f"for {gap_h} hours", "muted"]]},
        {"t": loop_t, **pos(loop_t), "dy": -16, "lines": [["Path estimated from winds", "muted"]], "short": [["Estimated from winds", "muted"]]},
        {"t": heard_again, **pos(heard_again), "lines": [["Heard again over Sonora", "lead"], [clock(heard_again, True), "muted"]],
         "short": [["Heard again", "lead"], [clock(heard_again), "muted"]]},
        {"t": last_fix, **pos(last_fix), "side": "left", "dy": 16, "lines": [[f"Last GPS fix, {clock(last_fix)}", "lead"], [f"{track.altitude(last_fix) / 1000:.1f} km up", "muted"]],
         "short": [[f"Last fix, {clock(last_fix)}", "lead"]]},
        {"t": last_packet, **pos(last_packet), "side": "left", "dy": -12, "lines": [[f"Last transmission, {clock(last_packet)}", "lead"]],
         "short": [[f"Last packet, {clock(last_packet)}", "lead"]]},
    ]
    return {
        "map": {"km": (X1 - X0) / 1000, "aspect": round(GRID_H / GRID_W, 5), "ocean": [to_uv(*p) for p in OCEAN]},
        "title": "Stratolink 3, May 17–19, 2026",
        "multiDay": True,
        "sources": {"geocolor": "NOAA GOES-18 full-disk imagery, with daytime colors matched to CIRA’s GeoColor and infrared at night; path through the gaps from the Stratolink dashboard’s wind reconstruction",
                    "map": "clouds from NOAA GOES-18 imagery; path through the gaps from the Stratolink dashboard’s wind reconstruction"},
        "events": {"lastPacket": {"t": last_packet, **pos(last_packet)}},
        "panel": ["speed", "heard"],
        "frames": {"t0": float(frame_t[0]), "step": STEP_S, "fps": FPS, "count": len(frame_t), **frames},
        "statuses": statuses,
        "segments": segments,
        "labels": labels,
        "axisNotes": [{"t": (before_dark + heard_again) / 2, "text": f"{gap_h} hours without a packet", "short": f"{gap_h} h silent", "anchor": "middle", "cls": "muted"}],
        "fixes": [{"t": t, **dict(zip(("u", "v"), to_uv(lon, lat)))} for t, lat, lon in f],
        "packets": packets,
        "gateways": [list(to_uv(lon, lat)) for lat, lon in gateways],
        "cities": [{"name": n, **dict(zip(("u", "v"), to_uv(lon, lat)))} for n, lat, lon in CITIES],
        "facts": {},
    }


def main(video: bool, test: bool):
    OUT.mkdir(parents=True, exist_ok=True)
    if test:
        img = Imagery()
        fs = s3fs.S3FileSystem(anon=True)
        scans = list_scans(fs)
        for want in ("2026-05-17T20:00Z", "2026-05-18T02:40Z", "2026-05-18T09:00Z"):
            item = min(scans, key=lambda s: abs(s[0] - pd.Timestamp(want).timestamp()))
            rgb, alpha, _ = img.composite(fs, item)
            plt.imsave(CACHE.parent / f"s3_test_{want[:13]}.png", rgb)
            plt.imsave(CACHE.parent / f"s3_test_{want[:13]}_cloud.png", alpha, cmap="gray")
            print("wrote test", want)
        return
    track = Track(*fetch())
    print(f"{len(track.fixes)} fixes, {len(track.packets)} packets, {len(track.pts)} track points")
    frame_t = np.append(np.arange(track.fixes[0, 0], END.timestamp(), STEP_S), END.timestamp())
    if video:
        times, sats, clouds, days = Imagery().load()
        backgrounds(times, sats, clouds, days, frame_t)
    else:
        times = np.array([s[0] for s in list_scans(s3fs.S3FileSystem(anon=True))])
    (OUT / "flight.json").write_text(json.dumps(flight_json(track, frame_t, times), separators=(",", ":")))
    print(f"Wrote {OUT / 'flight.json'}")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--json-only", action="store_true")
    parser.add_argument("--test", action="store_true")
    args = parser.parse_args()
    main(video=not args.json_only, test=args.test)
