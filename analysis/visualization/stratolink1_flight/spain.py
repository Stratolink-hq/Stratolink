"""DRAFT: Stratolink 3 over Spain (May 28–29, 2026), as a third flight figure for "Flights from a
satellite view". Writes the figure's data and backgrounds into the site, untracked:

    web/public/assets/flights/stratolink-3-spain/flight.json
    web/public/assets/flights/stratolink-3-spain/background-geocolor.mp4   satellite
    web/public/assets/flights/stratolink-3-spain/background-map.mp4        paper map, clouds, night

Telemetry. The May 28 packets came in under the stratolink-3-eu alias, which the public telemetry
API leaves out, so they are read from Supabase's telemetry table (read only, service key from
web/.env.local) and cached in data/ (gitignored). The May 29 packets near Málaga and the wind
reconstruction through the gaps come from the public dashboard API, as for stratolink3.py.

Track. Split fixes (a stale latitude with a fresh longitude) are repaired first. The first fix is
drawn at about 05:40 UTC rather than with its 07:38 packet: that packet re-sent a cached position
some two hours old (see FIRST_FIX_AT), so its time is an estimate from the winds. Then, as in
stratolink3.py, a fix is a GPS position that differs from the one before (the
receiver repeated one position from 11:22 a.m. to 6:23 p.m. CEST on May 28), fixes under two hours
apart are joined with straight lines, and longer gaps follow the reconstruction, straight across
any stretch where it sits on a repeated position. Altitude comes from pressure.

Window. From 5:00 a.m. CEST on May 28, before the first packet heard over Spain, on the reconstruction, to the last
ping with a position, an hour after the last fix near Málaga; the GPS had frozen, and the line
follows the reconstruction's frozen tail along the winds.

Imagery. EUMETSAT's MTG GeoColour (Meteosat-12 FCI full disk, every 10 minutes) from the
EUMETView WMS, in plate carrée, resampled onto the map. It is about 2 km, so by day it is sharpened
with the 500 m VIS0.6 band (FCI HRFI) from the same WMS (see sharpen). Scans (export.py) moves the clouds between
scans. The paper map's clouds are the GeoColour's bright, grey pixels.

    python spain.py              # data and both backgrounds
    python spain.py --json-only
"""
from __future__ import annotations

import io
import json
import math
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import cartopy.crs as ccrs
import cv2
import matplotlib
import numpy as np
import pandas as pd
import pyproj
import requests
from PIL import Image
from scipy.ndimage import gaussian_filter, median_filter

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import cartopy.feature as cfeature

from export import CACHE, SEA, LAND, COAST, SHADOW, Scans, over, smoothstep

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
OUT = REPO / "web" / "public" / "assets" / "flights" / "stratolink-3-spain"
PRIVATE = HERE / "data" / "stratolink3_eu_telemetry.json"
# A local compute's reconstruction with the frozen tail (the winds from the last fix to the last
# ping); its tail is used only where the dashboard's reconstruction stops short of it.
TAIL = HERE / "data" / "stratolink3_recon_tail.json"
MTG_CACHE = CACHE.parent / "mtg_cache"  # a folder per WMS box
SITE = "https://stratolink.org"
DEVICE, ALIAS = "stratolink-3", "stratolink-3-eu"
FIELDS = "time,lat,lon,altitude_m,pressure,gps_speed,gps_heading,temperature,ambient_lux,uv_index,rssi,gateways"
START = pd.Timestamp("2026-05-28T07:00:00Z")  # packets from here on
END = pd.Timestamp("2026-05-29T20:15:00Z")
# The first Spain packet (07:38 UTC) carried a cached GPS position about two hours old: the next
# fix is 36 km on at 08:13, 17 m/s where the GPS read 4–5 m/s, and a GFS trajectory run back from
# 08:13 passes within a few km of it around 05:40. The fix is drawn then, the packet stays at 07:38.
FIRST_FIX_AT = pd.Timestamp("2026-05-28T05:40:00Z")
START_AT = pd.Timestamp("2026-05-28T03:00:00Z")  # the figure starts at 5:00 a.m. CEST, before the first packet over Spain  # the figure starts this long before the first fix, on the reconstruction, and ends at the last packet
STEP_S, FPS = 300.0, 24
GPS_GAP_S = 2 * 3600
HEARD_S = 30 * 60
TZ = ZoneInfo("Europe/Madrid")

