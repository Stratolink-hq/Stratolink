// Stratolink 1 flight graphic. Draws everything over the background video from data/flight.json
// (written by export.py). Each video frame is 20 s of flight; the overlay renders frame by frame.
// ?capture=1 shows the poster alone and exposes window.renderFrame(k) for capture.py.

const W = 1080, M = 40, MAP_TOP = 152, MAP = 1000, MAP_BOTTOM = MAP_TOP + MAP;
const AXIS_Y = 1198;
const CARD_LEFT = 62, CARD_W = 310;
const OCEAN = [530, 1092];  // open sea below the projected path, clear of the card
const TZ = "America/Los_Angeles";
const params = new URLSearchParams(location.search);
const capture = params.has("capture");

// ── formatting (AP style) ────────────────────────────────────────────────────

const clockParts = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short",
});
const parts = t => Object.fromEntries(clockParts.formatToParts(new Date(t * 1000)).map(p => [p.type, p.value]));
function clock(t) {
  const p = parts(t);
  if (p.hour === "12" && p.minute === "00" && p.dayPeriod === "PM") return "noon";
  return `${p.hour}:${p.minute} ${p.dayPeriod === "AM" ? "a.m." : "p.m."}`;
}
const zone = t => parts(t).timeZoneName;
function hourLabel(t) {
  const p = parts(t);
  return p.hour === "12" && p.dayPeriod === "PM" ? "Noon" : `${p.hour} ${p.dayPeriod === "AM" ? "a.m." : "p.m."}`;
}
function apDate(t) {
  const d = new Date(t * 1000);
  const f = k => new Intl.DateTimeFormat("en-US", { timeZone: TZ, [k]: k === "month" ? "long" : "numeric" }).format(d);
  const month = f("month");
  const ap = { January: "Jan.", February: "Feb.", August: "Aug.", September: "Sept.", October: "Oct.",
               November: "Nov.", December: "Dec." }[month] || month;
  return `${ap} ${f("day")}, ${f("year")}`;
}
const minus = s => String(s).replace("-", "−");
const compass = deg => "N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW".split(" ")[Math.round((deg % 360) / 22.5) % 16];
const thousands = d3.format(",.0f");

// ── setup ────────────────────────────────────────────────────────────────────

const poster = document.querySelector(".poster");
const video = document.querySelector(".background");
const svg = d3.select(".overlay");
const card = document.querySelector(".card");
const q = sel => card.querySelector(sel);
let style = params.get("style") || "geocolor";

const SOURCES = {
  geocolor: "NOAA GOES-18 GeoColor imagery from CIRA RAMMB/SLIDER",
  map: "clouds from NOAA GOES-18 visible imagery",
};

const ext = video.canPlayType('video/webm; codecs="vp9"') ? "webm" : "mp4";

