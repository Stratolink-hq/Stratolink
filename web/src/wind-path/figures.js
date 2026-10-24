/* Figures for "Drawing the path between packets". Same chrome as the payload dev log's
 * charts (a card with a heading and a legend, canvas maps on the muted paper with the
 * wind drawn across them), but no controls: each figure plays a short animation on a
 * loop while it is on screen, and shows its finished frame under prefers-reduced-motion.
 * Data comes from the bundle in /assets/wind-path, built by scripts/blog/
 * wind_path_figure_data.py, wind_path_forecast_only.py and wind_path_background_winds.py. */
import { colors, heatColor, observeChartSize } from '../payload-dev-log/charts.js';

const ASSETS = '/assets/wind-path';
const INK = '#292927', PAPER = '#eeeee9', GRID = '#d7d8d1', COAST = '#959c93', CREAM = '#f6f4ef';
const RED = colors[0], BLUE = colors[4], GRAY = '#6f716b';
const rad = Math.PI / 180, R = 6371;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const fmt = (n, p = 0) => Number(n).toLocaleString('en-US', { maximumFractionDigits: p });
function km(lat1, lon1, lat2, lon2) {
  const a = Math.sin((lat2 - lat1) * rad / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const cache = new Map();
function load(file) {
  const url = file.startsWith('/') ? file : `${ASSETS}/${file}`;
  if (!cache.has(url)) cache.set(url, fetch(url).then(response => {
    if (!response.ok) throw new Error('Figure data unavailable');
    return url.endsWith('.bin') ? response.arrayBuffer() : response.json();
  }).catch(error => { cache.delete(url); throw error; }));
  return cache.get(url);
}

/* ── map on canvas ──────────────────────────────────────────────────────────── */
const GAP_VIEW = { lon0: -112, lon1: 0, lat0: 14, lat1: 56 };
const FLIGHT_VIEW = { lon0: -128, lon1: 2, lat0: 23, lat1: 53 };
const WINDS_VIEW = { lon0: -112, lon1: 2, lat0: 24, lat1: 55 };
const WIDE_VIEW = { lon0: -125, lon1: 35, lat0: 8, lat1: 68 };
const WORLD = { lon0: -30, lon1: 330, lat0: -12, lat1: 78, wrap: true };

function createMap(bounds, label, aspect) {
  const canvas = document.createElement('canvas');
  canvas.className = 'fleet-map'; canvas.tabIndex = 0; canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', label);
  const ctx = canvas.getContext('2d');
  const m = { canvas, ctx, bounds: { ...bounds }, width: 0, height: 0 };
  const span = () => m.bounds.lon1 - m.bounds.lon0;
  m.lon = lon => m.bounds.wrap ? m.bounds.lon0 + (((lon - m.bounds.lon0) % 360) + 360) % 360 : lon;
  m.x = lon => (m.lon(lon) - m.bounds.lon0) / span() * m.width;
  m.y = lat => (m.bounds.lat1 - lat) / (m.bounds.lat1 - m.bounds.lat0) * m.height;
  m.point = (lat, lon) => [m.x(lon), m.y(lat)];
  m.inView = (lat, lon) => lat >= m.bounds.lat0 && lat <= m.bounds.lat1 && m.lon(lon) >= m.bounds.lon0 && m.lon(lon) <= m.bounds.lon1;
  m.resize = width => {
    const b = m.bounds, height = Math.round(width * (aspect ?? (b.lat1 - b.lat0) / ((b.lon1 - b.lon0) * Math.cos((b.lat0 + b.lat1) / 2 * rad))));
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = width * dpr; canvas.height = height * dpr; canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); m.width = width; m.height = height;
  };
  m.line = (pts, { color = INK, width = 1, alpha = 1, dash, latFirst = true, end } = {}) => {
    ctx.beginPath(); let px;
    const n = end === undefined ? pts.length : Math.min(pts.length, end);
    for (let k = 0; k < n; k++) {
      const p = pts[k], lat = latFirst ? p[0] : p[1], lon = latFirst ? p[1] : p[0], x = m.x(lon), y = m.y(lat);
      if (px === undefined || Math.abs(x - px) > m.width / 2) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      px = x;
    }
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.globalAlpha = alpha; ctx.setLineDash(dash || []); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
  };
  m.dot = (lat, lon, r, fill, stroke, lineWidth = 1.5, alpha = 1) => {
    const [x, y] = m.point(lat, lon);
    ctx.globalAlpha = alpha; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke(); }
    ctx.globalAlpha = 1;
  };
  m.label = (lat, lon, text, dx = 8, dy = 4, color = INK) => {
    const [x, y] = m.point(lat, lon);
    ctx.fillStyle = color; ctx.font = '11px Helvetica, Arial, sans-serif'; ctx.textAlign = dx < 0 ? 'right' : 'left'; ctx.fillText(text, x + dx, y + dy);
  };
  m.arrow = (lat, lon, u, v, { alpha = .36, width = 1, scale = 3.2, max = 12 } = {}) => {
    const [x, y] = m.point(lat, lon), speed = Math.hypot(u, v), len = clamp(speed / scale, 1.5, max);
    ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(-v, u)); ctx.strokeStyle = `rgb(${heatColor(speed / 65).join(',')})`; ctx.globalAlpha = alpha; ctx.lineWidth = width;
    ctx.beginPath(); ctx.moveTo(-len / 2, 0); ctx.lineTo(len / 2, 0); ctx.lineTo(len / 2 - 2.2, -1.9); ctx.moveTo(len / 2, 0); ctx.lineTo(len / 2 - 2.2, 1.9); ctx.stroke(); ctx.restore();
  };
  m.rect = (lat0, lon0, h, w, { color = BLUE, alpha = 1, width = 1, fill } = {}) => {
    const [x0, y1] = m.point(lat0, lon0), [x1, y0] = m.point(lat0 + h, lon0 + w);
    ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = width; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    if (fill) { ctx.globalAlpha = fill; ctx.fillStyle = color; ctx.fillRect(x0, y0, x1 - x0, y1 - y0); }
    ctx.globalAlpha = 1;
  };
  m.base = (coast, step = 10) => {
    const b = m.bounds;
    ctx.clearRect(0, 0, m.width, m.height); ctx.fillStyle = PAPER; ctx.fillRect(0, 0, m.width, m.height);
    for (let lat = Math.ceil(b.lat0 / step) * step; lat < b.lat1; lat += step) m.line([[lat, b.lon0], [lat, b.lon1 - 1e-6]], { color: GRID, width: .6 });
    for (let lon = Math.ceil(b.lon0 / step) * step; lon < b.lon1; lon += step) m.line([[b.lat0, lon], [b.lat1, lon]], { color: GRID, width: .6 });
    for (const c of coast) m.line(c, { color: COAST, width: .7, alpha: .8, latFirst: false });
  };
  m.pointer = event => {
    const b = canvas.getBoundingClientRect();
    return [(event.clientX - b.left) * m.width / b.width, (event.clientY - b.top) * m.height / b.height];
  };
  return m;
}

