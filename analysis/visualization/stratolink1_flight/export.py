"""Export Stratolink-1's flight for the D3 graphic in this folder.

Python does the heavy lifting; index.html draws everything else. This writes, to data/:

  flight.json            the track, packets, labelled events, per-frame readings
                         and the spread of possible paths, in map coordinates
                         (u right, v down, 0–1 across the map)
  background_map.*       the paper map with clouds, one frame per 20 s of flight
  background_geocolor.*  CIRA's GeoColor imagery, likewise
                         (.webm VP9 and .mp4 H.264, 30 fps, a keyframe every 10)

The window runs from the first airborne GPS fix to 45 minutes after the last
packet, 23 Oct 2026 10:54:58 a.m. → 2:07:41 p.m. PDT.

Imagery. Every 5-minute GOES-18 CONUS scan in the window is resampled onto a
380 km Lambert conformal square, 1080 px a side. Between scans, frames are
interpolated along the optical flow between neighbouring scans (OpenCV DIS), so
clouds move rather than cross-fade.
  • map — white clouds with a soft shadow over a paper map, their opacity taken
    from a top-of-atmosphere true-color composite of ABI bands 1–3, read from
    NOAA's bucket (s3://noaa-goes18, ABI-L2-CMIPC).
  • geocolor — CIRA's GeoColor (by day, Rayleigh-corrected true color with a
    synthetic green), from the 0.5 km RAMMB/SLIDER tiles covering the map,
    reprojected on band 2's fixed grid; color, not brightness, is smoothed
    slightly to calm the fringes left by the 1 km blue band.

Position. Between GPS fixes it is interpolated linearly. After the last fix it
is dead-reckoned along the last GPS ground velocity; altitude after the last fix
comes from the final packet's barometer via the scale height of the last two
fixes. After the last packet the projection continues at that velocity for 45
minutes; the possible paths vary the speed by up to 20 %, the heading by up to
15° and add a slow random turn.

Clouds. Each frame samples, at the balloon's position, the nearest GOES-18
cloud-top height (ABI-L2-ACHAC, ~10 km) and clear-sky mask (ABI-L2-ACMC, 2 km).

Telemetry comes from Supabase (SUPABASE_URL and SBKEY or
SUPABASE_SERVICE_ROLE_KEY), or TELEMETRY_CSV with `time`, `lat`, `lon`,
`altitude_m`, `pressure`, `gps_speed`, `gps_heading`, `temperature`,
`ambient_lux`, `uv_index`, `rssi` and a JSON `gateways` column. Without either,
the public dashboard API is used, which masks positions near the launch site;
--public forces that, for anything that will be published, and writes the blog figure's copy,
web/public/assets/flights/stratolink-1/flight.json.
The launch site is included when LAUNCH_SITE is set to "lat,lon"; it is not
stored here because the public site masks positions near the launch. data/ is
not committed for the same reason.

Scans are cached in ../output/goes_cache.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import requests
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

import cartopy.crs as ccrs
import cartopy.feature as cfeature
import cv2
import pyproj
import s3fs
import xarray as xr
from scipy.ndimage import gaussian_filter, map_coordinates

DEVICE = "stratolink-1"
LAUNCHED_AT = pd.Timestamp("2026-10-23T17:36:00Z")  # devices.launched_at
SBKEY = os.environ.get("SBKEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
SBURL = os.environ.get("SUPABASE_URL", "").rstrip("/")
PUBLIC_API = "https://stratolink.org/api/telemetry"

DATA = Path(__file__).parent / "data"
CACHE = Path(__file__).parent.parent / "output" / "goes_cache"
SITE_ASSETS = Path(__file__).resolve().parents[3] / "web" / "public" / "assets" / "flights" / "stratolink-1"

# Map: a 380 km square covering the flight and the 45-minute projection, 1080 px on a side.
CENTER_LON, CENTER_LAT, HALF_M, GRID_PX = -122.35, 36.35, 190_000, 1080
GRID_TAG = hashlib.sha1(f"{CENTER_LON},{CENTER_LAT},{HALF_M},{GRID_PX}".encode()).hexdigest()[:8]
LOCAL_TZ = ZoneInfo("America/Los_Angeles")  # the launch site's time zone
MAP_CRS = ccrs.LambertConformal(central_longitude=CENTER_LON, central_latitude=CENTER_LAT,
                                standard_parallels=(35.5, 38.0))
GOES_PROJ = pyproj.Proj(proj="geos", h=35_786_023.0, lon_0=-137.0, sweep="x",
                        a=6_378_137.0, rf=298.257222101)
BUCKET = "noaa-goes18/ABI-L2-CMIPC"
STEP_S = 20.0  # flight seconds per frame
TAIL = timedelta(minutes=45)  # projection shown after the last packet
FPS = 30
GEOD = pyproj.Geod(ellps="WGS84")

SPEED_ERR, HEADING_ERR_DEG = 0.20, 15.0
# Possible paths after the last packet: how many, time step, and spread of the slow turn (deg/h).
FAN_N, FAN_DT_S, FAN_TURN_DEG_H = 160, 20.0, 15.0
LOW_CLOUD_M = 300  # cloud-top heights below this are mostly retrieval noise in the marine layer
CITIES = [("San Jose", 37.3382, -121.8863),
          ("Santa Cruz", 36.9741, -122.0308), ("Monterey", 36.6002, -121.8947),
          ("Big Sur", 36.2704, -121.8081), ("Morro Bay", 35.3658, -120.8499)]

# The paper map's colors, from the blog's figures ("Drawing the path between packets").
SEA, LAND, COAST, SHADOW = "#e8e8e1", "#dcd8cd", "#959c93", "#5d5c55"


# ── telemetry ────────────────────────────────────────────────────────────────

def fetch_telemetry(public: bool = False) -> pd.DataFrame:
    fields = ("time,lat,lon,altitude_m,pressure,gps_speed,gps_heading,temperature,ambient_lux,"
              "uv_index,rssi,gateways")
    csv_path = os.environ.get("TELEMETRY_CSV")
    if csv_path:
        df = pd.read_csv(csv_path)
        df["gateways"] = [json.loads(v) if isinstance(v, str) and v else [] for v in df["gateways"]]
    elif SBURL and SBKEY and not public:
        r = requests.get(f"{SBURL}/rest/v1/telemetry",
                         params={"device_id": f"eq.{DEVICE}", "select": fields,
                                 "time": f"gte.{LAUNCHED_AT.isoformat()}", "order": "time.asc"},
                         headers={"apikey": SBKEY, "Authorization": f"Bearer {SBKEY}"}, timeout=30)
        r.raise_for_status()
        df = pd.DataFrame(r.json())
    else:
        print("No Supabase credentials or TELEMETRY_CSV: using the public API (launch-area fixes are masked).")
        r = requests.get(PUBLIC_API, params={"resource": "telemetry", "device_id": f"eq.{DEVICE}",
                                             "select": fields, "time": f"gte.{LAUNCHED_AT.isoformat()}",
                                             "order": "time.asc", "limit": "1000"}, timeout=30)
        r.raise_for_status()
        df = pd.DataFrame(r.json())
    df["time"] = pd.to_datetime(df["time"], utc=True, format="ISO8601")
    df["gateways"] = [g if isinstance(g, list) else [] for g in df["gateways"]]
    return df[df["time"] >= LAUNCHED_AT].sort_values("time").reset_index(drop=True)


class Track:
    """Known fixes, interpolation between them, and dead reckoning after the last one."""

    def __init__(self, df: pd.DataFrame):
        fixes = df.dropna(subset=["lat", "lon"])
        fixes = fixes[fixes["altitude_m"] > 300]
        if fixes.empty:
            raise SystemExit("No airborne fixes in the telemetry.")
        self.start = fixes["time"].iloc[0]
        self.end = df["time"].iloc[-1]
        self.packets = df[(df["time"] >= self.start) & (df["time"] <= self.end)]
        self.fixes = fixes
        self.ft = np.array([t.timestamp() for t in fixes["time"]])
        self.flat, self.flon = fixes["lat"].to_numpy(), fixes["lon"].to_numpy()
        self.falt = fixes["altitude_m"].to_numpy(float)
        last = fixes.iloc[-1]
        self.last_fix_t = self.ft[-1]
        self.dr_speed, self.dr_heading = float(last["gps_speed"]), float(last["gps_heading"])
        # Barometric altitude of the final packet, via the scale height of the last two fixes.
        self.end_alt = self.falt[-1]
        final = df.iloc[-1]
        if pd.isna(final["lat"]) and len(fixes) >= 2 and pd.notna(final["pressure"]):
            p1, p2 = fixes["pressure"].iloc[-2], fixes["pressure"].iloc[-1]
            scale_h = (self.falt[-1] - self.falt[-2]) / math.log(p1 / p2)
            self.end_alt = self.falt[-1] + scale_h * math.log(p2 / final["pressure"])
        self.end_t = self.end.timestamp()
        self.view_end_t = self.end_t + TAIL.total_seconds()

    def at(self, t: float):
        """(lat, lon, alt_m, mode, radius_m); mode is 'fix', 'interp', 'dr' or, after the last packet, 'lost'."""
        if t <= self.last_fix_t:
            i = int(np.searchsorted(self.ft, t, side="right")) - 1
            if i < 0:
                return self.flat[0], self.flon[0], self.falt[0], "fix", 0.0
            if abs(t - self.ft[i]) < 1:
                return self.flat[i], self.flon[i], self.falt[i], "fix", 0.0
            w = (t - self.ft[i]) / (self.ft[i + 1] - self.ft[i])
            lerp = lambda a: a[i] + w * (a[i + 1] - a[i])
            return lerp(self.flat), lerp(self.flon), lerp(self.falt), "interp", 0.0
        dt = t - self.last_fix_t
        d = self.dr_speed * dt
        lon, lat, _ = GEOD.fwd(self.flon[-1], self.flat[-1], self.dr_heading, d)
        span = max(self.end_t - self.last_fix_t, 1)
        alt = self.falt[-1] + (self.end_alt - self.falt[-1]) * min(dt / span, 1)
        radius = math.hypot(SPEED_ERR * d, d * math.sin(math.radians(HEADING_ERR_DEG)))
        return lat, lon, alt, "dr" if t <= self.end_t else "lost", radius

    def speed_heading(self, t: float):
        if t > self.last_fix_t:
            return self.dr_speed, self.dr_heading
        row = self.fixes.iloc[max(int(np.searchsorted(self.ft, t, side="right")) - 1, 0)]  # latest fix
        return float(row["gps_speed"]), float(row["gps_heading"])


# ── GOES imagery ─────────────────────────────────────────────────────────────

def target_grid():
    xs = np.linspace(-HALF_M, HALF_M, GRID_PX)
    ys = np.linspace(HALF_M, -HALF_M, GRID_PX)
    X, Y = np.meshgrid(xs, ys)
    lonlat = ccrs.PlateCarree().transform_points(MAP_CRS, X, Y)
    gx, gy = GOES_PROJ(lonlat[..., 0], lonlat[..., 1])
    return gx / 35_786_023.0, gy / 35_786_023.0  # scan angles, radians


def scan_time(token: str) -> datetime:
    """'s20262961801188' → datetime (year, day-of-year, HHMMSS, tenths)."""
    t = datetime.strptime(token[1:14], "%Y%j%H%M%S").replace(tzinfo=timezone.utc)
    return t + timedelta(seconds=int(token[14]) / 10)


def list_scans(fs, start: datetime, end: datetime):
    """{scan start token: {band: key}} for complete scans whose midpoint is near the window."""
    scans: dict[str, dict] = {}
    hour = start.replace(minute=0, second=0, microsecond=0) - timedelta(hours=1)
    while hour <= end + timedelta(hours=1):
        for key in fs.ls(f"{BUCKET}/{hour:%Y/%j/%H}"):
            name = key.rsplit("/", 1)[-1]
            band = name.split("-M6C")[1][:2] if "-M6C" in name else None
            if band not in {"01", "02", "03"}:
                continue
            s_tok, e_tok = name.split("_")[3], name.split("_")[4]
            mid = scan_time(s_tok) + (scan_time("s" + e_tok[1:]) - scan_time(s_tok)) / 2
            if start - timedelta(minutes=6) <= mid <= end + timedelta(minutes=6):
                scans.setdefault(s_tok, {"mid": mid})[band] = key
        hour += timedelta(hours=1)
    return {k: v for k, v in sorted(scans.items()) if {"01", "02", "03"} <= v.keys()}


def read_band(fs, key, sx, sy):
    with fs.open(key, block_size=4 * 2**20) as fh, xr.open_dataset(fh, engine="h5netcdf") as ds:
        x, y = ds["x"].values, ds["y"].values
        col = (sx - x[0]) / (x[1] - x[0])
        row = (sy - y[0]) / (y[1] - y[0])
        r0, r1 = int(np.floor(row.min())) - 2, int(np.ceil(row.max())) + 3
        c0, c1 = int(np.floor(col.min())) - 2, int(np.ceil(col.max())) + 3
        sub = ds["CMI"][r0:r1, c0:c1].values.astype(np.float32)
    sub = np.nan_to_num(sub, nan=0.0)
    return map_coordinates(sub, [row - r0, col - c0], order=1, mode="nearest")


def true_color(c01, c02, c03):
    green = 0.45 * c02 + 0.1 * c03 + 0.45 * c01
    rgb = np.clip(np.dstack([c02, green, c01]), 0, 1) ** (1 / 2.2)
    rgb = np.clip((rgb - 0.04) * 1.12, 0, 1)  # small contrast stretch
    return (rgb * 255).astype(np.uint8)


# CIRA's GeoColor on RAMMB/SLIDER: the GOES-18 CONUS sector, 10000 × 6000 px on band 2's 0.5 km
# grid, centred in a 10000 px square that the top zoom level cuts into 16 × 16 tiles of 625 px.
SLIDER = "https://slider.cira.colostate.edu/data/imagery"
TILE, ZOOM, PAD_ROWS = 625, 4, 2000


def band2_grid(fs, key):
    """Scan angles of band 2's pixel centres, x along columns and y down rows."""
    path = CACHE / "c02_grid.npz"
    if not path.exists():
        with fs.open(key, block_size=2**20) as fh, xr.open_dataset(fh, engine="h5netcdf") as ds:
            np.savez(path, x=ds["x"].values, y=ds["y"].values)
    z = np.load(path)
    return z["x"], z["y"]