# Map: Lambert conformal over western and southern Spain, the Portuguese coast to past Madrid.
MAP_CRS = ccrs.LambertConformal(central_longitude=-5.6, central_latitude=38.75, standard_parallels=(37.0, 40.5))
X0, X1, Y0, Y1 = -300_000, 300_000, -320_000, 300_000
GRID_W = 1080
GRID_H = 2 * round(GRID_W * (Y1 - Y0) / (X1 - X0) / 2)  # even, for H.264
GEOD = pyproj.Geod(ellps="WGS84")

CITIES = [("Madrid", 40.4168, -3.7038), ("Salamanca", 40.9701, -5.6635), ("Cáceres", 39.4753, -6.3724),
          ("Seville", 37.3891, -5.9845), ("Córdoba", 37.8882, -4.7794), ("Málaga", 36.7213, -4.4214)]

# WMS source grid (EPSG:4326), a little larger than the map.
WMS = "https://view.eumetsat.int/geoserver/ows"
LAYER = "mtg_fd:rgb_geocolour"
LON0, LON1, LAT0, LAT1, RES = -11.0, -1.6, 35.6, 41.9, 0.006
# The 500 m visible band (FCI HRFI VIS0.6), for daytime detail; DETAIL scales how much it adds.
VIS_LAYER, VIS_RES, DETAIL = "mtg_fd:vis06_hrfi", 0.004, 1.3


def local(t: float) -> datetime:
    return datetime.fromtimestamp(t, timezone.utc).astimezone(TZ)


def clock(t: float, day: bool = False) -> str:
    d = local(t)
    s = "noon" if (d.hour, d.minute) == (12, 0) else f"{d.hour % 12 or 12}:{d.minute:02d} {'a.m.' if d.hour < 12 else 'p.m.'}"
    return f"{s}, May {d.day}" if day else s


# ── telemetry ────────────────────────────────────────────────────────────────

def private_packets() -> list:
    if PRIVATE.exists():
        return json.loads(PRIVATE.read_text())
    env = dict(l.split("=", 1) for l in (REPO / "web" / ".env.local").read_text().splitlines() if "=" in l and not l.startswith("#"))
    base, key = env["NEXT_PUBLIC_SUPABASE_URL"].strip().strip('"'), env["SUPABASE_SERVICE_ROLE_KEY"].strip().strip('"')
    r = requests.get(f"{base}/rest/v1/telemetry", params={"select": FIELDS, "device_id": f"eq.{ALIAS}", "order": "time.asc", "limit": "2000"},
                     headers={"apikey": key, "Authorization": f"Bearer {key}"}, timeout=30)
    r.raise_for_status()
    PRIVATE.parent.mkdir(exist_ok=True)
    PRIVATE.write_text(json.dumps(r.json()))
    return r.json()


def public(params) -> list:
    r = requests.get(f"{SITE}/api/telemetry", params={"resource": "telemetry", "device_id": f"eq.{DEVICE}", "select": FIELDS, **params}, timeout=30)
    r.raise_for_status()
    return r.json()