/* ── the coarse wind field drawn across the maps ────────────────────────────── */
let windPending;
function windField() {
  windPending ??= Promise.all([load('winds.json'), load('winds.bin')]).then(([meta, buffer]) => {
    const data = new Int8Array(buffer), { nLat, nLon, n } = meta, per = nLat * nLon * 2;
    const field = { ...meta,
      /* u,v at grid cell (i,j), linearly interpolated between the two slices around tMs */
      uv(tMs, i, j) {
        const s = clamp((tMs - meta.t0Ms) / meta.stepMs, 0, n - 1), a = Math.floor(s), b = Math.min(n - 1, a + 1), t = s - a;
        const ia = a * per + (i * nLon + j) * 2, ib = b * per + (i * nLon + j) * 2;
        return [data[ia] + (data[ib] - data[ia]) * t, data[ia + 1] + (data[ib + 1] - data[ia + 1]) * t];
      },
      /* u,v at a point, bilinear in the grid */
      at(tMs, lat, lon) {
        const fi = clamp((lat - meta.lat0) / meta.dLat, 0, nLat - 1), fj = clamp((lon - meta.lon0) / meta.dLon, 0, nLon - 1);
        const i0 = Math.floor(fi), j0 = Math.floor(fj), i1 = Math.min(nLat - 1, i0 + 1), j1 = Math.min(nLon - 1, j0 + 1), di = fi - i0, dj = fj - j0;
        const p00 = field.uv(tMs, i0, j0), p01 = field.uv(tMs, i0, j1), p10 = field.uv(tMs, i1, j0), p11 = field.uv(tMs, i1, j1);
        return [lerp(lerp(p00[0], p01[0], dj), lerp(p10[0], p11[0], dj), di), lerp(lerp(p00[1], p01[1], dj), lerp(p10[1], p11[1], dj), di)];
      },
      draw(map, tMs, options) {
        for (let i = 0; i < nLat; i++) for (let j = 0; j < nLon; j++) {
          const lat = meta.lat0 + i * meta.dLat, lon = meta.lon0 + j * meta.dLon;
          if (!map.inView(lat, lon)) continue;
          const [u, v] = field.uv(tMs, i, j); map.arrow(lat, lon, u, v, options);
        }
      },
    };
    return field;
  }).catch(error => { windPending = undefined; throw error; });
  return windPending;
}

/* ── the posterior draws (particle clouds) of every long gap ────────────────── */
let cloudPending;
function clouds() {
  cloudPending ??= Promise.all([load('posterior.json'), load('posterior.bin'), load('clouds.json'), load('clouds.bin')]).then(([p, pbuf, c, cbuf]) => {
    const pos = new Int16Array(pbuf), cpos = new Int16Array(cbuf);
    const accessor = (arr, off, steps) => (i, s) => {
      const a = Math.floor(s), b = Math.min(steps - 1, a + 1), t = s - a, ia = off + (i * steps + a) * 2, ib = off + (i * steps + b) * 2;
      return [(arr[ia] + (arr[ib] - arr[ia]) * t) / 100, (arr[ia + 1] + (arr[ib + 1] - arr[ia + 1]) * t) / 100];
    };
    const big = { tA: p.tA, tB: p.tA + p.hours * 3600000, hours: p.hours, n: p.n, steps: p.steps, at: accessor(pos, 0, p.steps) };
    const list = [big, ...c.gaps.map(g => ({ ...g, at: accessor(cpos, g.off, g.steps) }))].sort((a, b) => a.tA - b.tA);
    for (const g of list) { g.hoursPerStep = g.hours / (g.steps - 1); g.path = (i, from, to) => { const out = []; for (let s = from; s <= to; s++) out.push(g.at(i, s)); return out; }; }
    return { list, posterior: { ...p, at: big.at, path: big.path, hoursPerStep: big.hoursPerStep }, find: tMs => list.find(g => tMs >= g.tA && tMs <= g.tB) };
  }).catch(error => { cloudPending = undefined; throw error; });
  return cloudPending;
}

/* Draw a particle cloud at fractional step s: 12-hour tails and a dot per draw. */
function drawCloud(map, g, s, { color = BLUE, tail = true, alpha = 1 } = {}) {
  const back = Math.max(0, s - 12 / g.hoursPerStep);
  if (tail) for (let i = 0; i < g.n; i++) map.line([g.at(i, back), ...g.path(i, Math.ceil(back), Math.floor(s)), g.at(i, s)], { color, width: .8, alpha: .18 * alpha });
  for (let i = 0; i < g.n; i++) { const q = g.at(i, s); map.dot(q[0], q[1], 1.7, color, null, 1, .8 * alpha); }
}

/* ── shared chrome ──────────────────────────────────────────────────────────── */
const heading = (title, subtitle) => `<div class="chart-heading fleet-heading">${title}<div class="fleet-heading-controls"><span>${subtitle}</span></div></div>`;
const key = (text, color, shape = 'bar') => `<span class="chart-key"><i class="key-${shape}" style="background:${color}"></i>${text}</span>`;
const windKey = () => `<span class="chart-key"><i class="spectrum-key"></i>Wind, slow to fast</span>`;

/* The width inside a figure card's padding (narrower padding on phones, see figures.css). */
function contentWidth(host) {
  const style = getComputedStyle(host);
  return Math.floor(host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
}
/* Draw-in-and-hold animation for the figures without controls: calls frame(f) with f
 * going 0 → 1 over `duration` ms, holds f = 1 for `hold` ms, and starts again. Runs only
 * while the figure is on screen and the page visible, restarts when it scrolls back into
 * view, and shows the finished frame under prefers-reduced-motion. */
function loop(host, signal, { duration, hold }, frame) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let visible = false, elapsed = 0, prev = 0, raf = 0;
  function step(now) {
    raf = 0;
    if (!visible || document.hidden || reduced.matches) return;
    if (prev) elapsed = (elapsed + Math.min(now - prev, 100)) % (duration + hold);
    prev = now; frame(Math.min(elapsed / duration, 1));
    raf = requestAnimationFrame(step);
  }
  function update() {
    prev = 0;
    if (reduced.matches) { cancelAnimationFrame(raf); raf = 0; frame(1); return; }
    if (visible && !document.hidden && !raf) raf = requestAnimationFrame(step);
  }
  const observer = new IntersectionObserver(entries => {
    const was = visible; visible = entries[0].isIntersecting;
    if (visible && !was) elapsed = 0;
    update();
  }, { threshold: .3 });
  observer.observe(host);
  document.addEventListener('visibilitychange', update, { signal });
  reduced.addEventListener('change', update, { signal });
  signal.addEventListener('abort', () => { observer.disconnect(); cancelAnimationFrame(raf); }, { once: true });
  return reduced.matches ? 1 : 0;
}
/* Map text with a paper halo, so it stays legible over lines. */
function haloLabel(map, lat, lon, text, dx, dy, { color = INK, font = '11px Helvetica, Arial, sans-serif' } = {}) {
  const [x, y] = map.point(lat, lon), ctx = map.ctx;
  ctx.font = font; ctx.textAlign = dx < 0 ? 'right' : 'left'; ctx.lineJoin = 'round';
  ctx.strokeStyle = PAPER; ctx.lineWidth = 4; ctx.strokeText(text, x + dx, y + dy); ctx.fillStyle = color; ctx.fillText(text, x + dx, y + dy);
}
function sizeCanvas(canvas, ctx, width, height) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = width * dpr; canvas.height = height * dpr; canvas.style.width = `${width}px`; canvas.style.height = `${height}px`; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/* ── 1. the fixes, and the path between them ───────────────────────────────── */
/* The fixes are drawn from the start; the reconstructed path draws itself in through
 * them, in flight time, holds, and starts again. */