def geocolor(start: datetime, x, y, sx, sy):
    """The GeoColor image of the scan starting at `start`, resampled onto the map grid; None if
    SLIDER does not have it. Only the tiles covering the map are fetched."""
    col = (sx - x[0]) / (x[1] - x[0])
    row = (sy - y[0]) / (y[1] - y[0]) + PAD_ROWS
    r0, r1 = int(row.min()) // TILE, int(row.max() + 2) // TILE
    c0, c1 = int(col.min()) // TILE, int(col.max() + 2) // TILE
    mosaic = np.zeros(((r1 - r0 + 1) * TILE, (c1 - c0 + 1) * TILE, 3), np.float32)
    for r in range(r0, r1 + 1):
        for c in range(c0, c1 + 1):
            resp = requests.get(f"{SLIDER}/{start:%Y/%m/%d}/goes-18---conus/geocolor/{start:%Y%m%d%H%M%S}/"
                                f"{ZOOM:02d}/{r:03d}_{c:03d}.png", timeout=60)
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            tile = plt.imread(io.BytesIO(resp.content), format="png")[..., :3]
            mosaic[(r - r0) * TILE:(r - r0 + 1) * TILE, (c - c0) * TILE:(c - c0 + 1) * TILE] = tile
    rgb = np.dstack([map_coordinates(mosaic[..., k], [row - r0 * TILE, col - c0 * TILE], order=3, mode="nearest")
                     for k in range(3)])
    # Soften color but not brightness: GeoColor's blue band is 1 km and its red 0.5 km, which
    # leaves red and cyan fringes on small clouds.
    luma = rgb @ np.array([0.299, 0.587, 0.114], np.float32)
    chroma = np.dstack([gaussian_filter(rgb[..., k] - luma, 1.5) for k in range(3)])
    return (np.clip(luma[..., None] + chroma, 0, 1) * 255 + 0.5).astype(np.uint8)


