/* Flight figures for "Flights from a satellite view": a balloon's track drawn with D3 over
 * GOES-18 imagery, with a readout of its latest packet and a timeline to play or drag.
 * Each figure is a [data-chart=flight] element whose data-flight names a folder in
 * /assets/flights: flight.json and one background video per imagery style, one video frame
 * per data frame. The JSON (analysis/visualization/stratolink1_flight: export.py --public for
 * Stratolink 1, stratolink3.py for Stratolink 3, spain.py for its Spain leg) carries the track as runs of one kind
 * (gps, est, silent), the labels and when they appear, and the readout's rows.
 * Everything is drawn in screen pixels so labels stay readable at any width. A square map
 * sits beside the readout; a wide map, or one narrower than MIN_MAP, has it underneath. */
import { bisectRight, drag, format, line, pointer, range, scaleLinear, select } from 'd3';

const PANEL = 220, GAP = 20, MIN_MAP = 460, SMALL_MAP = 500;
const PACKET_S = 0.7;  // how long, in playback seconds, a packet's receiver lines stay up
const ROWS = { speed: 'Speed', clouds: 'Clouds', sun: 'Sunlight', uv: 'UV index', heard: 'Heard by' };

// ── formatting (AP style) ────────────────────────────────────────────────────

// Clock helpers in the figure's time zone (flight.json's tz, Pacific by default); zoneName, if
// given, stands in for the browser's own abbreviation, which is "GMT+2" for much of the world.
function timeFormat(timeZone = 'America/Los_Angeles', zoneName) {
  const clockParts = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' });
  const parts = t => Object.fromEntries(clockParts.formatToParts(new Date(t * 1000)).map(p => [p.type, p.value]));
  return {
    clock(t) {
      const p = parts(t);
      if (p.hour === '12' && p.minute === '00' && p.dayPeriod === 'PM') return 'noon';
      return `${p.hour}:${p.minute} ${p.dayPeriod === 'AM' ? 'a.m.' : 'p.m.'}`;
    },
    hourLabel(t) {
      const p = parts(t);
      return p.hour === '12' && p.dayPeriod === 'PM' ? 'Noon' : `${p.hour} ${p.dayPeriod === 'AM' ? 'a.m.' : 'p.m.'}`;
    },
    monthDay: t => { const p = parts(t); return `${p.month === 'May' ? 'May' : `${p.month}.`} ${p.day}`; },
    hourOf: t => { const p = parts(t); return (Number(p.hour) % 12) + (p.dayPeriod === 'PM' ? 12 : 0); },
    zone: t => zoneName || parts(t).timeZoneName,
  };
}
const minus = s => String(s).replace('-', '−');
const compass = deg => 'N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW'.split(' ')[Math.round((deg % 360) / 22.5) % 16];
const thousands = format(',.0f');

const TEMPLATE = `
<div class="chart-heading"><div class="flight-title"></div>
  <div class="flight-imagery" role="radiogroup" aria-label="Imagery">
    <button type="button" role="radio" data-style="geocolor">Satellite</button><button type="button" role="radio" data-style="map">Map</button>
  </div>
</div>
<div class="flight-body">
  <div class="flight-map"><video muted playsinline preload="auto" aria-hidden="true"></video><svg class="flight-overlay" role="img"></svg></div>
  <section class="flight-panel" aria-label="Latest packet">
    <div class="flight-now">
      <div class="flight-time"><span class="time"></span><span class="tz"></span></div>
      <div class="flight-status"><span class="dot"></span><span class="status"></span></div>
    </div>
    <div class="flight-heroes">
      <div><div class="cap">Altitude</div><div class="num"><span class="alt"></span><span class="unit">km</span></div></div>
      <div><div class="cap">Temperature</div><div class="num"><span class="temp"></span><span class="unit">°C</span></div></div>
    </div>
    <dl class="flight-rows"></dl>
    <p class="flight-foot"></p>
  </section>
</div>
<div class="flight-scrubber">
  <button type="button" class="flight-play" aria-label="Play">
    <svg viewBox="0 0 16 16" aria-hidden="true"><path class="icon-play" d="M4.5 2.5v11l9-5.5z"/><path class="icon-pause" d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/></svg>
  </button>
  <svg class="flight-axis" aria-label="Timeline: drag to move through the flight"></svg>
</div>`;