def fetch():
    rows = private_packets() + public({"time": f"gte.{START.isoformat()}", "order": "time.asc", "limit": "1000"})
    df = pd.DataFrame(rows)
    df["time"] = pd.to_datetime(df["time"], utc=True, format="ISO8601")
    df = df[(df["time"] >= START) & (df["time"] <= END)].sort_values("time").reset_index(drop=True)
    df["gateways"] = [g if isinstance(g, list) else [] for g in df["gateways"]]
    before = public({"time": f"lte.{START.isoformat()}", "order": "time.desc", "limit": "1"})
    previous = pd.Timestamp(before[0]["time"]).timestamp() if before else None
    fix = public({"time": f"lte.{START.isoformat()}", "lat": "not.is.null", "order": "time.desc", "limit": "1"})
    bridge_start = pd.Timestamp(fix[0]["time"]).timestamp() if fix else None  # where the long gap's bridge begins
    # The dashboard's reconstruction (cache-busted: the API is CDN-cached for minutes).
    r = requests.get(f"{SITE}/api/forecast", params={"device": DEVICE, "view": "history", "cb": int(datetime.now().timestamp())}, timeout=60)
    r.raise_for_status()
    observed = r.json()["observed"]
    recon = pd.DataFrame(observed["reconstructed_track"])
    if TAIL.exists():
        tail = pd.DataFrame(json.loads(TAIL.read_text())["observed"]["reconstructed_track"])
        end = pd.to_datetime(recon["time_utc"], utc=True, format="ISO8601").max()
        recon = pd.concat([recon, tail[pd.to_datetime(tail["time_utc"], utc=True, format="ISO8601") > end]], ignore_index=True)
    recon["t"] = pd.to_datetime(recon["time_utc"], utc=True, format="ISO8601").map(lambda x: x.timestamp())
    return df, recon[["t", "lat", "lon"]].sort_values("t").to_numpy(), previous, bridge_start


def repair_split_fixes(rows: pd.DataFrame) -> pd.DataFrame:
    """The May 2026 firmware read the GPS a field at a time, latitude first; when only the latitude
    read timed out, a packet paired the cached old latitude with a fresh longitude, and the fresh
    latitude came in the next packet. For packets a, b, c in turn (repeats included): if b has a's
    latitude but a new longitude, and c, at most 15 minutes later, has a new latitude, b takes c's
    latitude. As repairSplitFixes in web/lib/wind/trackSegments.ts."""
    rows = rows.sort_values("time").copy()
    lat, lon, t = rows["lat"].to_numpy(float, copy=True), rows["lon"].to_numpy(float), rows["time"].to_numpy()
    for i in range(1, len(rows) - 1):
        if lat[i] == lat[i - 1] and lon[i] != lon[i - 1] and lat[i + 1] != lat[i] and t[i + 1] - t[i] <= np.timedelta64(15, "m"):
            lat[i] = lat[i + 1]
    rows["lat"] = lat
    return rows


class Track:
    """Positions at any time from fixes and the reconstruction (as in stratolink3.py)."""

    def __init__(self, df: pd.DataFrame, recon: np.ndarray, t0: float, bridge_start: float | None = None):
        rows = repair_split_fixes(df.dropna(subset=["lat", "lon"]))
        fixes, last = [], None
        for row in rows.itertuples():
            if last is not None and abs(row.lat - last[0]) < 1e-6 and abs(row.lon - last[1]) < 1e-6:
                continue
            last = (row.lat, row.lon)
            fixes.append((row.time.timestamp(), row.lat, row.lon))
        self.fixes = np.array(fixes)
        # The first fix at its estimated time (FIRST_FIX_AT); the reconstruction's bridge into it, built
        # for the packet's time, is squeezed to end there, and the line runs straight to the next fix.
        t_packet, t_fix = self.fixes[0, 0], FIRST_FIX_AT.timestamp()
        self.fixes[0, 0] = t_fix
        if bridge_start is not None:
            recon = recon.copy()
            into = (recon[:, 0] > bridge_start) & (recon[:, 0] <= t_packet + 1)
            recon[into, 0] = bridge_start + (recon[into, 0] - bridge_start) * (t_fix - bridge_start) / (t_packet - bridge_start)
        self.packets = df
        self.packet_t = np.array([t.timestamp() for t in df["time"]])
        self.gps_spans = []
        lead = recon[(recon[:, 0] >= t0 - 3600) & (recon[:, 0] < self.fixes[0, 0] - 1)]
        pts = [tuple(p) for p in lead] + [tuple(self.fixes[0])]
        for (ta, la, oa), (tb, lb, ob) in zip(self.fixes[:-1], self.fixes[1:]):
            inner = recon[(recon[:, 0] > ta + 1) & (recon[:, 0] < tb - 1)]
            # The reconstruction sits on a repeated position while the GPS is stuck; the line runs
            # straight through that and follows the reconstruction once it moves on.
            parked = (np.abs(inner[:, 1] - la) < 1e-3) & (np.abs(inner[:, 2] - oa) < 1e-3)
            moving = inner[np.cumsum(~parked) > 0] if len(inner) else inner
            if ta == t_fix:
                pass  # straight from the re-timed first fix; the bridge after it assumed the old time
            elif tb - ta <= GPS_GAP_S:
                self.gps_spans.append((ta, tb))
            elif len(moving):
                pts += [tuple(p) for p in moving]
            pts.append((tb, lb, ob))
        # After the last fix the GPS froze while packets kept coming; the reconstruction's tail
        # follows the winds to the last ping.
        pts += [tuple(p) for p in recon[recon[:, 0] > self.fixes[-1, 0] + 1]]
        self.pts = np.array(pts)
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