def load_imagery(start: datetime, end: datetime, style: str):
    fs = s3fs.S3FileSystem(anon=True)
    scans = list_scans(fs, start, end)
    sx, sy = target_grid()
    CACHE.mkdir(parents=True, exist_ok=True)
    if style == "geocolor":
        x, y = band2_grid(fs, next(iter(scans.values()))["02"])

    def one(item):
        token, entry = item
        if style == "geocolor":
            path = CACHE / f"geocolor_{token}_{GRID_TAG}.npy"
            if not path.exists():
                img = geocolor(scan_time(token), x, y, sx, sy)
                if img is None:
                    print(f"  no GeoColor for scan {entry['mid']:%H:%M:%S}")
                    return None
                np.save(path, img)
                print(f"  fetched GeoColor {entry['mid']:%H:%M:%S}")
            return entry["mid"].timestamp(), np.load(path)
        path = CACHE / f"{token}_{GRID_TAG}.npy"
        if not path.exists():
            bands = {b: read_band(fs, entry[b], sx, sy) for b in ("01", "02", "03")}
            np.save(path, true_color(bands["01"], bands["02"], bands["03"]))
            print(f"  fetched scan {entry['mid']:%H:%M:%S}")
        return entry["mid"].timestamp(), np.load(path)

    with ThreadPoolExecutor(max_workers=6) as pool:
        frames = [f for f in pool.map(one, scans.items()) if f is not None]
    print(f"{len(frames)} GOES-18 scans")
    return np.array([t for t, _ in frames]), [img for _, img in frames]