async function replay(host, signal) {
  const [flight, coast] = await Promise.all([load('flight.json'), load('coast-atlantic.json')]);
  if (signal.aborted) return;
  const fixes = flight.fixes.filter(f => f[3]), track = flight.track, end = track.at(-1)[0];
  const first = fixes[0], last = fixes.at(-1);
  host.innerHTML = `${heading('Stratolink 3', 'May 17 to 29, 2026')}
    <div class="chart-legend">${key('GPS fix', INK, 'dot')}${key('Reconstructed path', RED)}</div>
    <div class="fleet-map-stage"></div>`;
  const map = createMap(FLIGHT_VIEW, `Stratolink 3’s flight from San Francisco to Spain: the ${fixes.length} GPS fixes received, with a long stretch over the Atlantic that has none, and the path the dashboard reconstructs through them.`);
  host.querySelector('.fleet-map-stage').prepend(map.canvas);
  let minutes = 0;
  function draw() {
    if (!map.width) return;
    map.base(coast);
    const n = track.findIndex(p => p[0] > minutes), k = n < 0 ? track.length : n, pts = track.slice(0, k).map(([, lat, lon]) => [lat, lon]);
    let head;
    if (n > 0) {
      const [ta, la, oa] = track[n - 1], [tb, lb, ob] = track[n], f = (minutes - ta) / (tb - ta);
      head = [lerp(la, lb, f), lerp(oa, ob, f)]; pts.push(head);
    }
    if (pts.length > 1) map.line(pts, { color: RED, width: 2 });
    for (const [, lat, lon] of fixes) map.dot(lat, lon, 3.2, INK, CREAM, 1);
    if (head) map.dot(head[0], head[1], 4, RED, CREAM, 1.2);
    haloLabel(map, first[1], first[2], 'Launch, May 17', 9, -6);
    haloLabel(map, last[1], last[2], 'Last fix, May 29', -9, 18);
  }
  minutes = loop(host, signal, { duration: 4500, hold: 2000 }, f => { minutes = f * end; draw(); }) * end;
  observeChartSize(host, () => { map.resize(contentWidth(host)); draw(); }, signal);
}

/* ── 5. riding the tube ────────────────────────────────────────────────────── */
async function tube(host, signal) {
  const [meta, buffer, coast, flight, cloud, fmeta, fbuf, obuf] = await Promise.all([load('tube.json'), load('tube.bin'), load('coast-atlantic.json'), load('flight.json'), clouds(), load('filters.json'), load('filters.bin'), load('tube-outer.bin')]);
  if (signal.aborted) return;
  const fpos = new Int16Array(fbuf), coarse = new Int8Array(obuf);
  /* The filters' own clouds (every 3 h): the forward one from the fix before a
   * long gap, the backward one from the fix after it. The box is sized for them. */
  const filterAt = (t, dir) => { let best = null; for (const sn of fmeta.snaps) if (sn.dir === dir && Math.abs(sn.t - t) <= 1.6 * 3600000 && (!best || Math.abs(sn.t - t) < Math.abs(best.t - t))) best = sn; return best; };
  const fine = new Int8Array(buffer), track = flight.track;
  /* Ride from launch to the last fix: the slices the reconstruction actually reads
   * (the cube also holds a lead-in slice and the pre-launch days on the ground). */
  const first = meta.slices.findIndex(b => b.pos), lastIdx = meta.slices.findLastIndex(b => b.pos);
  const ride = meta.slices.slice(Math.max(0, first), lastIdx + 1), last = ride.length - 1, stepMs = ride[1].t - ride[0].t;
  /* One fixed view that holds every box on the ride: nothing zooms or pans. */
  const view = ride.reduce((v, b) => ({ lat0: Math.min(v.lat0, b.lat0 - 2), lat1: Math.max(v.lat1, b.lat0 + b.h + 2), lon0: Math.min(v.lon0, b.lon0 - 2), lon1: Math.max(v.lon1, b.lon0 + b.w + 2) }), { lat0: 90, lat1: -90, lon0: 360, lon1: -360 });
  host.innerHTML = `${heading('Riding the tube', 'one box of 0.25° winds per 3-hour slice')}
    <div class="chart-legend">${key('This slice’s box', BLUE)}${windKey()}<span class="chart-key"><i class="spectrum-key" style="opacity:.35"></i>Coarser 1.5° winds around it</span>${key('Forward balloons', BLUE, 'dot')}${key('Backward balloons', RED, 'dot')}${key('Joined paths', INK, 'dot')}${key('Flight path', RED)}</div>
    <div class="fleet-map-stage"></div>`;
  const map = createMap(view, 'The flight with the reconstruction’s wind box for each three-hour slice moving along it, the winds inside and around the box, and the simulated balloons during the gaps.');
  host.querySelector('.fleet-map-stage').prepend(map.canvas);
  let at = 0;
  /* The winds of one slice, thinned to at least 1.25° and ~8 px apart so small
   * and large boxes, and phone and desktop widths, read alike (the coarse field
   * around the box is drawn sparser and paler). */
  function sliceArrows(b) {
    const minDeg = Math.max(1.25, 8 / (map.width / (view.lon1 - view.lon0)));
    const out = [], skip = Math.max(1, Math.ceil(minDeg / b.aStep - 1e-9));
    /* Start on the global lattice of multiples of the drawn spacing, so arrows
     * stay put from frame to frame instead of shifting with each box's origin. */
    const first = (o) => ((Math.round(-o / b.aStep) % skip) + skip) % skip;
    const iS = first(b.aLat0 ?? b.lat0), jS = first(b.aLon0 ?? b.lon0);
    for (let i = iS; i < b.aLat; i += skip) for (let j = jS; j < b.aLon; j += skip) {
      const o = b.off + (i * b.aLon + j) * 2, u = fine[o], v = fine[o + 1];
      out.push({ lat: (b.aLat0 ?? b.lat0) + i * b.aStep, lon: (b.aLon0 ?? b.lon0) + j * b.aStep, u, v, speed: Math.hypot(u, v) });
    }
    return out;
  }
  /* The coarse outer field of one slice (stored thinned to ~3°). */
  function coarseArrows(b) {
    const o = b.outer, out = [];
    if (!o) return out;
    const minDeg = Math.max(3, 18 / (map.width / (view.lon1 - view.lon0))), skip = Math.max(1, Math.ceil(minDeg / o.aStep - 1e-9));
    const first = (v) => ((Math.round(-v / o.aStep) % skip) + skip) % skip;   // stay on a fixed global lattice
    for (let i = first(o.lat0); i < o.aLat; i += skip) for (let j = first(o.lon0); j < o.aLon; j += skip) {
      const k = o.off + (i * o.aLon + j) * 2, u = coarse[k], v = coarse[k + 1];
      out.push({ lat: o.lat0 + i * o.aStep, lon: o.lon0 + j * o.aStep, u, v, speed: Math.hypot(u, v) });
    }
    return out;
  }
  const inBox = (b, lat, lon) => lat >= b.lat0 && lat <= b.lat0 + b.h && lon >= b.lon0 && lon <= b.lon0 + b.w;
  function draw() {
    if (!map.width) return;
    const k = clamp(Math.floor(at), 0, last), f = k < last ? at - k : 0, a = ride[k], b = ride[Math.min(last, k + 1)];
    const t = a.t + f * stepMs, minutes = (t - flight.t0) / 60000;
    /* The box glides between slices; its winds cross-fade from one slice to the next. */
    const box = { lat0: lerp(a.lat0, b.lat0, f), lon0: lerp(a.lon0, b.lon0, f), h: lerp(a.h, b.h, f), w: lerp(a.w, b.w, f) };
    map.base(coast, 10);
    /* Around the box: the cube's coarse 1.5° winds, pale and sparse, cross-faded like the box's. */
    const fadeC = clamp((f - .7) / .3, 0, 1);
    for (const [sl, al] of [[a, 1 - fadeC], [b, fadeC]]) {
      if (al <= 0) continue;
      for (const q of coarseArrows(sl)) if (map.inView(q.lat, q.lon) && !inBox(box, q.lat, q.lon)) map.arrow(q.lat, q.lon, q.u, q.v, { alpha: .3 * al, width: .8, scale: 3.4, max: 10 });
    }
    for (let back = 4; back >= 1; back--) { const g = ride[k - back]; if (g) map.rect(g.lat0, g.lon0, g.h, g.w, { alpha: .05 * (5 - back), width: .8 }); }
    map.rect(box.lat0, box.lon0, box.h, box.w, { alpha: .9, width: 1.5, fill: .05 });
    /* Hold each slice's winds, then fade to the next over the last 30 % of the step. */
    const fade = clamp((f - .7) / .3, 0, 1);
    const arrowsA = sliceArrows(a), arrowsB = fade > 0 ? sliceArrows(b) : [];
    for (const q of arrowsA) if (inBox(box, q.lat, q.lon)) map.arrow(q.lat, q.lon, q.u, q.v, { alpha: .85 * (1 - fade), width: 1.1, scale: 3, max: 11 });
    for (const q of arrowsB) if (inBox(box, q.lat, q.lon)) map.arrow(q.lat, q.lon, q.u, q.v, { alpha: .85 * fade, width: 1.1, scale: 3, max: 11 });
    const n = track.findIndex(q => q[0] > minutes), trail = track.slice(0, n < 0 ? track.length : n).map(([, lat, lon]) => [lat, lon]);
    if (trail.length > 1) map.line(trail, { color: RED, width: 1.8, alpha: .9 });
    for (const [dir, color] of [[1, BLUE], [-1, RED]]) {
      const sn = filterAt(t, dir);
      if (sn) for (let i = 0; i < sn.n; i++) { const o = sn.off + i * 2; map.dot(fpos[o] / 100, fpos[o + 1] / 100, 2.2, color, null, 1, .6); }
    }
    const g = cloud.find(t);
    if (g) drawCloud(map, g, (t - g.tA) / (g.tB - g.tA) * (g.steps - 1), { tail: false, color: INK, alpha: .45 });
    let pos = a.pos;
    if (pos && b.pos && f > 0) pos = [lerp(a.pos[0], b.pos[0], f), lerp(a.pos[1], b.pos[1], f)];
    if (pos && !g) map.dot(pos[0], pos[1], 4.5, CREAM, INK, 1.8);
  }
  /* five slices a second, then a short hold on the last one */
  at = loop(host, signal, { duration: last * 200, hold: 1500 }, value => { at = value * last; draw(); }) * last;
  observeChartSize(host, () => { map.resize(contentWidth(host)); draw(); }, signal);
}

