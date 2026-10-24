/**
 * Carrying a balloon past its last GPS fix along its stored forecast.
 *
 * The forecast has two legs beyond the observed track: the predicted hindcast
 * (last fix → forecast origin, the wind-integrated drift while GPS is dark)
 * and the nominal path (origin → horizon end). The detail map and the fleet
 * map both glide the marker along them, and both decide the same way when
 * "live" means the estimated position rather than the last fix.
 */

type LonLat = [number, number];

export interface TimedPoint { lon: number; lat: number; t: number }

export interface ForecastLegs {
    /** Wind-integrated drift from the last fix to the origin. Empty unless GPS is stale. */
    predictedHindcast: LonLat[];
    /** Nominal predicted path, origin → horizon end. */
    path: LonLat[];
    /** The forecast's "now" (path[0]'s time), epoch ms. */
    originT: number | null;
    /** Horizon end (the path's last point), epoch ms. */
    endT: number | null;
    /** The stored forecast was computed with GPS already stale. */
    staleGps: boolean;
}

/** Last fix older than this = GPS dark; matches the worker's STALE_GPS_THRESHOLD_H. */
export const GPS_DARK_MS = 3_600_000;

/** Origin and horizon end from the forecast's `forecast_origin.time_utc` and `forecast_horizon_h`. */
export function forecastTimes(originUtc: unknown, horizonH: unknown): { originT: number | null; endT: number | null } {
    const originMs = typeof originUtc === 'string' ? Date.parse(originUtc) : NaN;
    const hours = typeof horizonH === 'number' || typeof horizonH === 'string' ? Number(horizonH) : NaN;
    const originT = Number.isFinite(originMs) ? originMs : null;
    return { originT, endT: originT !== null && Number.isFinite(hours) ? originT + hours * 3_600_000 : null };
}

/** The timed track extended past its last point: the predicted hindcast spread
 *  evenly from there to the origin, then the nominal path from the origin to
 *  the horizon end. So scrubbing moves the balloon along the WHOLE drawn line,
 *  with no jump at the last fix. */
export function appendForecastLegs(track: TimedPoint[], legs: Pick<ForecastLegs, 'predictedHindcast' | 'path' | 'originT' | 'endT'>): TimedPoint[] {
    const out = [...track];
    const lastT = out.length ? out[out.length - 1].t : null;
    const { predictedHindcast: ph, path: fp, originT, endT } = legs;

    /* predicted-hindcast: last fix → now (only present when GPS is stale) */
    if (ph.length >= 2 && lastT !== null && originT !== null && originT > lastT) {
        const span = originT - lastT;
        for (let i = 1; i < ph.length; i++) {
            out.push({ lon: ph[i][0], lat: ph[i][1], t: lastT + (i / (ph.length - 1)) * span });
        }
    }

    /* forecast: origin ("now") → horizon end */
    const startT = originT ?? lastT;
    if (fp.length >= 2 && startT !== null && endT !== null && endT > startT) {
        const span = endT - startT;
        for (let i = 1; i < fp.length; i++) {
            out.push({ lon: fp[i][0], lat: fp[i][1], t: startT + (i / (fp.length - 1)) * span });
        }
    }
    return out;
}

/** When GPS is dark, live shows the balloon's ESTIMATED current position, not
 *  the last fix: the real clock, carried along the forecast from its origin (the
 *  stored forecast's "now" when it was computed) and parked at its end, where the
 *  ensemble stopped agreeing. GPS counts as dark when the stored forecast says so,
 *  or once the last fix is older than the worker's own threshold (an hour), since
 *  a forecast computed while GPS was fresh doesn't know the balloon went quiet.
 *  Only a forecast that already knows the latest fix is followed; an older one
 *  would pull the marker back to a superseded estimate. Before the clock mounts it
 *  sits at the origin. Null when GPS is fresh: the last packet IS now. */
export function liveEstimateT(legs: Pick<ForecastLegs, 'originT' | 'endT' | 'staleGps'>, lastFixT: number | null, nowMs: number | null): number | null {
    const { originT, endT, staleGps } = legs;
    if (originT === null || (lastFixT !== null && originT < lastFixT)) return null;
    const gpsDark = staleGps || (nowMs !== null && lastFixT !== null && nowMs - lastFixT >= GPS_DARK_MS);
    return gpsDark ? Math.max(originT, Math.min(nowMs ?? originT, endT ?? originT)) : null;
}

/** Position [lon, lat] along a time-stamped track at time t, linearly
 *  interpolated between the bracketing points so the balloon glides. */
export function lerpAlongTrack(track: TimedPoint[], t: number): LonLat | null {
    if (track.length === 0) return null;
    if (t <= track[0].t) return [track[0].lon, track[0].lat];
    const last = track[track.length - 1];
    if (t >= last.t) return [last.lon, last.lat];
    for (let i = 1; i < track.length; i++) {
        const a = track[i - 1];
        const b = track[i];
        if (t <= b.t) {
            const f = (t - a.t) / ((b.t - a.t) || 1);
            return [a.lon + (b.lon - a.lon) * f, a.lat + (b.lat - a.lat) * f];
        }
    }
    return [last.lon, last.lat];
}

/** The forecast keeps longitudes unwrapped past ±180 (so its line stays
 *  continuous across the antimeridian); a single marker must sit in WGS84. */
export function wrapLon(lon: number): number {
    return ((lon + 180) % 360 + 360) % 360 - 180;
}

/** Where a balloon is at `time` once past its last fix: along the forecast,
 *  parked at the horizon end. Null when the forecast predates that fix (it
 *  would pull the marker back to a superseded estimate) or has no path. */
export function projectedPosition(lastFix: TimedPoint, legs: ForecastLegs, time: number): { lat: number; lon: number } | null {
    if (legs.originT === null || legs.originT < lastFix.t || legs.path.length < 2) return null;
    const pos = lerpAlongTrack(appendForecastLegs([lastFix], legs), time);
    return pos ? { lat: pos[1], lon: wrapLon(pos[0]) } : null;
}

/** Time of the latest row with a position, or null. */
export function lastFixTime(rows: ReadonlyArray<{ t: number; lat: number | null; lon: number | null }>): number | null {
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].lat != null && rows[i].lon != null) return rows[i].t;
    return null;
}

/** The stretch a balloon is estimated to have flown since its last fix, up to
 *  `untilT`: the drift to the forecast origin, then the forecast beyond it.
 *  Ends exactly where projectedPosition puts the marker. Null when there is
 *  nothing past the fix or the forecast predates it. */
export function estimatedLeg(lastFix: TimedPoint, legs: ForecastLegs, untilT: number): { drift: LonLat[]; ahead: LonLat[] } | null {
    if (untilT <= lastFix.t || legs.originT === null || legs.originT < lastFix.t || legs.path.length < 2) return null;
    const track = appendForecastLegs([lastFix], legs);
    const end = lerpAlongTrack(track, untilT)!;
    const drift: LonLat[] = [];
    const ahead: LonLat[] = [];
    for (const point of track) {
        if (point.t >= untilT) break;
        (point.t <= legs.originT ? drift : ahead).push([point.lon, point.lat]);
    }
    (untilT <= legs.originT ? drift : ahead).push(end);
    /* The two parts share the vertex where they meet. */
    if (ahead.length && drift.length) ahead.unshift(drift[drift.length - 1]);
    return { drift, ahead };
}