class CloudTops:
    """GOES-18 cloud-top height (ACHA, 10 km) and clear-sky mask (ACM, 2 km), sampled at a point.

    Each product's map-area subset is cached; a lookup uses the scan nearest in time
    and the nearest pixel. Neither product is parallax corrected.
    """

    PRODUCTS = {"ACHAC": "HT", "ACMC": "BCM"}

    def __init__(self, start: datetime, end: datetime):
        fs = s3fs.S3FileSystem(anon=True)
        sx, sy = target_grid()
        self.scans = {}
        for product, var in self.PRODUCTS.items():
            keys = []
            hour = start.replace(minute=0, second=0, microsecond=0)
            while hour <= end + timedelta(hours=1):
                for key in fs.ls(f"noaa-goes18/ABI-L2-{product}/{hour:%Y/%j/%H}"):
                    s_tok, e_tok = key.rsplit("/", 1)[-1].split("_")[3:5]
                    mid = scan_time(s_tok) + (scan_time("s" + e_tok[1:]) - scan_time(s_tok)) / 2
                    if start - timedelta(minutes=6) <= mid <= end + timedelta(minutes=6):
                        keys.append((mid, s_tok, key))
                hour += timedelta(hours=1)
            with ThreadPoolExecutor(max_workers=6) as pool:
                self.scans[product] = sorted(pool.map(lambda k: self._load(fs, product, var, k, sx, sy), keys),
                                             key=lambda s: s[0])
            print(f"{len(self.scans[product])} GOES-18 {product} scans")

    @staticmethod
    def _load(fs, product, var, item, sx, sy):
        mid, token, key = item
        path = CACHE / f"{product}_{token}_{GRID_TAG}.npz"
        if not path.exists():
            with fs.open(key) as fh, xr.open_dataset(fh, engine="h5netcdf") as ds:
                x, y = ds["x"].values, ds["y"].values
                cols = np.where((x >= sx.min() - 1e-3) & (x <= sx.max() + 1e-3))[0]
                rows = np.where((y >= sy.min() - 1e-3) & (y <= sy.max() + 1e-3))[0]
                data = ds[var][rows.min():rows.max() + 1, cols.min():cols.max() + 1].values
            np.savez(path, x=x[cols.min():cols.max() + 1], y=y[rows.min():rows.max() + 1], data=data)
        z = np.load(path)
        return mid.timestamp(), z["x"], z["y"], z["data"]

    def _sample(self, product, t, lat, lon):
        scans = self.scans[product]
        _, x, y, data = scans[int(np.argmin([abs(s[0] - t) for s in scans]))]
        gx, gy = GOES_PROJ(lon, lat)
        j = int(round((gx / 35_786_023.0 - x[0]) / (x[1] - x[0])))
        i = int(round((gy / 35_786_023.0 - y[0]) / (y[1] - y[0])))
        return float(data[i, j]) if 0 <= i < data.shape[0] and 0 <= j < data.shape[1] else math.nan

    def at(self, t: float, lat: float, lon: float):
        """(height_m or nan, cloudy: True/False/None)."""
        mask = self._sample("ACMC", t, lat, lon)
        return self._sample("ACHAC", t, lat, lon), None if math.isnan(mask) else mask >= 0.5