/* ── 5b. what the box resolves ─────────────────────────────────────────────── */
async function resolution(host, signal) {
  const [meta, pbuf] = await Promise.all([load('tube.json'), load('tube-patch.bin')]);
  if (signal.aborted) return;
  const patches = new Int8Array(pbuf), ride = meta.slices.filter(s => s.patch && s.patch.coarse && s.patch.diffOff != null), last = ride.length - 1;
  host.innerHTML = `${heading('What the box resolves', '3° around the balloon, one 3-hour slice at a time')}
    <div class="tube-inset">
      <figure><canvas data-inset="fine" role="img" aria-label="Every 0.25° wind vector the box stores in a 3° square around the balloon"></canvas><figcaption>In the box: 0.25° winds</figcaption></figure>
      <figure><canvas data-inset="coarse" role="img" aria-label="The same square read from the coarse 1.5° field"></canvas><figcaption>The same square in the coarse field: 1.5° winds</figcaption></figure>
      <figure><canvas data-inset="diff" role="img" aria-label="The difference between the box's winds and the coarse field at the same points, exaggerated ten times"></canvas><figcaption data-diff-caption>The difference, box minus coarse, arrows ×10</figcaption></figure>
    </div>`;
  const insets = [...host.querySelectorAll('[data-inset]')].map(c => ({ canvas: c, ctx: c.getContext('2d'), kind: c.dataset.inset, size: 0 }));
  /* One inset: a 3° square around the balloon at each field's REAL density — the
   * box's every 0.25° vector (13 × 13), or the coarse field's own 1.5° grid points
   * (a handful) — or their difference, with one length scale. */
  function drawInset(inset, sl) {
    const { ctx, size, kind } = inset;
    if (!size) return;
    ctx.clearRect(0, 0, size, size); ctx.fillStyle = PAPER; ctx.fillRect(0, 0, size, size);
    const pt = sl && sl.patch;
    if (!pt || (kind === 'coarse' && !pt.coarse) || (kind === 'diff' && pt.diffOff == null)) { ctx.fillStyle = '#8a8c86'; ctx.font = '12px Helvetica, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('before launch', size / 2, size / 2); return; }
    const n = pt.n, cell = size / n, span = (n - 1) * pt.step;
    const px = (lat, lon) => [((lon - pt.lon0) / span) * (size - cell) + cell / 2, size - (((lat - pt.lat0) / span) * (size - cell) + cell / 2)];
    const arrow = (lat, lon, u, v) => {
      const [x, y] = px(lat, lon), speed = Math.hypot(u, v), len = clamp(speed / 25 * cell, 2, cell * 1.15);
      ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(-v, u)); ctx.strokeStyle = kind === 'diff' ? INK : `rgb(${heatColor(speed / 65).join(',')})`; ctx.lineWidth = kind === 'coarse' ? 1.8 : 1.2;
      ctx.beginPath(); ctx.moveTo(-len / 2, 0); ctx.lineTo(len / 2, 0); ctx.lineTo(len / 2 - 2.6, -2.2); ctx.moveTo(len / 2, 0); ctx.lineTo(len / 2 - 2.6, 2.2); ctx.stroke(); ctx.restore();
      ctx.beginPath(); ctx.arc(x, y, kind === 'coarse' ? 2 : .9, 0, Math.PI * 2); ctx.fillStyle = '#8a8c86'; ctx.fill();   // the grid point
    };
    if (kind === 'fine') {
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const o = pt.off + (i * n + j) * 2; arrow(pt.lat0 + i * pt.step, pt.lon0 + j * pt.step, patches[o], patches[o + 1]); }
    } else if (kind === 'coarse') {
      for (const [lat, lon, u, v] of pt.coarse) arrow(lat, lon, u, v);
    } else {
      /* stored ×4; drawn ×10 on the same length scale as the other panels */
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const o = pt.diffOff + (i * n + j) * 2; arrow(pt.lat0 + i * pt.step, pt.lon0 + j * pt.step, patches[o] / 4 * 10, patches[o + 1] / 4 * 10); }
      const cap = inset.canvas.parentElement.querySelector('[data-diff-caption]');
      if (cap) cap.textContent = `The difference, box minus coarse, arrows ×10: typically ${fmt(pt.diffRms, 1)} m/s here`;
    }
  }
  let at = 0;
  function draw() {
    const k = clamp(Math.round(at), 0, last), sl = ride[k];
    for (const inset of insets) drawInset(inset, sl);
  }
  /* two and a half slices a second, then a short hold */
  at = loop(host, signal, { duration: last * 400, hold: 1200 }, value => { at = value * last; draw(); }) * last;
  observeChartSize(host, () => {
    const avail = contentWidth(host), perRow = avail >= 560 ? 3 : 2;
    for (const inset of insets) { const w = Math.min(260, Math.floor((avail - 16 * (perRow - 1)) / perRow)); inset.size = w; sizeCanvas(inset.canvas, inset.ctx, w, w); inset.canvas.parentElement.style.width = `${w}px`; }
    draw();
  }, signal);
}

