/** Interpolate only within the modeled horizon, then hold its endpoint. */
export function projectedPosition(forecast, time) {
  const path = forecast?.nominal_path;
  const start = Date.parse(forecast?.forecast_origin?.time_utc ?? '');
  const hours = Number(forecast?.forecast_horizon_h);
  if (!Array.isArray(path) || !path.length || !Number.isFinite(start) || !Number.isFinite(time) || time < start || !Number.isFinite(hours) || hours < 0) return null;
  if (path.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite) || Math.abs(p[1]) > 90)) return null;
  const step = hours > 0 ? Math.min(1, (time - start) / (hours * 3600000)) * (path.length - 1) : path.length - 1;
  const i = Math.floor(step), a = path[i], b = path[Math.min(i + 1, path.length - 1)];
  const fraction = step - i;
  const delta = ((b[0] - a[0] + 540) % 360 + 360) % 360 - 180;
  const lon = ((a[0] + delta * fraction + 180) % 360 + 360) % 360 - 180;
  return { lon, lat: a[1] + (b[1] - a[1]) * fraction, t: Math.min(time, start + hours * 3600000) };
}