class Scans:
    """The scans in time order. A frame between two scans warps each of them partway along the
    optical flow between them (OpenCV's DIS) before mixing, so clouds move instead of cross-fading,
    which would leave ghosts and make the picture lose contrast between scans. The warp is cubic,
    and a light sharpen, strongest midway, makes up for the detail lost where the two scans'
    clouds differ; without it every real scan would flash sharper than the frames around it."""

    SHARPEN = 0.15  # unsharp-mask amount at the midpoint between scans

    def __init__(self, times, images):
        self.times, self.images = times, images
        h, w = images[0].shape[:2]
        self.grid = np.dstack(np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32)))
        self.dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
        self.pair = None  # (index, forward flow, backward flow) for the pair in use

    def _flows(self, i):
        if self.pair is None or self.pair[0] != i:
            a, b = (cv2.cvtColor(self.images[k], cv2.COLOR_RGB2GRAY) for k in (i, i + 1))
            self.pair = (i, self.dis.calc(a, b, None), self.dis.calc(b, a, None))
        return self.pair[1:]

    def _warp(self, img, flow, s):
        return cv2.remap(img, self.grid - s * flow, None, cv2.INTER_CUBIC,
                         borderMode=cv2.BORDER_REPLICATE).astype(np.float32)

    def at(self, t):
        """(image at t, time of the nearest scan)."""
        times = self.times
        i = int(np.clip(np.searchsorted(times, t) - 1, 0, len(times) - 2))
        w = float(np.clip((t - times[i]) / (times[i + 1] - times[i]), 0, 1))
        nearest = times[i] if w < 0.5 else times[i + 1]
        if w in (0.0, 1.0):
            return self.images[i + int(w)], nearest
        forward, backward = self._flows(i)
        img = self._warp(self.images[i], forward, w) * (1 - w) + self._warp(self.images[i + 1], backward, 1 - w) * w
        img += self.SHARPEN * 4 * w * (1 - w) * (img - cv2.GaussianBlur(img, (0, 0), 1.2))
        return (np.clip(img, 0, 255) + 0.5).astype(np.uint8), nearest


def to_map(lon, lat):
    p = MAP_CRS.transform_point(lon, lat, ccrs.PlateCarree())
    return p[0], p[1]


def utc(t: float) -> datetime:
    return datetime.fromtimestamp(t, tz=timezone.utc)


def local(t: float) -> datetime:
    return utc(t).astimezone(LOCAL_TZ)


def clock(t: float, day: bool = False) -> str:
    """AP-style local time, '1:15 p.m.' or 'noon', with ', May 19' if asked."""
    d = local(t)
    s = "noon" if (d.hour, d.minute) == (12, 0) else f"{d.hour % 12 or 12}:{d.minute:02d} {'a.m.' if d.hour < 12 else 'p.m.'}"
    return f"{s}, {d:%b}. {d.day}".replace("May.", "May") if day else s


def smoothstep(a: float, b: float, x):
    x = np.clip((x - a) / (b - a), 0, 1)
    return x * x * (3 - 2 * x)


def land_mask() -> np.ndarray:
    """Land on the imagery grid (row 0 at the top), rasterised from the GSHHS coastline."""
    path = CACHE / f"land_{GRID_TAG}.npy"
    if not path.exists():
        fig = plt.figure(figsize=(GRID_PX / 100, GRID_PX / 100), dpi=100)
        ax = fig.add_axes([0, 0, 1, 1], projection=MAP_CRS)
        ax.set_extent([-HALF_M, HALF_M, -HALF_M, HALF_M], crs=MAP_CRS)
        ax.spines["geo"].set_visible(False)
        ax.add_feature(cfeature.GSHHSFeature(scale="f", levels=[1], facecolor="black", edgecolor="none"))
        fig.canvas.draw()
        np.save(path, np.asarray(fig.canvas.buffer_rgba())[..., 0] < 128)
        plt.close(fig)
    return np.load(path)