def target_lonlat():
    X, Y = np.meshgrid(np.linspace(X0, X1, GRID_W), np.linspace(Y1, Y0, GRID_H))
    ll = ccrs.PlateCarree().transform_points(MAP_CRS, X, Y)
    return ll[..., 0], ll[..., 1]


def solar_cos_zenith(t: float, lat, lon):
    d = t / 86400.0 - 10957.5
    g = np.radians((357.529 + 0.98560028 * d) % 360)
    q = (280.459 + 0.98564736 * d) % 360
    lam = np.radians(q + 1.915 * np.sin(g) + 0.020 * np.sin(2 * g))
    eps = np.radians(23.439 - 0.00000036 * d)
    ra, dec = np.arctan2(np.cos(eps) * np.sin(lam), np.cos(lam)), np.arcsin(np.sin(eps) * np.sin(lam))
    ha = np.radians(((18.697374558 + 24.06570982441908 * d) % 24) * 15 + lon) - ra
    lat = np.radians(lat)
    return np.sin(lat) * np.sin(dec) + np.cos(lat) * np.cos(dec) * np.cos(ha)


def scan(t: pd.Timestamp, layer: str = LAYER, res: float = RES):
    """One scan of a layer over the WMS box, cached; None if EUMETView has nothing for it."""
    path = MTG_CACHE / f"{'' if layer == LAYER else layer.split(':')[1] + '_'}{LON0}_{LON1}_{LAT0}_{LAT1}_{res}" / f"{t:%Y%m%dT%H%M}.png"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        w, h = round((LON1 - LON0) / res), round((LAT1 - LAT0) / res)
        r = requests.get(WMS, params={"service": "WMS", "version": "1.3.0", "request": "GetMap", "layers": layer, "styles": "",
                                      "crs": "EPSG:4326", "bbox": f"{LAT0},{LON0},{LAT1},{LON1}", "width": w, "height": h,
                                      "format": "image/png", "time": f"{t:%Y-%m-%dT%H:%M:%SZ}"}, timeout=120)
        if r.status_code != 200 or not r.headers.get("content-type", "").startswith("image/"):
            return None
        path.write_bytes(r.content)
    img = np.asarray(Image.open(path).convert("RGB"))
    return None if img.max() < 10 else img


def scan_times(t0: float, t1: float) -> pd.DatetimeIndex:
    return pd.date_range(pd.Timestamp(t0, unit="s", tz="UTC").floor("10min"), pd.Timestamp(t1, unit="s", tz="UTC").ceil("10min"), freq="10min")