d3.json("data/flight.json").then(data => {
  const F = data.frames;
  // export.py names modes for the blog figure; this page uses the older names.
  F.mode = F.mode.map(m => ({ gps: "interp", est: "dr", silent: "lost" })[m] ?? m);
  const tAt = k => Math.min(F.t0 + k * F.step, data.events.end.t);
  const X = u => M + u * MAP, Y = v => MAP_TOP + v * MAP;
  const pxPerM = MAP / (data.map.km * 1000);
  const ev = data.events;

  // Header and footer.
  document.querySelector(".title").textContent =
    `Stratolink 1 drifted ${data.facts.km} km down the coast, then went silent`;
  document.querySelector(".dek").textContent =
    `Its flight along the California coast on ${apDate(F.t0)}, over satellite images taken every five minutes. ` +
    `As it climbed to ${Math.round(data.facts.peakKm)} km, the wind carrying it sped up from ` +
    `${data.facts.speedFrom} to ${data.facts.speedTo} meters per second.`;
  document.querySelector(".note").textContent =
    `Note: After ${clock(ev.lastFix.t)}, positions are estimated from the balloon’s last GPS speed and heading. ` +
    `Times are Pacific.`;

  // ── SVG layers ──
  const defs = svg.append("defs");
  const shadow = defs.append("filter").attr("id", "text-shadow").attr("x", "-20%").attr("y", "-40%")
    .attr("width", "140%").attr("height", "180%");
  // A tight dark edge for legibility plus a faint wide glow, rather than one blurry shadow.
  shadow.append("feDropShadow").attr("dx", 0).attr("dy", 0.6).attr("stdDeviation", 1.1)
    .attr("flood-color", "#000").attr("flood-opacity", 0.55).attr("result", "tight");
  shadow.append("feDropShadow").attr("in", "tight").attr("dx", 0).attr("dy", 0).attr("stdDeviation", 4)
    .attr("flood-color", "#000").attr("flood-opacity", 0.35);
  defs.append("clipPath").attr("id", "map-clip").append("rect")
    .attr("x", M).attr("y", MAP_TOP).attr("width", MAP).attr("height", MAP).attr("rx", 14);

  const map = svg.append("g").attr("clip-path", "url(#map-clip)");
  const layer = name => map.append("g").attr("class", name);
  const places = layer("places"), links = layer("links"), fanG = layer("fan"), tracks = layer("tracks");
  const marks = layer("marks"), notes = layer("notes");

  // Labels: stacked lines of [text, class], offset in px from a map point.
  function label(parent, x, y, lines, { dx = 14, dy = 0, anchor = "start", size = "body" } = {}) {
    const g = parent.append("g").attr("transform", `translate(${x},${y})`);
    const lh = size === "body" ? 23 : 20;
    const top = dy - (lines.length - 1) * lh / 2;
    lines.forEach(([text, cls], i) => g.append("text").attr("class", `halo ${size} ${cls || ""}`)
      .attr("x", dx).attr("y", top + i * lh).attr("dy", "0.35em").attr("text-anchor", anchor).text(text));
    return g;
  }

  for (const c of data.cities) {
    places.append("circle").attr("class", "city").attr("cx", X(c.u)).attr("cy", Y(c.v)).attr("r", 2.6);
    label(places, X(c.u), Y(c.v), [[c.name, "place"]], { dx: 7, dy: -8, size: "small" });
  }
  places.append("text").attr("class", "ocean halo").attr("x", OCEAN[0]).attr("y", OCEAN[1])
    .attr("text-anchor", "middle").text("PACIFIC OCEAN");
  const tri = (x, y) => `M${x},${y - 6}L${x + 5.5},${y + 4}L${x - 5.5},${y + 4}Z`;
  for (const [u, v] of data.gateways) places.append("path").attr("class", "gateway").attr("d", tri(X(u), Y(v)));
  if (data.gateways.length) {
    const [u, v] = data.gateways.reduce((a, b) => (b[0] > a[0] ? b : a));
    label(places, X(u), Y(v), [["Ground receivers", "place"]], { dx: 11, size: "small" });
  }
  if (data.launch) {
    marks.append("circle").attr("class", "launch").attr("cx", X(data.launch.u)).attr("cy", Y(data.launch.v)).attr("r", 6.5);
    label(notes, X(data.launch.u), Y(data.launch.v), [[`Launched from San Francisco, ${clock(data.launch.t)}`, "lead"]]);
  }

  // Moments labelled where they happened; each appears when the animation reaches it.
  const moments = [];
  // Placed under the launch label, so the two read as a sequence.
  if (ev.aboveClouds) {
    const x = X(ev.aboveClouds.u), y = Math.max(Y(ev.aboveClouds.v) + 8, data.launch ? Y(data.launch.v) + 26 : -Infinity);
    moments.push([ev.aboveClouds.t, label(notes, x, y, [[`Above the low clouds by ${clock(ev.aboveClouds.t)}`, "lead"]])]);
  }
  moments.push([ev.lastFix.t, label(notes, X(ev.lastFix.u), Y(ev.lastFix.v),
    [[`Last GPS fix, ${clock(ev.lastFix.t)}`, "lead"], [`${(ev.lastFix.alt / 1000).toFixed(1)} km up`, "muted"]],
    { dy: -6 })]);
  moments.push([ev.lastPacket.t, label(notes, X(ev.lastPacket.u), Y(ev.lastPacket.v),
    [[`Last transmission, ${clock(ev.lastPacket.t)}`, "lead red"], ["No GPS; position estimated", "muted"]],
    { dy: 6 })]);
  const projLabel = label(notes, 0, 0, [["If the wind held", "lead red"]]);
  const fanLabel = label(notes, 0, 0, [["Paths with slightly", "muted"], ["different winds", "muted"]], { dx: 10 });

  const line = d3.line().x(p => X(p.u)).y(p => Y(p.v));
  const fanPaths = fanG.selectAll("path").data(data.fan.paths).join("path");
  const casing = cls => tracks.append("path").attr("class", `track casing ${cls}`);
  const gpsCase = casing(""), estCase = casing(""), projCase = casing("proj-casing");
  const gps = tracks.append("path").attr("class", "track gps");
  const est = tracks.append("path").attr("class", "track est");
  const proj = tracks.append("path").attr("class", "track proj");
  const fixDots = marks.append("g");
  const pulse = marks.append("circle").attr("class", "ring").style("stroke", "var(--track)").attr("stroke-width", 1.5);
  const rings = d3.range(4).map(() => marks.append("circle").attr("class", "ring")
    .style("stroke", "var(--red)").attr("stroke-width", 2));
  const lastPkt = marks.append("circle").attr("r", 5.5).style("fill", "var(--halo)").style("stroke", "var(--red)")
    .attr("stroke-width", 2.3);
  const glow = marks.append("circle").attr("r", 13).attr("opacity", 0.18);
  const marker = marks.append("circle").attr("r", 6.5).attr("stroke-width", 2.6);
  const leader = map.append("line").attr("class", "leader");

  const scanLabel = svg.append("text").attr("class", "halo place").attr("x", M + 18).attr("y", MAP_BOTTOM - 18);
  const bar = svg.append("g").attr("class", "scale");
  const barPx = 50_000 * pxPerM, bx1 = M + MAP - 24, by = MAP_BOTTOM - 28;
  bar.append("line").attr("x1", bx1 - barPx).attr("x2", bx1).attr("y1", by).attr("y2", by);
  for (const x of [bx1 - barPx, bx1]) bar.append("line").attr("x1", x).attr("x2", x).attr("y1", by - 4).attr("y2", by + 4);
  bar.append("text").attr("class", "halo").attr("x", bx1 - barPx / 2).attr("y", by - 10).attr("text-anchor", "middle")
    .text("50 km");

  // ── time axis ──
  const axis = svg.append("g").attr("class", "axis");
  const tx = d3.scaleLinear().domain([F.t0, ev.end.t]).range([M, M + MAP]);
  axis.append("line").attr("class", "base").attr("x1", M).attr("x2", M + MAP).attr("y1", AXIS_Y).attr("y2", AXIS_Y);
  const firstHour = Math.ceil(F.t0 / 3600) * 3600;
  for (let h = firstHour; h <= ev.end.t; h += 3600) {
    axis.append("line").attr("class", "tick").attr("x1", tx(h)).attr("x2", tx(h)).attr("y1", AXIS_Y + 5).attr("y2", AXIS_Y + 11);
    axis.append("text").attr("class", "gray").attr("x", tx(h)).attr("y", AXIS_Y + 32).attr("text-anchor", "middle")
      .text(hourLabel(h));
  }
  const done = axis.append("line").attr("class", "done").attr("y1", AXIS_Y).attr("y2", AXIS_Y);
  const projAxis = axis.append("line").attr("class", "proj").attr("y1", AXIS_Y).attr("y2", AXIS_Y);
  const pkDots = axis.selectAll(".pk").data(data.packets).join("circle")
    .attr("class", (p, i) => `pk${i === data.packets.length - 1 ? " last" : ""}`)
    .attr("cx", p => tx(p.t)).attr("cy", AXIS_Y).attr("r", (p, i) => (i === data.packets.length - 1 ? 5 : 4.2));
  const head = axis.append("circle").attr("class", "head").attr("cy", AXIS_Y).attr("r", 6.5);
  axis.append("text").attr("class", "gray").attr("x", M).attr("y", AXIS_Y - 14)
    .text("Transmissions received");
  axis.append("text").attr("x", tx(ev.lastFix.t) + 2).attr("y", AXIS_Y - 14).attr("text-anchor", "end")
    .style("font-weight", 550).text("Last GPS fix");
  axis.append("text").attr("class", "red").attr("x", tx(ev.lastPacket.t) - 2).attr("y", AXIS_Y - 14)
    .style("font-weight", 550).text("Last transmission");
  const scrub = axis.append("rect").attr("class", "scrub").attr("x", M - 10).attr("width", MAP + 20)
    .attr("y", AXIS_Y - 30).attr("height", 70);

  // ── one frame ──
  const fixTimes = data.fixes.map(f => f.t);
  let current = 0;

  function render(k) {
    k = Math.max(0, Math.min(F.count - 1, Math.round(k)));
    current = k;
    const t = tAt(k), mode = F.mode[k], pos = { u: F.u[k], v: F.v[k] };
    const isGps = mode === "fix" || mode === "interp", lost = mode === "lost";
    const n = d3.bisectRight(fixTimes, t);
    const seen = data.fixes.slice(0, n);
    const x = X(pos.u), y = Y(pos.v);

    const gpsPts = isGps ? [...seen, pos] : seen;
    gps.attr("d", line(gpsPts)); gpsCase.attr("d", line(gpsPts));
    const estPts = isGps ? [] : [ev.lastFix, lost ? ev.lastPacket : pos];
    est.attr("d", estPts.length ? line(estPts) : null); estCase.attr("d", estPts.length ? line(estPts) : null);
    const projPts = lost ? [ev.lastPacket, pos] : [];
    proj.attr("d", projPts.length ? line(projPts) : null); projCase.attr("d", projPts.length ? line(projPts) : null);
    const fk = lost ? d3.bisectRight(data.fan.t, t) : 0;
    fanPaths.attr("d", p => (fk >= 2 ? d3.line().x(q => X(q[0])).y(q => Y(q[1]))(p.slice(0, fk)) : null));
    fixDots.selectAll("circle").data(seen).join("circle").attr("class", "fixdot").attr("r", 2.6)
      .attr("cx", f => X(f.u)).attr("cy", f => Y(f.v));

    marker.attr("cx", x).attr("cy", y)
      .style("fill", isGps ? "var(--track)" : "var(--halo)").style("stroke", isGps ? "var(--halo)" : "var(--red)");
    glow.attr("cx", x).attr("cy", y).style("fill", isGps ? "var(--track)" : "var(--red)");

    // A packet: a ring from the balloon and lines to the receivers that heard it, for 90 s.
    const packet = data.packets[F.packet[k]];
    const age = t - packet.t;
    const fade = !lost && age < 90 ? 1 - age / 90 : 0;
    pulse.attr("cx", x).attr("cy", y).attr("r", (2000 + age * 150) * pxPerM).attr("opacity", 0.7 * fade);
    links.selectAll("line").data(fade ? packet.receivers : []).join("line")
      .attr("x1", x).attr("y1", y).attr("x2", r => X(r[0])).attr("y2", r => Y(r[1])).attr("opacity", 0.7 * fade);

    // The last packet's broadcast: rings a minute apart, each fading over five.
    const since = t - ev.lastPacket.t;
    rings.forEach((ring, i) => {
      const a = since - i * 60;
      const on = a >= 0 && a < 300;
      ring.attr("cx", X(ev.lastPacket.u)).attr("cy", Y(ev.lastPacket.v))
        .attr("r", on ? (1500 + a * 120) * pxPerM : 0).attr("opacity", on ? 0.85 * (1 - a / 300) : 0);
    });
    lastPkt.attr("cx", X(ev.lastPacket.u)).attr("cy", Y(ev.lastPacket.v)).attr("opacity", since >= 0 ? 1 : 0);

    for (const [shownAt, g] of moments) g.attr("opacity", t >= shownAt ? 1 : 0);
    projLabel.attr("transform", `translate(${x},${y})`).attr("opacity", lost && since > 300 ? 1 : 0);
    if (lost && since > 900 && fk >= 2) {
      const tips = data.fan.paths.map(p => p[fk - 1]).sort((a, b) => a[0] - b[0]);
      const tip = tips[Math.floor(tips.length * 0.85)];
      fanLabel.attr("transform", `translate(${X(tip[0])},${Y(tip[1])})`).attr("opacity", 1);
    } else fanLabel.attr("opacity", 0);

    scanLabel.text(`Satellite image, ${clock(F.scan[k])}`);
    renderCard(k, t, packet, mode, y);

    done.attr("x1", tx(F.t0)).attr("x2", tx(Math.min(t, ev.lastPacket.t)));
    projAxis.attr("x1", tx(ev.lastPacket.t)).attr("x2", tx(Math.max(t, ev.lastPacket.t)));
    pkDots.classed("passed", p => p.t <= t);
    head.attr("cx", tx(t)).style("fill", t <= ev.lastPacket.t ? "var(--ink)" : "var(--red)");
  }

  function renderCard(k, t, packet, mode, by) {
    const alt = F.alt[k];
    card.dataset.mode = mode;
    q(".time").textContent = clock(t);
    q(".tz").textContent = zone(t);
    q(".status").textContent = {
      fix: "Tracked by GPS", interp: "Tracked by GPS",
      dr: `No GPS since ${clock(ev.lastFix.t)} · estimated`,
      lost: `Silent since ${clock(ev.lastPacket.t)} · projected`,
    }[mode];
    q(".alt").textContent = (alt / 1000).toFixed(1);
    q(".temp").textContent = packet.temperature == null ? "—" : minus(packet.temperature.toFixed(1));
    q(".speed").textContent = `${Math.round(F.speed[k])} m/s` + (F.heading[k] == null ? "" : ` toward ${compass(F.heading[k])}`);
    const top = F.cloudTop[k], cloudy = F.cloudy[k];
    q(".clouds").textContent = top != null
      ? (top < data.facts.lowCloudM ? "low, under 0.3 km" : `tops ${(top / 1000).toFixed(1)} km, ${top < alt ? "below" : "above"}`)
      : cloudy === true ? "cloudy" : cloudy === false ? "clear" : "—";
    q(".sun").textContent = packet.lux == null ? "—" : packet.lux >= 65535 ? "65,535+ lux (max)" : `${thousands(packet.lux)} lux`;
    q(".uv").textContent = packet.uv == null ? "—" : Math.round(packet.uv);
    q(".heard").textContent = `${packet.heardBy} receiver${packet.heardBy === 1 ? "" : "s"}`;
    q(".card-foot").textContent = packet === data.packets[data.packets.length - 1]
      ? "From the last transmission" : `From the ${clock(packet.t)} transmission`;

    // Level with the balloon, inside the map and clear of the scan label; leader to its right edge.
    const h = card.offsetHeight;
    const top_ = Math.max(MAP_TOP + 18, Math.min(by - h / 2, MAP_BOTTOM - 48 - h));
    card.style.top = `${top_}px`;
    const ly = Math.max(top_ + 24, Math.min(by, top_ + h - 24));
    leader.attr("x1", X(F.u[k])).attr("y1", by).attr("x2", CARD_LEFT + CARD_W).attr("y2", ly);
  }

  // ── playback, scrubbing, style ──
  const frameTime = k => (k + 0.5) / F.fps;  // the middle of frame k in the background video
  const seek = k => new Promise(resolve => {
    const target = frameTime(k);
    if (Math.abs(video.currentTime - target) < 1e-3 && video.readyState >= 2) return resolve();
    video.addEventListener("seeked", () => resolve(), { once: true });
    video.currentTime = target;
  });

  // Switch imagery, keeping the frame on screen.
  function setStyle(next) {
    style = next;
    poster.dataset.style = style;
    document.querySelectorAll(".segmented button").forEach(b => b.setAttribute("aria-checked", b.dataset.style === style));
    document.querySelector(".source").textContent =
      `Source: Stratolink telemetry; ${SOURCES[style]}; cloud-top heights from GOES-18.`;
    const wasPlaying = playing;
    if (playing) setPlaying(false);
    video.src = `data/background_${style}.${ext}`;
    video.addEventListener("loadedmetadata", () => {
      seek(current).then(() => wasPlaying && setPlaying(true));
    }, { once: true });
  }

  let playing = false;
  function setPlaying(on) {
    playing = on;
    document.body.classList.toggle("playing", on);
    document.querySelector(".play-label").textContent = on ? "Pause" : "Play";
    document.querySelector(".play").setAttribute("aria-label", on ? "Pause" : "Play");
    if (on) {
      if (current >= F.count - 1) { render(0); video.currentTime = frameTime(0); }
      video.play();
      tick();
    } else video.pause();
  }
  function tick() {
    if (!playing) return;
    const k = Math.floor(video.currentTime * F.fps);
    render(k);
    if (video.ended || k >= F.count - 1) { render(F.count - 1); setPlaying(false); return; }
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
  }
  video.addEventListener("ended", () => setPlaying(false));

  function scrubTo(event) {
    const [px] = d3.pointer(event, svg.node());
    const k = Math.round((tx.invert(px) - F.t0) / F.step);
    if (playing) setPlaying(false);
    render(k);
    seek(current);
  }
  scrub.call(d3.drag().on("start drag", scrubTo));
  document.querySelector(".play").addEventListener("click", () => setPlaying(!playing));
  document.querySelectorAll(".segmented button").forEach(b => b.addEventListener("click", () => {
    if (b.dataset.style !== style) setStyle(b.dataset.style);
  }));
  document.addEventListener("keydown", e => {
    if (e.target.closest && e.target.closest("button") && e.code === "Space") return;
    if (e.code === "Space") { e.preventDefault(); setPlaying(!playing); }
    if (e.code === "ArrowRight" || e.code === "ArrowLeft") {
      e.preventDefault();
      if (playing) setPlaying(false);
      render(current + (e.code === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 15 : 1));
      seek(current);
    }
  });

  // Fit the 1080-wide poster to the page.
  const stage = document.querySelector(".stage");
  new ResizeObserver(() => { poster.style.transform = `scale(${stage.clientWidth / W})`; }).observe(stage);

  // Capture: render frame k with its background, for capture.py.
  window.frameCount = F.count;
  window.renderFrame = async k => {
    await seek(k);
    render(k);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  };

  setStyle(style);
  document.body.classList.toggle("capture", capture);
  Promise.all([document.fonts.ready, new Promise(r => video.addEventListener("loadeddata", r, { once: true }))])
    .then(() => { render(capture ? 0 : F.count - 1); return seek(current); })
    .then(() => { window.ready = true; });
});