def cloud_layer(rgb: np.ndarray, land: np.ndarray) -> np.ndarray:
    """White clouds with a soft drop shadow, as RGBA over the paper map.

    Cloud opacity comes from the true-color brightness, with a higher threshold over
    land, which is brighter than the sea. Thin cloud stays translucent and slightly grey."""
    lum = rgb.astype(np.float32).mean(axis=2) / 255
    alpha = np.where(land, smoothstep(0.50, 0.72, lum), smoothstep(0.32, 0.58, lum))
    blurred = gaussian_filter(alpha, 5)
    shadow = np.zeros_like(blurred)
    shadow[7:, 5:] = blurred[:-7, :-5] * 0.38  # light from the upper left
    tone = 1 - 0.10 * (1 - smoothstep(0.40, 0.90, lum))  # brighter tops are whiter
    a = alpha + shadow * (1 - alpha)
    out = np.empty(rgb.shape[:2] + (4,), np.float32)
    shade = np.array(matplotlib.colors.to_rgb(SHADOW))
    for c in range(3):
        out[..., c] = (tone * alpha + shade[c] * shadow * (1 - alpha)) / np.maximum(a, 1e-6)
    out[..., 3] = a * 0.96
    return out


class Fan:
    """Possible paths after the last fix: the last GPS velocity varied in speed, heading
    and a slow turn, integrated in map metres (the map is conformal and nearly true north here)."""

    def __init__(self, track: Track, end_t: float, n: int = FAN_N, seed: int = 7):
        rng = np.random.default_rng(seed)
        speed = track.dr_speed * np.clip(rng.normal(1, SPEED_ERR / 1.6, n), 1 - SPEED_ERR, 1 + SPEED_ERR)
        heading = track.dr_heading + np.clip(rng.normal(0, HEADING_ERR_DEG / 1.6, n), -HEADING_ERR_DEG, HEADING_ERR_DEG)
        turn = rng.normal(0, FAN_TURN_DEG_H, n) / 3600
        self.t = np.arange(track.last_fix_t, end_t + FAN_DT_S, FAN_DT_S)
        x0, y0 = to_map(track.flon[-1], track.flat[-1])
        h = np.radians(heading[:, None] + turn[:, None] * (self.t - self.t[0])[None, :])
        dx = speed[:, None] * np.sin(h) * FAN_DT_S
        dy = speed[:, None] * np.cos(h) * FAN_DT_S
        self.xy = np.stack([x0 + np.cumsum(dx, 1) - dx[:, :1], y0 + np.cumsum(dy, 1) - dy[:, :1]], axis=2)

    def segments(self, t: float):
        k = int(np.searchsorted(self.t, t, side="right"))
        return list(self.xy[:, :k]) if k >= 2 else []


def to_uv(lon, lat):
    """Map coordinates for the graphic: u across, v down, 0–1 over the map."""
    x, y = to_map(lon, lat)
    return round((x + HALF_M) / (2 * HALF_M), 5), round((HALF_M - y) / (2 * HALF_M), 5)


# ── backgrounds ──────────────────────────────────────────────────────────────

def map_layer(face: str, edge: str, linewidth: float) -> np.ndarray:
    """GSHHS land drawn on the imagery grid as RGBA floats (row 0 at the top)."""
    fig = plt.figure(figsize=(GRID_PX / 100, GRID_PX / 100), dpi=100)
    fig.patch.set_alpha(0)
    ax = fig.add_axes([0, 0, 1, 1], projection=MAP_CRS)
    ax.set_extent([-HALF_M, HALF_M, -HALF_M, HALF_M], crs=MAP_CRS)
    ax.spines["geo"].set_visible(False)
    ax.patch.set_alpha(0)
    ax.add_feature(cfeature.GSHHSFeature(scale="f", levels=[1], facecolor=face, edgecolor=edge,
                                         linewidth=linewidth))
    fig.canvas.draw()
    rgba = np.asarray(fig.canvas.buffer_rgba()).astype(np.float32) / 255
    plt.close(fig)
    return rgba


def over(base: np.ndarray, layer: np.ndarray, opacity: float = 1.0) -> np.ndarray:
    a = layer[..., 3:4] * opacity
    return base * (1 - a) + layer[..., :3] * a


def render_background(style: str, scans: Scans, times: np.ndarray, land: np.ndarray):
    """Encode one background frame per time to data/background_{style}.webm and .mp4."""
    if style == "map":
        paper = over(np.ones((GRID_PX, GRID_PX, 3), np.float32) * matplotlib.colors.to_rgb(SEA),
                     map_layer(LAND, "none", 0))
        paper = over(paper, map_layer("none", COAST, 0.75))
        frame = lambda img: over(paper, cloud_layer(img, land))
    else:
        coast = map_layer("none", "white", 0.65)
        frame = lambda img: over(img.astype(np.float32) / 255, coast, 0.28)
    stem = DATA / f"background_{style}"
    ffmpeg = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
         "-s", f"{GRID_PX}x{GRID_PX}", "-r", str(FPS), "-i", "-",
         "-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0", "-g", "10", "-row-mt", "1", "-cpu-used", "2",
         "-pix_fmt", "yuv420p", f"{stem}.webm",
         "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-g", "10", "-pix_fmt", "yuv420p",
         "-movflags", "+faststart", f"{stem}.mp4"], stdin=subprocess.PIPE)
    for k, t in enumerate(times):
        img, _ = scans.at(t)
        ffmpeg.stdin.write((np.clip(frame(img), 0, 1) * 255 + 0.5).astype(np.uint8).tobytes())
        if k % 100 == 0:
            print(f"  {style} frame {k}/{len(times)}")
    ffmpeg.stdin.close()
    if ffmpeg.wait():
        raise SystemExit("ffmpeg failed")
    print(f"Wrote {stem}.webm and .mp4")