export function mountFlights(root, signal) {
  root.querySelectorAll('[data-chart=flight]').forEach(host => mountFlight(host, signal));
}

function mountFlight(host, signal) {
  const assets = `/assets/flights/${host.dataset.flight}`;
  host.innerHTML = TEMPLATE;
  host.tabIndex = 0;
  const $ = sel => host.querySelector(sel);
  const video = $('video'), panel = $('.flight-panel'), playButton = $('.flight-play'), mapBox = $('.flight-map');
  const svg = select($('.flight-overlay')), axisSvg = select($('.flight-axis'));
  const source = host.closest('figure')?.querySelector('[data-flight-source]');
  let style = 'geocolor', playing = false, current = 0, data, render = () => {}, renderAxis = () => {};
  let clock, hourLabel, monthDay, hourOf, zone;

  fetch(`${assets}/flight.json`, { signal }).then(r => {
    if (!r.ok) throw new Error('Figure data unavailable');
    return r.json();
  }).then(json => {
    data = json;
    ({ clock, hourLabel, monthDay, hourOf, zone } = timeFormat(data.tz, data.zoneName));
    current = data.frames.count - 1;
    $('.flight-title').textContent = data.title;
    $('.flight-rows').innerHTML = data.panel.map(key => `<div><dt>${ROWS[key]}</dt><dd data-row="${key}"></dd></div>`).join('');
    const observer = new ResizeObserver(layout);
    observer.observe(host);
    signal.addEventListener('abort', () => { observer.disconnect(); video.pause(); video.removeAttribute('src'); });
    setStyle(style);
  }).catch(error => {
    if (error.name !== 'AbortError') host.textContent = 'The flight figure could not be loaded.';
  });

  // ── layout ──
  let width = 0;
  function layout() {
    const cs = getComputedStyle(host);
    const w = host.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    if (!w || w === width) return;
    width = w;
    const aspect = data.map.aspect;
    const beside = aspect > 0.85 && w - PANEL - GAP >= MIN_MAP;
    host.classList.toggle('stacked', !beside);
    host.classList.toggle('strip', !beside && w >= 600);
    const Sw = Math.floor(beside ? w - PANEL - GAP : w), Sh = Math.round(Sw * aspect);
    host.classList.toggle('small-map', Sw < SMALL_MAP);
    mapBox.style.width = `${Sw}px`;
    mapBox.style.height = `${Sh}px`;
    drawMap(Sw, Sh);
    const scrubber = $('.flight-scrubber'), ss = getComputedStyle(scrubber);
    drawAxis(scrubber.clientWidth - parseFloat(ss.paddingLeft) - parseFloat(ss.paddingRight) - playButton.offsetWidth - 12, w < 600);
    fixWidths();
    render(current);
  }

  // ── the map overlay ──
  function drawMap(Sw, Sh) {
    const F = data.frames, ev = data.events || {};
    const X = u => u * Sw, Y = v => v * Sh;
    const pxPerM = Sw / (data.map.km * 1000);
    const small = Sw < SMALL_MAP;
    svg.selectAll('*').remove();
    svg.attr('width', Sw).attr('height', Sh).attr('viewBox', `0 0 ${Sw} ${Sh}`).attr('aria-label', `Map of ${data.title.split(',')[0]}’s track`);

    const defs = svg.append('defs');
    const shadowId = `flight-shadow-${host.dataset.flight}`;
    const shadow = defs.append('filter').attr('id', shadowId).attr('x', '-20%').attr('y', '-40%').attr('width', '140%').attr('height', '180%');
    shadow.append('feDropShadow').attr('dx', 0).attr('dy', 0.6).attr('stdDeviation', 1).attr('flood-color', '#000').attr('flood-opacity', 0.6).attr('result', 'tight');
    shadow.append('feDropShadow').attr('in', 'tight').attr('dx', 0).attr('dy', 0).attr('stdDeviation', 3.5).attr('flood-color', '#000').attr('flood-opacity', 0.35);
    svg.style('--text-shadow', `url(#${shadowId})`);

    const layer = name => svg.append('g').attr('class', name);
    const places = layer('places'), links = layer('links'), fanG = layer('fan'), tracks = layer('tracks');
    const marks = layer('marks'), notes = layer('notes');

    // Stacked lines of [text, class] beside a map point, on the side asked for if it fits, else the
    // other side, else pulled back inside the right edge.
    function label(parent, x, y, lines, { dx = 11, dy = 0, size = 'lead', side = 'right' } = {}) {
      const g = parent.append('g').attr('transform', `translate(${x},${y})`);
      const lh = size === 'lead' ? 16 : 14;
      const top = dy - (lines.length - 1) * lh / 2;
      const nodes = lines.map(([t, cls], i) => g.append('text').attr('class', `halo ${size} ${cls || ''}`)
        .attr('x', dx).attr('y', top + i * lh).attr('dy', '0.35em').text(t));
      const wide = Math.max(...nodes.map(n => n.node().getComputedTextLength()));
      const fitsRight = x + dx + wide <= Sw - 6, fitsLeft = x - dx - wide >= 6;
      if (side === 'left' ? fitsLeft : !fitsRight && fitsLeft) nodes.forEach(n => n.attr('x', -dx).attr('text-anchor', 'end'));
      else if (!fitsRight) nodes.forEach(n => n.attr('x', Sw - 6 - wide - x));
      return g;
    }

    for (const c of data.cities) places.append('circle').attr('class', 'city').attr('cx', X(c.u)).attr('cy', Y(c.v)).attr('r', 2.2);
    const tri = (x, y) => `M${x},${y - 5}L${x + 4.5},${y + 3.5}L${x - 4.5},${y + 3.5}Z`;
    for (const [u, v] of data.gateways) places.append('path').attr('class', 'gateway').attr('d', tri(X(u), Y(v)));

    // Labelled moments, each shown once the animation reaches it.
    const moments = [], placed = [];
    for (const l of data.labels) {
      let y = Y(l.v);
      if (l.under != null) y = Math.max(y + 6, placed[l.under] + 18);
      placed.push(y + (l.dy || 0));
      if (l.marker) marks.append('circle').attr('class', l.marker).attr('cx', X(l.u)).attr('cy', Y(l.v)).attr('r', 5.5);
      const g = label(notes, X(l.u), y, small && l.short ? l.short : l.lines, { dy: l.dy || 0, side: l.side });
      moments.push([l.t, g]);
    }
    const projLabel = data.fan ? label(notes, X(ev.end.u), Y(ev.end.v), [['If the wind held', 'lead']]) : null;
    const fanLabel = notes.append('g');

    // Place names give way to the labelled moments and to each other; the receivers label goes on
    // the easternmost receiver that has room for it.
    const box = g => g.node().getBoundingClientRect();
    const hits = (a, b, pad = 3) => a.left < b.right + pad && b.left < a.right + pad && a.top < b.bottom + pad && b.top < a.bottom + pad;
    const taken = notes.selectAll(':scope > g').nodes().map(n => n.getBoundingClientRect()).filter(r => r.width);
    const place = (draw) => {
      const g = draw();
      if (!g) return false;
      if (taken.some(r => hits(r, box(g)))) { g.remove(); return false; }
      taken.push(box(g));
      return true;
    };
    [...data.gateways].sort((a, b) => b[0] - a[0])
      .some(([u, v]) => place(() => label(places, X(u), Y(v), [['Ground receivers', 'place']], { dx: 9, size: 'small' })));
    for (const c of data.cities) place(() => label(places, X(c.u), Y(c.v), [[c.name, 'place']], { dx: 6, dy: -7, size: 'small' }));
    data.map.ocean.some(([u, v]) => place(() => {
      const t = places.append('text').attr('class', 'ocean halo').attr('y', Y(v)).text('PACIFIC OCEAN');
      const len = t.node().getComputedTextLength(), x0 = Math.max(8, Math.min(X(u) - len / 2, Sw - len - 8));
      // Off the track too, which the label would otherwise cross on small maps.
      const y0 = Y(v) - 12, onTrack = data.segments.some(s => s.pts.some(p => X(p[1]) > x0 - 4 && X(p[1]) < x0 + len + 4 && Y(p[2]) > y0 && Y(p[2]) < Y(v) + 6));
      if (onTrack) { t.remove(); return null; }
      return t.attr('x', x0);
    }));

    const path = line().x(p => X(p[1])).y(p => Y(p[2]));
    const fanPath = line().x(p => X(p[0])).y(p => Y(p[1]));
    const fanPaths = data.fan ? fanG.selectAll('path').data(data.fan.paths).join('path') : null;
    const runs = data.segments.map(s => ({
      ...s, start: s.pts[0][0], end: s.pts[s.pts.length - 1][0],
      casing: tracks.append('path').attr('class', `track casing ${s.kind}`),
      line: tracks.append('path').attr('class', `track ${s.kind}`),
    }));
    const fixDots = marks.append('g');
    const pulse = marks.append('circle').attr('class', 'ring pulse');
    const rings = ev.lastPacket ? range(4).map(() => marks.append('circle').attr('class', 'ring broadcast')) : [];
    const lastPkt = ev.lastPacket ? marks.append('circle').attr('class', 'last-packet').attr('r', 4.5) : null;
    const glow = marks.append('circle').attr('class', 'glow').attr('r', 11);
    const marker = marks.append('circle').attr('class', 'marker').attr('r', 5.5);

    const scanLabel = svg.append('text').attr('class', 'halo small place').attr('x', 12).attr('y', Sh - 13);
    const km = [50, 100, 200, 250, 500].find(k => k * 1000 * pxPerM >= Sw * 0.09) ?? 500;
    const bar = svg.append('g').attr('class', 'scale');
    const barPx = km * 1000 * pxPerM, bx1 = Sw - 14, by = Sh - 16;
    bar.append('line').attr('x1', bx1 - barPx).attr('x2', bx1).attr('y1', by).attr('y2', by);
    for (const x of [bx1 - barPx, bx1]) bar.append('line').attr('x1', x).attr('x2', x).attr('y1', by - 3).attr('y2', by + 3);
    bar.append('text').attr('class', 'halo small').attr('x', bx1 - barPx / 2).attr('y', by - 8).attr('text-anchor', 'middle').text(`${km} km`);

    const fixTimes = data.fixes.map(f => f.t);

    render = k => {
      k = Math.max(0, Math.min(F.count - 1, Math.round(k)));
      current = k;
      const t = frameT(k), mode = F.mode[k];
      const pos = [t, F.u[k], F.v[k]], x = X(pos[1]), y = Y(pos[2]);

      for (const r of runs) {
        const pts = t < r.start ? [] : t >= r.end ? r.pts : [...r.pts.filter(p => p[0] <= t), pos];
        const d = pts.length > 1 ? path(pts) : null;
        r.line.attr('d', d); r.casing.attr('d', d);
      }
      fixDots.selectAll('circle').data(data.fixes.slice(0, bisectRight(fixTimes, t))).join('circle')
        .attr('class', 'fixdot').attr('r', 2.2).attr('cx', f => X(f.u)).attr('cy', f => Y(f.v));
      marker.attr('cx', x).attr('cy', y).classed('lost', mode !== 'gps');
      glow.attr('cx', x).attr('cy', y);

      // A packet: a ring from the balloon and lines to the receivers that heard it, held for
      // PACKET_S of playback (however much flight time that is), fading over the second half.
      const packet = framePacket(k);
      const age = packet ? (t - packet.t) / (F.step * F.fps * PACKET_S) : Infinity;
      const fade = mode !== 'silent' && age < 1 ? Math.min(1, 2 * (1 - age)) : 0;
      pulse.attr('cx', x).attr('cy', y).attr('r', 7 + 20 * Math.min(age, 1)).attr('opacity', 0.8 * (1 - Math.min(age, 1)) * (fade > 0));
      links.selectAll('line').data(fade ? packet.receivers : []).join('line')
        .attr('x1', x).attr('y1', y).attr('x2', r => X(r[0])).attr('y2', r => Y(r[1])).attr('opacity', 0.9 * fade);

      // The last packet's broadcast: rings a minute apart, each fading over five.
      if (ev.lastPacket) {
        const since = t - ev.lastPacket.t;
        rings.forEach((ring, i) => {
          const a = since - i * 60, on = a >= 0 && a < 300;
          ring.attr('cx', X(ev.lastPacket.u)).attr('cy', Y(ev.lastPacket.v))
            .attr('r', on ? (1500 + a * 120) * pxPerM : 0).attr('opacity', on ? 0.85 * (1 - a / 300) : 0);
        });
        lastPkt.attr('cx', X(ev.lastPacket.u)).attr('cy', Y(ev.lastPacket.v)).attr('opacity', since >= 0 ? 1 : 0);
      }

      for (const [shownAt, g] of moments) g.attr('opacity', t >= shownAt ? 1 : 0);
      if (data.fan) {
        const since = t - ev.lastPacket.t, fk = mode === 'silent' ? bisectRight(data.fan.t, t) : 0;
        fanPaths.attr('d', p => (fk >= 2 ? fanPath(p.slice(0, fk)) : null));
        projLabel.attr('transform', `translate(${x},${y})`).attr('opacity', mode === 'silent' && since > 300 ? 1 : 0);
        fanLabel.selectAll('*').remove();
        if (mode === 'silent' && since > 900 && fk >= 2) {
          // Beside the fan's eastern edge, or its western one, over open sea, on small maps.
          const tips = data.fan.paths.map(p => p[fk - 1]).sort((a, b) => a[0] - b[0]);
          const tip = tips[Math.floor(tips.length * (small ? 0.1 : 0.85))];
          label(fanLabel, X(tip[0]), Y(tip[1]), [['Paths with slightly', 'muted'], ['different winds', 'muted']],
            { dx: 8, dy: small ? -22 : 0, size: 'small', side: small ? 'left' : 'right' });
        }
      }

      const scanAt = data.multiDay ? `${monthDay(F.scan[k])}, ${clock(F.scan[k])}` : clock(F.scan[k]);
      scanLabel.text(`${style === 'geocolor' ? 'Satellite image' : 'Clouds'}, ${scanAt}`);
      renderPanel(k, t, packet, mode);
      renderAxis(t);
    };
  }

  // The readout's text for frame k, shared by drawing it and by sizing its boxes.
  function readout(k, t, packet) {
    const F = data.frames, alt = F.alt[k];
    const text = {
      time: clock(t), alt: (alt / 1000).toFixed(1),
      temp: packet?.temperature == null ? '—' : minus(packet.temperature.toFixed(1)),
    };
    for (const key of data.panel) {
      let v = '—';
      if (key === 'speed') v = `${Math.round(F.speed[k])} m/s` + (F.heading[k] == null ? '' : ` toward ${compass(F.heading[k])}`);
      if (key === 'clouds') {
        const top = F.cloudTop[k], cloudy = F.cloudy[k];
        v = top != null
          ? (top < data.facts.lowCloudM ? 'low, under 0.3 km' : `tops ${(top / 1000).toFixed(1)} km, ${top < alt ? 'below' : 'above'}`)
          : cloudy === true ? 'cloudy' : cloudy === false ? 'clear' : '—';
      }
      if (key === 'sun' && packet?.lux != null) v = packet.lux >= 65535 ? '65,535+ lux (max)' : `${thousands(packet.lux)} lux`;
      if (key === 'uv' && packet?.uv != null) v = String(Math.round(packet.uv));
      if (key === 'heard' && packet) v = `${packet.heardBy} receiver${packet.heardBy === 1 ? '' : 's'}`;
      text[key] = v;
    }
    return text;
  }
  const frameT = k => Math.min(data.frames.t0 + k * data.frames.step, data.events?.end?.t ?? Infinity);
  const framePacket = k => (data.frames.packet[k] >= 0 ? data.packets[data.frames.packet[k]] : null);

  // Each changing value sits in a box as wide as its widest value over the flight, numbers set
  // to the right, so digits and the units after them stay put as the values change. Rows only
  // need it in the strip, where they sit side by side; beside the map they are right-aligned.
  function fixWidths() {
    const all = range(data.frames.count).map(k => readout(k, frameT(k), framePacket(k)));
    const ctx = document.createElement('canvas').getContext('2d');
    const boxes = { time: panel.querySelector('.time'), alt: panel.querySelector('.alt'), temp: panel.querySelector('.temp') };
    for (const key of data.panel) boxes[key] = panel.querySelector(`[data-row=${key}]`);
    for (const [key, el] of Object.entries(boxes)) {
      el.style.minWidth = '';
      if (!['time', 'alt', 'temp'].includes(key) && !host.classList.contains('strip')) continue;
      const cs = getComputedStyle(el);
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;  // cs.font is empty with tabular figures set
      ctx.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
      const widest = Math.max(...[...new Set(all.map(v => v[key]))].map(text => ctx.measureText(text).width));
      el.style.minWidth = `${Math.ceil(widest) + 2}px`;
    }
  }

  function renderPanel(k, t, packet, mode) {
    const F = data.frames, q = sel => panel.querySelector(sel);
    const text = readout(k, t, packet);
    panel.dataset.mode = mode;
    q('.time').textContent = text.time;
    q('.tz').textContent = data.multiDay ? `${zone(t)} · ${monthDay(t)}` : zone(t);
    q('.status').textContent = data.statuses[F.status[k]];
    q('.alt').textContent = text.alt;
    q('.temp').textContent = text.temp;
    for (const key of data.panel) panel.querySelector(`[data-row=${key}]`).textContent = text[key];
    const when = !packet ? '' : data.multiDay && monthDay(packet.t) !== monthDay(t) ? `${clock(packet.t)}, ${monthDay(packet.t)},` : clock(packet.t);
    q('.flight-foot').textContent = !packet ? 'No packets yet'
      : packet === data.packets[data.packets.length - 1] ? 'From the last transmission' : `From the ${when} transmission`;
  }

  // ── the timeline ──
  function drawAxis(A, narrow) {
    const F = data.frames;
    const t1 = F.t0 + (F.count - 1) * F.step;
    const AY = 26, pad = 7, H = 58;
    axisSvg.selectAll('*').remove();
    axisSvg.attr('width', A).attr('height', H).attr('viewBox', `0 0 ${A} ${H}`);
    const tx = scaleLinear().domain([F.t0, t1]).range([pad, A - pad]);

    // Night at the balloon, as bands behind the line.
    if (F.night) {
      let start = null;
      F.night.forEach((n, k) => {
        if (n && start == null) start = k;
        if ((!n || k === F.count - 1) && start != null) {
          axisSvg.append('rect').attr('class', 'night').attr('x', tx(F.t0 + start * F.step)).attr('y', AY - 9)
            .attr('width', tx(F.t0 + k * F.step) - tx(F.t0 + start * F.step)).attr('height', 18);
          start = null;
        }
      });
    }
    axisSvg.append('line').attr('class', 'base').attr('x1', pad).attr('x2', A - pad).attr('y1', AY).attr('y2', AY);
    const long = t1 - F.t0 > 12 * 3600;
    for (let h = Math.ceil(F.t0 / 3600) * 3600; h <= t1; h += 3600) {
      const hr = hourOf(h);
      if (long && hr % 6) continue;
      const text = !long ? hourLabel(h) : hr === 0 ? monthDay(h) : hr === 12 && !narrow ? 'Noon' : '';
      axisSvg.append('line').attr('class', 'tick').attr('x1', tx(h)).attr('x2', tx(h)).attr('y1', AY + 5).attr('y2', AY + (text ? 10 : 8));
      if (text) axisSvg.append('text').attr('class', `hour${long && hr === 0 ? ' day' : ''}`).attr('x', tx(h)).attr('y', AY + 25).attr('text-anchor', 'middle').text(text);
    }
    const done = axisSvg.append('line').attr('class', 'done').attr('y1', AY).attr('y2', AY);
    const lastT = data.packets[data.packets.length - 1].t;
    const after = axisSvg.append('line').attr('class', 'proj').attr('y1', AY).attr('y2', AY);
    const many = data.packets.length > 40;
    const pks = axisSvg.selectAll('.pk').data(data.packets).join(many ? 'line' : 'circle')
      .attr('class', (p, i) => `pk${many ? ' tickmark' : ''}${i === data.packets.length - 1 ? ' last' : ''}`);
    if (many) pks.attr('x1', p => tx(p.t)).attr('x2', p => tx(p.t)).attr('y1', AY - 5).attr('y2', AY + 5);
    else pks.attr('cx', p => tx(p.t)).attr('cy', AY).attr('r', (p, i) => (i === data.packets.length - 1 ? 4.5 : 3.6));
    const head = axisSvg.append('circle').attr('class', 'head').attr('cy', AY).attr('r', 5.5);
    const received = axisSvg.append('text').attr('class', 'muted').attr('x', pad).attr('y', AY - 14).text('Transmissions received');
    for (const n of data.axisNotes || []) {
      const note = axisSvg.append('text').attr('class', n.cls).attr('x', tx(n.t) + (n.dx || 0)).attr('y', AY - 14)
        .attr('text-anchor', n.anchor).text(narrow && n.short ? n.short : n.text);
      // The notes matter more than the axis title when there is no room for both.
      const a = note.node().getBBox(), r = received.node()?.getBBox();
      if (r && a.x < r.x + r.width + 8) received.remove();
    }
    axisSvg.append('rect').attr('class', 'scrub').attr('width', A).attr('height', H)
      .call(drag().on('start drag', event => {
        const [px] = pointer(event, axisSvg.node());
        if (playing) setPlaying(false);
        render((tx.invert(px) - F.t0) / F.step);
        seek(current);
      }));
    renderAxis = t => {
      done.attr('x1', tx(F.t0)).attr('x2', tx(Math.min(t, lastT)));
      after.attr('x1', tx(lastT)).attr('x2', tx(Math.max(t, lastT)));
      pks.classed('passed', p => p.t <= t);
      head.attr('cx', tx(t)).classed('lost', t > lastT);
    };
  }

  // ── playback and imagery ──
  const frameTime = k => (k + 0.5) / data.frames.fps;  // the middle of frame k in the background
  const seek = k => new Promise(resolve => {
    const target = frameTime(k);
    if (Math.abs(video.currentTime - target) < 1e-3 && video.readyState >= 2) return resolve();
    video.addEventListener('seeked', () => resolve(), { once: true });
    video.currentTime = target;
  });

  function setStyle(next) {
    style = next;
    host.dataset.style = style;
    host.querySelectorAll('.flight-imagery button').forEach(b => b.setAttribute('aria-checked', b.dataset.style === style));
    if (source) source.textContent = `Source: Stratolink telemetry; ${data.sources[style]}.`;
    const wasPlaying = playing;
    if (playing) setPlaying(false);
    video.src = `${assets}/background-${style}.mp4`;
    // WebKit on iOS (Safari, and Chrome there too) stops after the metadata and never finishes the
    // seek, leaving the map blank, unless the load is asked for outright.
    video.load();
    video.addEventListener('loadedmetadata', () => { render(current); seek(current).then(() => wasPlaying && setPlaying(true)); }, { once: true });
  }

  function setPlaying(on) {
    playing = on;
    host.classList.toggle('playing', on);
    playButton.setAttribute('aria-label', on ? 'Pause' : 'Play');
    if (on) {
      if (current >= data.frames.count - 1) { render(0); video.currentTime = frameTime(0); }
      video.play();
      tick();
    } else video.pause();
  }
  function tick() {
    if (!playing || signal.aborted) return;
    const k = Math.floor(video.currentTime * data.frames.fps);
    render(k);
    if (video.ended || k >= data.frames.count - 1) { render(data.frames.count - 1); setPlaying(false); return; }
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
  }

  video.addEventListener('ended', () => setPlaying(false), { signal });
  playButton.addEventListener('click', () => data && setPlaying(!playing), { signal });
  host.querySelectorAll('.flight-imagery button').forEach(b => b.addEventListener('click', () => {
    if (data && b.dataset.style !== style) setStyle(b.dataset.style);
  }, { signal }));
  host.addEventListener('keydown', e => {
    if (!data) return;
    if (e.code === 'Space' && !e.target.closest('button')) { e.preventDefault(); setPlaying(!playing); }
    if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
      e.preventDefault();
      if (playing) setPlaying(false);
      render(current + (e.code === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 15 : 1));
      seek(current);
    }
  }, { signal });
}