def sharpen(rgb: np.ndarray, vis: np.ndarray, day: np.ndarray) -> np.ndarray:
    """GeoColour (about 2 km) sharpened by day with the 500 m VIS0.6: its colors, smoothed of the 2 km
    blocks, times the ratio of the visible band to a blur of itself (detail finer than 2 km). The
    band comes as 8-bit grey from the WMS, so it is smoothed a little first."""
    f = rgb.astype(np.float32) / 255
    ratio = np.clip((vis + 2) / (gaussian_filter(vis, 1.2) + 2), 0.6, 1.6)
    f = gaussian_filter(f, (1.0, 1.0, 0)) * (1 + DETAIL * (ratio - 1) * day)[..., None]
    return (np.clip(f, 0, 1) * 255 + 0.5).astype(np.uint8)


def imagery(t0: float, t1: float):
    times = scan_times(t0, t1)
    lon, lat = target_lonlat()
    day = {t: smoothstep(0.03, 0.2, solar_cos_zenith(t.timestamp(), lat, lon)) for t in times}
    with ThreadPoolExecutor(6) as pool:  # EUMETView renders each image; kept gentle on a free service
        raw = list(pool.map(scan, times))
        vis = list(pool.map(lambda t: scan(t, VIS_LAYER, VIS_RES) if day[t].max() > 0 else None, times))
    mx, my = ((lon - LON0) / RES).astype(np.float32), ((LAT1 - lat) / RES).astype(np.float32)
    vx, vy = ((lon - LON0) / VIS_RES).astype(np.float32), ((LAT1 - lat) / VIS_RES).astype(np.float32)
    keep = []
    for t, img, v in zip(times, raw, vis):
        if img is None:
            continue
        rgb = cv2.remap(img, mx, my, cv2.INTER_CUBIC)
        if v is not None:
            rgb = sharpen(rgb, cv2.remap(gaussian_filter(v[..., 0].astype(np.float32), 0.6), vx, vy, cv2.INTER_LINEAR), day[t])
        keep.append((t.timestamp(), rgb))
    print(f"{len(keep)} of {len(times)} scans, {sum(v is not None for v in vis)} sharpened")
    return np.array([k[0] for k in keep]), [k[1] for k in keep]


def cloud_alpha(rgb: np.ndarray) -> np.ndarray:
    """Clouds as the GeoColour's bright, grey pixels; city lights (small and warm) filtered out."""
    f = rgb.astype(np.float32) / 255
    grey = 1 - (f.max(2) - f.min(2)) / np.maximum(f.max(2), 1e-3)
    a = smoothstep(0.42, 0.78, f.min(2)) * smoothstep(0.55, 0.85, grey)
    return median_filter(a, 5)


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
    fig.canvas.draw()
    rgba = np.asarray(fig.canvas.buffer_rgba()).astype(np.float32) / 255
    plt.close(fig)
    return rgba


def render(style: str, frames, out: Path):
    import subprocess
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


def backgrounds(times, sats, frame_t):
    sat = Scans(times, sats)
    coast = gshhs("none", "white", 0.6, borders=True)
    render("geocolor", (over(sat.at(t)[0].astype(np.float32) / 255, coast, 0.3) for t in frame_t), OUT / "background-geocolor.mp4")
    cloud = Scans(times, [np.repeat((cloud_alpha(s) * 255).astype(np.uint8)[..., None], 3, 2) for s in sats])
    paper = over(np.ones((GRID_H, GRID_W, 3), np.float32) * matplotlib.colors.to_rgb(SEA), gshhs(LAND, "none", 0))
    paper = over(paper, gshhs("none", COAST, 0.7, borders=True))
    shade = np.array(matplotlib.colors.to_rgb(SHADOW))
    navy = np.array([0.16, 0.2, 0.3])
    lon, lat = target_lonlat()

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

def located(gateways: list) -> list:
    return [g for g in gateways if g.get("lat") is not None and g.get("lon") is not None]