# ── data ─────────────────────────────────────────────────────────────────────

def above_clouds_at(track: Track, clouds: CloudTops):
    """When the balloon first rose above the cloud tops under it, or None."""
    for t in np.arange(track.start.timestamp(), track.last_fix_t, 60.0):
        lat, lon, alt, *_ = track.at(t)
        height, _ = clouds.at(t, lat, lon)
        if height >= LOW_CLOUD_M and alt > height:
            return t
    return None


def flight_json(track: Track, fan: Fan, clouds: CloudTops, scans: Scans, times: np.ndarray) -> dict:
    nan = lambda v: None if v is None or (isinstance(v, float) and math.isnan(v)) else v
    packet_t = np.array([p.timestamp() for p in track.packets["time"]])

    frames = {k: [] for k in ("u", "v", "alt", "mode", "speed", "heading", "cloudTop", "cloudy", "packet", "scan", "status")}
    kinds = {"fix": "gps", "interp": "gps", "dr": "est", "lost": "silent"}
    statuses = ["Tracked by GPS", f"No GPS since {clock(track.last_fix_t)} · estimated",
                f"Silent since {clock(track.end_t)} · projected"]
    for t in times:
        lat, lon, alt, mode, _ = track.at(t)
        mode = kinds[mode]
        speed, heading = track.speed_heading(t)
        height, cloudy = clouds.at(t, lat, lon)
        u, v = to_uv(lon, lat)
        for key, value in (("u", u), ("v", v), ("alt", round(float(alt))), ("mode", mode),
                           ("speed", round(speed, 1)), ("heading", None if math.isnan(heading) else round(heading)),
                           ("cloudTop", nan(None if math.isnan(height) else round(height))),
                           ("cloudy", cloudy), ("packet", int(np.searchsorted(packet_t, t, side="right")) - 1),
                           ("scan", float(scans.times[np.argmin(np.abs(scans.times - t))])),
                           ("status", ["gps", "est", "silent"].index(mode))):
            frames[key].append(value)

    packets = []
    for row in track.packets.itertuples():
        located = [g for g in row.gateways if g.get("lat") is not None and g.get("lon") is not None]
        packets.append({"t": row.time.timestamp(), "temperature": nan(row.temperature),
                        "lux": nan(row.ambient_lux), "uv": nan(row.uv_index), "heardBy": len(row.gateways),
                        "receivers": [to_uv(g["lon"], g["lat"]) for g in located]})
    gateways = sorted({(round(g["lat"], 4), round(g["lon"], 4)) for row in track.packets.itertuples()
                       for g in row.gateways if g.get("lat") is not None and g.get("lon") is not None})

    launch_env = os.environ.get("LAUNCH_SITE")
    launch_lat, launch_lon = ((float(v) for v in launch_env.split(",")) if launch_env
                              else (track.flat[0], track.flon[0]))
    end_lat, end_lon, *_ = track.at(track.end_t)
    above_t = above_clouds_at(track, clouds)
    event = lambda t: dict(zip(("u", "v"), to_uv(*track.at(t)[1::-1])), t=t, alt=round(float(track.at(t)[2])))
    keep = np.arange(0, fan.t.size, 3)  # possible paths every minute are plenty for the eye
    to_u = lambda x: (x + HALF_M) / (2 * HALF_M)
    to_v = lambda y: (HALF_M - y) / (2 * HALF_M)
    pt = lambda t: [round(t, 1), *to_uv(*track.at(t)[1::-1])]
    fix_pts = [[round(t, 1), *to_uv(lon, lat)] for t, lat, lon in zip(track.ft.tolist(), track.flat, track.flon)]
    launch = (to_uv(launch_lon, launch_lat), LAUNCHED_AT.timestamp())
    labels = [{"t": 0, "u": launch[0][0], "v": launch[0][1], "marker": "launch",
               "lines": [[f"Launched from San Francisco, {clock(launch[1])}", "lead"]], "short": [[f"Launch, {clock(launch[1])}", "lead"]]}]
    if above_t is not None:
        labels.append({"t": above_t, **event(above_t), "under": 0, "lines": [[f"Above the low clouds by {clock(above_t)}", "lead"]],
                       "short": [[f"Above the clouds, {clock(above_t)}", "lead"]]})
    labels += [
        {"t": track.last_fix_t, **event(track.last_fix_t), "dy": -6,
         "lines": [[f"Last GPS fix, {clock(track.last_fix_t)}", "lead"], [f"{track.falt[-1] / 1000:.1f} km up", "muted"]],
         "short": [[f"Last fix, {clock(track.last_fix_t)}", "lead"], [f"{track.falt[-1] / 1000:.1f} km up", "muted"]]},
        {"t": track.end_t, **event(track.end_t), "dy": 8,
         "lines": [[f"Last transmission, {clock(track.end_t)}", "lead"], ["No GPS; position estimated", "muted"]],
         "short": [[f"Last packet, {clock(track.end_t)}", "lead"], ["No GPS; estimated", "muted"]]},
    ]
    for lab in labels:
        lab.pop("alt", None)
    return {
        "title": f"Stratolink 1, {local(track.start.timestamp()):%b}. {local(track.start.timestamp()).day}, {local(track.start.timestamp()):%Y}",
        "multiDay": False,
        "panel": ["speed", "clouds", "sun", "uv", "heard"],
        "sources": {"geocolor": "NOAA GOES-18 GeoColor imagery from CIRA RAMMB/SLIDER; cloud-top heights from GOES-18",
                    "map": "clouds from NOAA GOES-18 visible imagery; cloud-top heights from GOES-18"},
        "statuses": statuses,
        "segments": [{"kind": "gps", "pts": fix_pts},
                     {"kind": "est", "pts": [fix_pts[-1], pt(track.end_t)]},
                     {"kind": "silent", "pts": [pt(track.end_t), pt(track.view_end_t)]}],
        "labels": labels,
        "axisNotes": [{"t": track.last_fix_t, "text": "Last GPS fix", "short": "Last fix", "anchor": "end", "cls": "lead", "dx": 2},
                      {"t": track.end_t, "text": "Last transmission", "short": "Last packet", "anchor": "start", "cls": "lead", "dx": -2}],
        "map": {"km": 2 * HALF_M / 1000, "aspect": 1, "ocean": [[0.2, 0.72], [0.22, 0.4], [0.2, 0.88]]},
        "frames": {"t0": float(times[0]), "step": STEP_S, "fps": FPS, "count": len(times), **frames},
        "facts": {"km": round(GEOD.inv(launch_lon, launch_lat, end_lon, end_lat)[2] / 1000),
                  "peakKm": round(track.end_alt / 1000, 1),
                  "speedFrom": round(float(track.fixes["gps_speed"].iloc[0])),
                  "speedTo": round(track.dr_speed), "lowCloudM": LOW_CLOUD_M},
        "launch": ({"t": LAUNCHED_AT.timestamp(), **dict(zip(("u", "v"), to_uv(launch_lon, launch_lat)))}
                   if launch_env else None),
        "events": {"aboveClouds": event(above_t) if above_t is not None else None,
                   "lastFix": event(track.last_fix_t), "lastPacket": event(track.end_t), "end": event(track.view_end_t)},
        "fixes": [{"t": t, **dict(zip(("u", "v"), to_uv(lon, lat)))} for t, lat, lon in
                  zip(track.ft.tolist(), track.flat, track.flon)],
        "packets": packets,
        "gateways": [to_uv(lon, lat) for lat, lon in gateways],
        "cities": [{"name": name, **dict(zip(("u", "v"), to_uv(lon, lat)))} for name, lat, lon in CITIES],
        "fan": {"t": fan.t[keep].tolist(),
                "paths": [[[round(to_u(x), 4), round(to_v(y), 4)] for x, y in path[keep]] for path in fan.xy]},
    }