/* ── 2. the winds alone ────────────────────────────────────────────────────── */
/* One simulated balloon riding the GFS winds from the fix before the gap, with no
 * randomness, and how far it ends from the fix after it. Loops like the flight. */
async function plain(host, signal) {
  const [cloud, fo, coast, wind] = await Promise.all([clouds(), load('forecast-only.json'), load('coast-atlantic.json'), windField()]);
  if (signal.aborted) return;
  const p = cloud.posterior, { steps, hours, hoursPerStep, tA } = p, A = p.drawn[0], B = p.drawn[steps - 1], nominal = fo.nominal, miss = fo.nominalToB;
  host.innerHTML = `${heading('Following the winds', 'New Mexico to Spain, May 19 to 28')}
    <div class="chart-legend">${key('A balloon riding the GFS winds', INK)}${key('The fixes', INK, 'dot')}${windKey()}</div>
    <div class="fleet-map-stage"></div>`;
  const map = createMap(WINDS_VIEW, `One simulated balloon carried by the GFS winds alone from the New Mexico fix: up the jet past Newfoundland, around a loop west of the Azores and toward Iberia, ending ${fmt(miss)} km from the fix in Spain.`);
  host.querySelector('.fleet-map-stage').prepend(map.canvas);
  let f = 0;
  function draw() {
    if (!map.width) return;
    const hour = f * hours, s = Math.min(hour / hoursPerStep, steps - 1), k = Math.floor(s), t = s - k;
    const n0 = nominal[k], n1 = nominal[Math.min(steps - 1, k + 1)], w = [lerp(n0[0], n1[0], t), lerp(n0[1], n1[1], t)];
    map.base(coast);
    wind.draw(map, tA + hour * 3600000, { alpha: .7, width: 1.2 });
    map.line([...nominal.slice(0, k + 1), w], { color: INK, width: 2.2 });
    map.dot(A[0], A[1], 5, CREAM, INK, 1.6); map.dot(B[0], B[1], 5, CREAM, INK, 1.6);
    haloLabel(map, A[0], A[1], 'May 19', 9, 14); haloLabel(map, B[0], B[1], 'May 28', -9, -10);
    if (f >= 1) {
      map.line([w, B], { color: RED, width: 1.6, dash: [3, 3] });
      haloLabel(map, (w[0] + B[0]) / 2, Math.min(w[1], B[1]), `${fmt(miss)} km`, -8, 4, { color: RED, font: '600 12px Helvetica, Arial, sans-serif' });
    }
    map.dot(w[0], w[1], 4.5, INK, CREAM, 1.2);
  }
  f = loop(host, signal, { duration: 4500, hold: 2500 }, value => { f = value; draw(); });
  observeChartSize(host, () => { map.resize(contentWidth(host)); draw(); }, signal);
}

/* ── 3. a little noise, a huge spread ──────────────────────────────────────── */
/* Balloons run forward from the fix before the gap with small errors of their own,
 * around the path of the winds alone; loops like the other map-only figures. */
async function spread(host, signal) {
  const [cloud, fo, fbuf, coast, wind] = await Promise.all([clouds(), load('forecast-only.json'), load('forecast-only.bin'), load('coast-atlantic.json'), windField()]);
  if (signal.aborted) return;
  const p = cloud.posterior, { steps, hours, hoursPerStep, tA } = p, fpos = new Int16Array(fbuf), A = p.drawn[0], B = p.drawn[steps - 1], nominal = fo.nominal;
  const at = (i, s) => {
    const a = Math.floor(s), b = Math.min(steps - 1, a + 1), t = s - a, ia = (i * steps + a) * 2, ib = (i * steps + b) * 2;
    return [(fpos[ia] + (fpos[ib] - fpos[ia]) * t) / 100, (fpos[ia + 1] + (fpos[ib + 1] - fpos[ia + 1]) * t) / 100];
  };
  host.innerHTML = `${heading('A little noise, a huge spread', `${fo.n} simulated balloons, May 19 to 28`)}
    <div class="chart-legend">${key('Balloons with small errors', GRAY, 'dot')}${key('The winds alone', INK)}${key('The fixes', INK, 'dot')}${windKey()}</div>
    <div class="fleet-map-stage"></div>`;
  const map = createMap(WIDE_VIEW, `${fo.n} simulated balloons run forward from the New Mexico fix for eight days with small errors in heading, speed and height, spreading across the Atlantic, Europe and North Africa around the path of the winds alone.`);
  host.querySelector('.fleet-map-stage').prepend(map.canvas);
  let f = 0;
  function draw() {
    if (!map.width) return;
    const hour = f * hours, s = Math.min(hour / hoursPerStep, steps - 1), k = Math.floor(s), t = s - k;
    const n0 = nominal[k], n1 = nominal[Math.min(steps - 1, k + 1)];
    map.base(coast);
    wind.draw(map, tA + hour * 3600000, { alpha: .5 });
    for (let i = 0; i < fo.n; i++) { const q = at(i, s); map.dot(q[0], q[1], 2.3, GRAY, null, 1, .85); }
    map.line([...nominal.slice(0, k + 1), [lerp(n0[0], n1[0], t), lerp(n0[1], n1[1], t)]], { color: INK, width: 2 });
    map.dot(A[0], A[1], 5, CREAM, INK, 1.6); map.dot(B[0], B[1], 5, CREAM, INK, 1.6);
    haloLabel(map, A[0], A[1], 'May 19', 9, 14); haloLabel(map, B[0], B[1], 'May 28', -9, -10);
  }
  f = loop(host, signal, { duration: 6000, hold: 2500 }, value => { f = value; draw(); });
  observeChartSize(host, () => { map.resize(contentWidth(host)); draw(); }, signal);
}