def flight_json(track: Track, frame_t: np.ndarray, scan_t: np.ndarray, previous: float | None) -> dict:
    nan = lambda v: None if v is None or (isinstance(v, float) and math.isnan(v)) else v
    frames = {k: [] for k in ("u", "v", "alt", "mode", "speed", "heading", "packet", "scan", "night", "status")}
    statuses = []
    fixes_t = track.fixes[:, 0]
    for t in frame_t:
        lat, lon = track.at(t)
        mode = track.mode(t)
        speed, heading = track.velocity(t)
        k = int(np.searchsorted(track.packet_t, t, side="right")) - 1
        last_fix = fixes_t[fixes_t <= t].max() if (fixes_t <= t).any() else fixes_t[0]
        status = {"gps": "Tracked by GPS",
                  "est": f"No new GPS fix since {clock(last_fix)} · estimated",
                  "silent": f"Silent since {clock(track.packet_t[k])} · estimated" if k >= 0
                  else f"Silent since {clock(previous, True)} · estimated" if previous else "Not heard yet · estimated"}[mode]
        if status not in statuses:
            statuses.append(status)
        u, v = to_uv(lon, lat)
        for key, value in (("u", u), ("v", v), ("alt", round(track.altitude(t))), ("mode", mode),
                           ("speed", round(speed, 1)), ("heading", round(heading)), ("packet", k),
                           ("scan", float(scan_t[np.argmin(np.abs(scan_t - t))])),
                           ("night", int(solar_cos_zenith(t, lat, lon) < -0.05)), ("status", statuses.index(status))):
            frames[key].append(value)

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

    packets = [{"t": row.time.timestamp(), "temperature": nan(row.temperature), "lux": None, "uv": nan(row.uv_index),
                "heardBy": len(row.gateways), "receivers": [to_uv(g["lon"], g["lat"]) for g in located(row.gateways)]}
               for row in track.packets.itertuples()]
    # The receivers that report a location (about a third: many in Spain don't); Packet Broker's
    # forwarded receptions each carry the forwarding gateway's.
    gateways = sorted({(round(g["lat"], 4), round(g["lon"], 4)) for row in track.packets.itertuples() for g in located(row.gateways)})

    f = track.fixes
    pos = lambda t: dict(zip(("u", "v"), to_uv(*track.at(t)[::-1])))
    stuck_t = f[1 + np.argmax(np.diff(f[1:, 0]) > GPS_GAP_S), 0]  # past the re-timed first fix
    after_stuck = f[f[:, 0] > stuck_t][0, 0]
    before_dark = track.packet_t[np.argmax(np.diff(track.packet_t) > 6 * 3600)]
    heard_again = track.packet_t[track.packet_t > before_dark + 6 * 3600][0]
    mid = (before_dark + heard_again) / 2
    last_packet = track.packet_t[-1]
    gap_h = round((heard_again - before_dark) / 3600)
    first_packet = track.packet_t[0]
    silent_days = round((first_packet - previous) / 86400) if previous else None
    # Only where it was first and last heard end up on the map; the rest show while their stretch plays,
    # so the map never carries more than a few at once; each is placed clear of the track and the
    # lines to the receivers. The readout and timeline say the rest.
    labels = [
        {"clear": True, "t": f[0, 0], "until": stuck_t, **pos(f[0, 0]), "marker": "launch", "side": "left", "dy": 18,
         "lines": [[f"Position at about {clock(f[0, 0])}", "lead"], ["Time estimated from winds", "muted"]],
         "short": [[f"About {clock(f[0, 0])}", "lead"], ["time estimated", "muted"]]},
        # Off while the silent label, just east of it, is up; back for the last frame.
        *({"clear": True, "t": t, "until": until, **pos(first_packet), "dy": 18, "lines": [[f"Heard over Spain, {clock(first_packet)}", "lead"]],
           "short": [[f"Heard, {clock(first_packet)}", "lead"]]} for t, until in ((first_packet, before_dark), (heard_again, None))),
        {"clear": True, "t": stuck_t, "until": after_stuck, **pos(stuck_t), "lines": [[f"GPS stuck at {clock(stuck_t)}", "lead"], ["Estimated from winds", "muted"]],
         "short": [[f"GPS stuck, {clock(stuck_t)}", "lead"]]},
        {"clear": True, "t": before_dark, "until": heard_again, **pos(before_dark), "lines": [[f"Silent from {clock(before_dark)}", "lead"], ["Estimated from winds", "muted"]],
         "short": [[f"Silent from {clock(before_dark)}", "lead"], ["Estimated from winds", "muted"]]},
        {"clear": True, "t": heard_again, **pos(heard_again), "side": "left", "dy": -10, "lines": [["Heard again near Málaga", "lead"], [clock(heard_again, True), "muted"]],
         "short": [["Heard again", "lead"], [clock(heard_again), "muted"]]},
        {"clear": True, "t": last_packet, **pos(last_packet), "side": "left", "lines": [[f"Last packet, {clock(last_packet)}", "lead"], ["Position estimated from winds", "muted"]],
         "short": [["Last packet", "lead"], [clock(last_packet), "muted"]]},
    ]
    return {
        "map": {"km": (X1 - X0) / 1000, "aspect": round(GRID_H / GRID_W, 5), "ocean": []},
        "title": "Stratolink 3, May 28–29, 2026",
        "multiDay": True,
        "tz": "Europe/Madrid", "zoneName": "CEST",
        "sources": {"geocolor": "EUMETSAT MTG GeoColour imagery from EUMETView; path through the gaps from Stratolink’s wind reconstruction",
                    "map": "clouds from EUMETSAT MTG GeoColour imagery; path through the gaps from Stratolink’s wind reconstruction"},
        "events": {"lastPacket": {"t": last_packet, **pos(last_packet)}},
        "panel": ["speed", "uv", "heard"],
        "frames": {"t0": float(frame_t[0]), "step": STEP_S, "fps": FPS, "count": len(frame_t), **frames},
        "statuses": statuses,
        "segments": segments,
        "labels": labels,
        "axisNotes": [{"t": frame_t[0], "text": f"Unheard since {clock(previous, True)}" if previous else "Not heard yet", "short": "Unheard", "anchor": "start", "cls": "muted"},
                      {"t": mid, "text": f"{gap_h} hours without a packet", "short": f"{gap_h} h silent", "anchor": "middle", "cls": "muted"}],
        "fixes": [{"t": t, **dict(zip(("u", "v"), to_uv(lon, lat)))} for t, lat, lon in f],
        "packets": packets,
        "gateways": [list(to_uv(lon, lat)) for lat, lon in gateways],
        "cities": [{"name": n, **dict(zip(("u", "v"), to_uv(lon, lat)))} for n, lat, lon in CITIES],
        "facts": {},
    }


def main(video: bool):
    OUT.mkdir(parents=True, exist_ok=True)
    df, recon, previous, bridge_start = fetch()
    # The figure ends at the last ping that carried a position, where the reconstruction's tail ends.
    t1 = df.dropna(subset=["lat", "lon"])["time"].iloc[-1].timestamp()
    df = df[df["time"].map(lambda x: x.timestamp()) <= t1 + 1].reset_index(drop=True)
    frame_t = t1 - STEP_S * np.arange(math.floor((t1 - START_AT.timestamp()) / STEP_S), -1, -1)  # the last frame is the last ping
    t0 = float(frame_t[0])
    track = Track(df, recon, t0, bridge_start)
    print(f"{len(track.fixes)} fixes, {len(track.packets)} packets, {len(track.pts)} track points")
    if video:
        times, sats = imagery(t0, t1)
        backgrounds(times, sats, frame_t)
    else:
        times = scan_times(t0, t1).map(lambda x: x.timestamp()).to_numpy()
    (OUT / "flight.json").write_text(json.dumps(flight_json(track, frame_t, np.asarray(times, float), previous), separators=(",", ":")))
    print(f"Wrote {OUT / 'flight.json'}")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--json-only", action="store_true")
    main(video=not parser.parse_args().json_only)