def main(styles, video=True, public=False):
    DATA.mkdir(parents=True, exist_ok=True)
    if public:
        os.environ["LAUNCH_SITE"] = "37.76,-122.44"  # the dashboard's public San Francisco point
    track = Track(fetch_telemetry(public))
    print(f"Window {track.start:%Y-%m-%d %H:%M:%S} → {track.end:%H:%M:%S} UTC; "
          f"{len(track.fixes)} fixes, {len(track.packets)} packets; final altitude ≈ {track.end_alt:.0f} m")
    t0, t1 = track.start.timestamp(), track.view_end_t
    times = np.append(np.arange(t0, t1, STEP_S), t1)
    clouds = CloudTops(track.start.to_pydatetime(), utc(t1))
    land = land_mask()
    scans = None
    for style in styles:
        scans = Scans(*load_imagery(track.start.to_pydatetime(), utc(t1), style))
        if video:
            render_background(style, scans, times, land)
    out = SITE_ASSETS / "flight.json" if public else DATA / "flight.json"
    out.write_text(json.dumps(flight_json(track, Fan(track, t1), clouds, scans, times), separators=(",", ":")))
    print(f"Wrote {out}")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--style", choices=["map", "geocolor"], action="append",
                        help="background(s) to render; default both")
    parser.add_argument("--json-only", action="store_true", help="rewrite flight.json without the videos")
    parser.add_argument("--public", action="store_true",
                        help="use only what the public dashboard shows (launch-area positions masked), for publishing")
    args = parser.parse_args()
    main(args.style or ["map", "geocolor"], video=not args.json_only, public=args.public)