/* ── 3b. the few that come close ───────────────────────────────────────────── */
/* The same 500 balloons as the spread figure, with the handful that end near the fix
 * after the gap picked out along their whole route. Loops like the other map figures. */
async function arrive(host, signal) {
  const [cloud, fo, fbuf, coast, wind] = await Promise.all([clouds(), load('forecast-only.json'), load('forecast-only.bin'), load('coast-atlantic.json'), windField()]);
  if (signal.aborted) return;
  const p = cloud.posterior, { steps, hours, hoursPerStep, tA } = p, fpos = new Int16Array(fbuf), A = p.drawn[0], B = p.drawn[steps - 1], RADIUS = 500;
  const at = (i, s) => {
    const a = Math.floor(s), b = Math.min(steps - 1, a + 1), t = s - a, ia = (i * steps + a) * 2, ib = (i * steps + b) * 2;
    return [(fpos[ia] + (fpos[ib] - fpos[ia]) * t) / 100, (fpos[ia + 1] + (fpos[ib + 1] - fpos[ia + 1]) * t) / 100];
  };
  const close = [];
  for (let i = 0; i < fo.n; i++) { const e = at(i, steps - 1); if (km(e[0], e[1], B[0], B[1]) <= RADIUS) close.push(i); }
  const isClose = new Set(close);
  /* a circle of RADIUS km around the fix after the gap */
  const ring = Array.from({ length: 73 }, (_, k) => {
    const d = RADIUS / R, th = k * 5 * rad, la = B[0] * rad, lo = B[1] * rad;
    const lat = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(th));
    return [lat / rad, (lo + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(lat))) / rad];
  });
  host.innerHTML = `${heading('The few that come close', `${close.length} of ${fo.n} end within ${fmt(RADIUS)} km of Spain`)}
    <div class="chart-legend">${key(`Ends within ${fmt(RADIUS)} km of the fix`, BLUE)}${key('The other balloons', GRAY, 'dot')}${key('The fixes', INK, 'dot')}${windKey()}</div>
    <div class="fleet-map-stage"></div>`;
  const map = createMap(WIDE_VIEW, `The ${fo.n} simulated balloons from the previous figure, with the ${close.length} that end within ${fmt(RADIUS)} km of the fix in Spain drawn along their whole route.`);
  host.querySelector('.fleet-map-stage').prepend(map.canvas);
  let f = 0;
  function draw() {
    if (!map.width) return;
    const hour = f * hours, s = Math.min(hour / hoursPerStep, steps - 1), k = Math.floor(s);
    map.base(coast);
    wind.draw(map, tA + hour * 3600000, { alpha: .3 });
    for (let i = 0; i < fo.n; i++) if (!isClose.has(i)) { const q = at(i, s); map.dot(q[0], q[1], 2, GRAY, null, 1, .45); }
    map.line(ring, { color: BLUE, width: 1.2, dash: [4, 4], alpha: f >= 1 ? .9 : .35 });
    for (const i of close) {
      const route = [];
      for (let j = 0; j <= k; j++) route.push(at(i, j));
      route.push(at(i, s));
      map.line(route, { color: BLUE, width: 1.6, alpha: .85 });
      const q = route.at(-1); map.dot(q[0], q[1], 3.4, BLUE, CREAM, 1);
    }
    map.dot(A[0], A[1], 5, CREAM, INK, 1.6); map.dot(B[0], B[1], 5, CREAM, INK, 1.6);
    haloLabel(map, A[0], A[1], 'May 19', 9, 14); haloLabel(map, B[0], B[1], 'May 28', 9, -10);
  }
  f = loop(host, signal, { duration: 6000, hold: 3000 }, value => { f = value; draw(); });
  observeChartSize(host, () => { map.resize(contentWidth(host)); draw(); }, signal);
}

/* ── 4. two clouds meeting in the middle ───────────────────────────────────── */
/* Forward halves leave New Mexico while backward halves leave Spain; they meet at the
 * midpoint, then the joined paths and the drawn line take their place. Loops. */
async function meeting(host, signal) {
  const [cloud, coast, wind] = await Promise.all([clouds(), load('coast-atlantic.json'), windField()]);
  if (signal.aborted) return;
  const p = cloud.posterior, { n, steps, hours, hoursPerStep, tA } = p, mid = (steps - 1) / 2, half = hours / 2;
  host.innerHTML = `${heading('Two clouds meeting in the middle', `${n} of the ${fmt(p.nTotal)} joined paths`)}
    <div class="chart-legend">${key('Forward, from New Mexico', BLUE)}${key('Backward, from Spain', RED)}${key('Joined path', '#9a9c95')}${key('The drawn line', INK)}${windKey()}</div>
    <div class="fleet-map-stage"></div>`;
  const map = createMap(GAP_VIEW, 'Forward and backward clouds of simulated balloons crossing the Atlantic and meeting at the midpoint of the gap, then joined into whole paths with the drawn line through them.');
  host.querySelector('.fleet-map-stage').prepend(map.canvas);
  const A = p.drawn[0], B = p.drawn[steps - 1];
  let f = 0;
  function draw() {
    if (!map.width) return;
    const hour = f * hours, tMs = tA + Math.min(hour, half) * 3600000, sF = Math.min(hour / hoursPerStep, mid), sB = Math.max(steps - 1 - hour / hoursPerStep, mid);
    const reveal = clamp((hour - half) / (half * .6), 0, 1);
    map.base(coast);
    wind.draw(map, tMs, { alpha: .3 });
    if (reveal < 1) {
      for (let i = 0; i < n; i++) {
        map.line([...p.path(i, 0, Math.floor(sF)), p.at(i, sF)], { color: BLUE, width: .8, alpha: .14 * (1 - reveal) });
        map.line([p.at(i, sB), ...p.path(i, Math.ceil(sB), steps - 1)], { color: RED, width: .8, alpha: .14 * (1 - reveal) });
      }
      for (let i = 0; i < n; i++) { const fw = p.at(i, sF), bk = p.at(i, sB); map.dot(fw[0], fw[1], 1.7, BLUE, null, 1, .9 * (1 - reveal)); map.dot(bk[0], bk[1], 1.7, RED, null, 1, .9 * (1 - reveal)); }
    }
    if (reveal > 0) {
      for (let i = 0; i < n; i++) map.line(p.path(i, 0, steps - 1), { color: '#9a9c95', width: .7, alpha: .22 * reveal });
      map.line(p.drawn, { color: INK, width: 2.4, alpha: reveal });
    }
    map.dot(A[0], A[1], 5, CREAM, INK, 1.6); map.dot(B[0], B[1], 5, CREAM, INK, 1.6);
    haloLabel(map, A[0], A[1], 'May 19', 9, 14); haloLabel(map, B[0], B[1], 'May 28', -9, -10);
  }
  f = loop(host, signal, { duration: 7000, hold: 2500 }, value => { f = value; draw(); });
  observeChartSize(host, () => { map.resize(contentWidth(host)); draw(); }, signal);
}

/* ── 4b. how two halves are matched ────────────────────────────────────────── */
/* A diagram, not data: three forward/backward pairs across the overlap window, and the
 * weight each would get from how far apart its halves are across that window. */
function match(host) {
  const W = 240, H = 150, MID = 120, X0 = 72, X1 = 168, SIGMA = 9;
  const base = x => 104 - 52 * Math.sin((x - 10) / 230 * Math.PI * .85);
  const cases = [
    { title: 'Strong match', note: 'together across the whole window', red: x => base(x) + 2 },
    { title: 'Weak match', note: 'parallel, but apart', red: x => base(x) + 11 },
    { title: 'No match', note: 'meet at the midpoint, heading apart', red: x => base(MID) + .55 * (x - MID) },
  ];
  const pts = (fn, a, b) => { const out = []; for (let x = a; x <= b; x += 4) out.push(`${x.toFixed(0)},${fn(x).toFixed(1)}`); return out.join(' '); };
  const panels = cases.map(c => {
    let sum = 0, m = 0;
    for (let x = X0; x <= X1; x += 2) { sum += (c.red(x) - base(x)) ** 2; m++; }
    const weight = Math.exp(-sum / m / (SIGMA * SIGMA));
    return `<figure class="match-panel"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${c.title}: ${c.note}, weight ${weight.toFixed(2)}">
      <rect x="${X0}" y="6" width="${X1 - X0}" height="${H - 12}" rx="6" fill="${PAPER}"/>
      <line x1="${MID}" y1="6" x2="${MID}" y2="${H - 6}" stroke="${GRID}" stroke-width="1" stroke-dasharray="3 3"/>
      <polyline points="${pts(base, 10, X1 + 8)}" fill="none" stroke="${BLUE}" stroke-width="2.2" stroke-linecap="round"/>
      <polyline points="${pts(c.red, X0 - 8, 230)}" fill="none" stroke="${RED}" stroke-width="2.2" stroke-linecap="round"/>
      <circle cx="10" cy="${base(10).toFixed(1)}" r="4" fill="${CREAM}" stroke="${INK}" stroke-width="1.4"/>
      <circle cx="230" cy="${c.red(230).toFixed(1)}" r="4" fill="${CREAM}" stroke="${INK}" stroke-width="1.4"/>
    </svg><figcaption><b>${c.title}</b><span>${c.note}</span><span class="match-weight"><i style="width:${(weight * 100).toFixed(1)}%"></i></span><span>weight ${weight < .01 ? 'about 0' : weight.toFixed(2)}</span></figcaption></figure>`;
  }).join('');
  host.innerHTML = `${heading('Matching the halves', 'a sketch, not data')}
    <div class="chart-legend">${key('Forward half', BLUE)}${key('Backward half', RED)}<span class="chart-key"><i class="key-bar" style="background:${PAPER};height:9px"></i>The window either side of the midpoint</span></div>
    <div class="match-panels">${panels}</div>`;
  return Promise.resolve();
}

/* ── 6. choosing one path ──────────────────────────────────────────────────── */
/* The candidate paths as a faint bundle and the drawn line, their average position at
 * each hour, drawing in. Around its head, every path's position at that hour, shaded by
 * how far it has come compared with the rest (light behind, dark ahead): strung out
 * along a bend by their speeds, they average to a point on its inside. Loops, slowly. */
const BEHIND = [188, 217, 234], AHEAD = [13, 58, 92];
async function line(host, signal) {
  const [cloud, coast] = await Promise.all([clouds(), load('coast-atlantic.json')]);
  if (signal.aborted) return;
  const p = cloud.posterior, { n, steps, hours, hoursPerStep } = p, A = p.drawn[0], B = p.drawn[steps - 1];
  /* distance each path has traveled by every step, for ranking them at any hour */
  const traveled = Array.from({ length: n }, (_, i) => {
    const out = new Float64Array(steps);
    for (let k = 1; k < steps; k++) { const q0 = p.at(i, k - 1), q1 = p.at(i, k); out[k] = out[k - 1] + km(q0[0], q0[1], q1[0], q1[1]); }
    return out;
  });
  const shade = r => `rgb(${BEHIND.map((c, j) => Math.round(lerp(c, AHEAD[j], r))).join(',')})`;
  host.innerHTML = `${heading('Choosing one path', `${n} of the ${fmt(p.nTotal)} candidate paths`)}
    <div class="chart-legend">${key('Candidate paths', BLUE)}<span class="chart-key"><i class="progress-key"></i>Where each path is now, behind to ahead</span>${key('The drawn line, their average position', RED)}</div>
    <div class="fleet-map-stage"></div>`;
  const map = createMap(GAP_VIEW, 'The candidate paths across the eight-day gap as a faint bundle, with the drawn line, their average position at each hour. Around the line, every path’s position at that hour, shaded from behind to ahead; strung out along the arc by their speeds, they average to a point on the inside of the bend.');
  host.querySelector('.fleet-map-stage').prepend(map.canvas);
  let f = 0;
  function draw() {
    if (!map.width) return;
    const s = Math.min(f * hours / hoursPerStep, steps - 1), k = Math.floor(s), t = s - k, k1 = Math.min(steps - 1, k + 1);
    const d0 = p.drawn[k], d1 = p.drawn[k1], head = [lerp(d0[0], d1[0], t), lerp(d0[1], d1[1], t)];
    map.base(coast);
    for (let i = 0; i < n; i++) map.line(p.path(i, 0, steps - 1), { color: BLUE, width: .7, alpha: .065 });
    if (f < 1) {
      const order = traveled.map((d, i) => [lerp(d[k], d[k1], t), i]).sort((x, y) => x[0] - y[0]);
      const size = clamp(map.width / 330, 1.6, 2.6);   // smaller on a phone's smaller map
      order.forEach(([, i], r) => { const q = p.at(i, s); map.dot(q[0], q[1], size, shade(r / (n - 1)), CREAM, .5, .95); });
    }
    map.line([...p.drawn.slice(0, k + 1), head], { color: RED, width: 2.4 });
    if (f < 1) map.dot(head[0], head[1], 5, RED, CREAM, 1.6);
    map.dot(A[0], A[1], 5, CREAM, INK, 1.6); map.dot(B[0], B[1], 5, CREAM, INK, 1.6);
    haloLabel(map, A[0], A[1], 'May 19', 9, 14); haloLabel(map, B[0], B[1], 'May 28', -9, -10);
  }
  f = loop(host, signal, { duration: 14000, hold: 2500 }, value => { f = value; draw(); });
  observeChartSize(host, () => { map.resize(contentWidth(host)); draw(); }, signal);
}

/* ── 7. where it goes next ─────────────────────────────────────────────────── */
async function forecast(host, signal) {
  const [f, buffer, coast] = await Promise.all([load('forecast.json'), load('forecast.bin'), load('/assets/payload-dev-log/coastlines.json')]);
  if (signal.aborted) return;
  const pos = new Int16Array(buffer), { members, steps, hours, spreadKm, median, thresholdKm } = f,
    /* GEFS blue, AIGEFS red: the forward/backward colors of the other figures */
    colorOf = m => (f.models?.[m] === 'aigefs' ? RED : BLUE), total = hours[steps - 1], stepH = hours[1] - hours[0];
  const at = (m, s) => {
    const a = Math.floor(s), b = Math.min(steps - 1, a + 1), t = s - a, ia = (m * steps + a) * 2, ib = (m * steps + b) * 2;
    let dl = pos[ib + 1] - pos[ia + 1]; if (dl > 18000) dl -= 36000; if (dl < -18000) dl += 36000;
    return [(pos[ia] + (pos[ib] - pos[ia]) * t) / 100, (pos[ia + 1] + dl * t) / 100];
  };
  const spreadAt = s => { const a = Math.floor(s), b = Math.min(steps - 1, a + 1); return spreadKm[a] + (spreadKm[b] - spreadKm[a]) * (s - a); };
  host.innerHTML = `${heading('Where it goes next', `${members} members: ${f.gefs} GEFS, ${f.aigefs} AIGEFS`)}
    <div class="chart-legend">${key(`${f.gefs} GEFS members`, BLUE)}${key(`${f.aigefs} AIGEFS members`, RED)}${key('Median path, the drawn forecast', INK)}${key('Forecast ends', INK, 'diamond')}</div>
    <div class="fleet-map-stage"></div>
    <div class="chart-stage"><svg class="spread-chart" role="img" aria-label="Ensemble spread against forecast day, with the 2,000 km stopping threshold"></svg></div>`;
  const map = createMap(WORLD, 'Sixty-two ensemble trajectories from the last fix in Spain eastward around the world, and their spread against the 2,000 km threshold where the forecast stops.');
  host.querySelector('.fleet-map-stage').prepend(map.canvas);
  const svg = host.querySelector('.spread-chart');
  const ns = 'http://www.w3.org/2000/svg', el = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text !== undefined) e.textContent = text; return e; };
  let h = 0, width = 0;
  function drawChart(hour, spread) {
    const w = width, ht = 150, L = 52, Rm = 12, T = 14, B = 30, ymax = Math.max(2400, ...spreadKm) * 1.05;
    const sx = x => L + x / total * (w - L - Rm), sy = y => T + (1 - y / ymax) * (ht - T - B);
    svg.setAttribute('viewBox', `0 0 ${w} ${ht}`); svg.setAttribute('width', w); svg.setAttribute('height', ht); svg.replaceChildren();
    for (const v of [0, 1000, 2000]) svg.append(el('line', { x1: L, x2: w - Rm, y1: sy(v), y2: sy(v), class: 'grid-line' }), el('text', { x: L - 7, y: sy(v) + 4, 'text-anchor': 'end', class: 'tick' }, v ? `${fmt(v / 1000, 0)}k km` : '0'));
    for (let d = 0; d <= total / 24; d += 2) svg.append(el('text', { x: sx(d * 24), y: ht - 10, 'text-anchor': 'middle', class: 'tick' }, `day ${d}`));
    svg.append(el('text', { x: L, y: 10, class: 'axis-label' }, 'Spread around the median'));
    svg.append(el('line', { x1: L, x2: w - Rm, y1: sy(thresholdKm), y2: sy(thresholdKm), stroke: INK, 'stroke-dasharray': '4 4' }));
    svg.append(el('text', { x: w - Rm, y: sy(thresholdKm) - 6, 'text-anchor': 'end', class: 'tick', fill: INK }, 'forecast stops'));
    svg.append(el('path', { d: spreadKm.map((v, k) => `${k ? 'L' : 'M'}${sx(hours[k])},${sy(v)}`).join(' '), fill: 'none', stroke: GRAY, 'stroke-width': 2.2 }));
    svg.append(el('line', { x1: sx(hour), x2: sx(hour), y1: T, y2: ht - B, stroke: '#29292766', 'stroke-dasharray': '3 4' }));
    svg.append(el('circle', { cx: sx(hour), cy: sy(spread), r: 4, fill: GRAY, stroke: CREAM, 'stroke-width': 2 }));
  }
  function draw() {
    if (!map.width) return;
    const hour = Math.min(h, total), s = hour / stepH, done = hour >= total - 1e-9;
    map.base(coast, 30);
    const { ctx } = map;
    for (let m = 0; m < members; m++) {
      const pts = []; for (let k = 0; k <= Math.floor(s); k++) pts.push(at(m, k)); pts.push(at(m, s));
      map.line(pts, { color: colorOf(m), width: .9, alpha: .4 });
    }
    for (let m = 0; m < members; m++) { const q = at(m, s); map.dot(q[0], q[1], 1.8, colorOf(m), null, 1, .9); }
    const med = median.slice(0, Math.floor(s) + 1); const ms = median[Math.min(steps - 1, Math.ceil(s))], mf = median[Math.floor(s)];
    med.push([mf[0] + (ms[0] - mf[0]) * (s - Math.floor(s)), mf[1] + (ms[1] - mf[1]) * (s - Math.floor(s))]);
    map.line(med, { color: INK, width: 2 });
    map.dot(f.lastFix[0], f.lastFix[1], 5, CREAM, INK, 1.6);
    haloLabel(map, f.lastFix[0], f.lastFix[1], 'Last fix, May 29', 9, 18);
    if (done) {
      const [x, y] = map.point(f.divergence.lat, f.divergence.lon);
      ctx.fillStyle = INK; ctx.beginPath(); ctx.moveTo(x, y - 7); ctx.lineTo(x + 7, y); ctx.lineTo(x, y + 7); ctx.lineTo(x - 7, y); ctx.closePath(); ctx.fill();
      haloLabel(map, f.divergence.lat, f.divergence.lon, `forecast ends: spread ${fmt(spreadKm[steps - 1])} km`, -11, -10);
    }
    drawChart(hour, spreadAt(s));
  }
  h = loop(host, signal, { duration: 9000, hold: 3000 }, value => { h = value * total; draw(); }) * total;
  observeChartSize(host, () => { width = contentWidth(host); map.resize(width); draw(); }, signal);
}

const figures = { replay, plain, spread, arrive, meeting, match, line, tube, resolution, forecast };

export function mountFigures(root, signal) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting || signal.aborted) continue;
      observer.unobserve(entry.target);
      const host = entry.target, mount = figures[host.dataset.chart];
      if (!mount) continue;
      mount(host, signal).catch(() => { if (!signal.aborted) host.textContent = 'Figure could not load. Reload to try again.'; });
    }
  }, { rootMargin: '450px' });
  root.querySelectorAll('[data-chart]').forEach(host => observer.observe(host));
  signal.addEventListener('abort', () => observer.disconnect(), { once: true });
}
