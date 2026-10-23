/**
 * Keeping the detail map live between forecast runs.
 *
 * A stored forecast is rebuilt a few times a day, while a flying balloon
 * reports every ~20 minutes. Between runs the forecast's reconstructed track
 * ends at the last fix it was built from, and its projected path still starts
 * there — so, drawn as stored, the red path would freeze at that fix while
 * newer fixes pile up as unconnected dots, and the balloon marker would glide
 * along the (overtaken) projection instead of sitting on the newest fix.
 *
 * These helpers splice the fixes received since the forecast was generated into
 * the drawn track, and start the projection from the newest fix, dropping the
 * part of it the balloon has already flown past. Pure; tested.
 */

export interface TimedPoint {
    lon: number;
    lat: number;
    t: number;
}

/** A stored track followed by every fix reported after its last point. */
export function extendWithNewerFixes<T extends TimedPoint>(track: T[], fixes: T[]): T[] {
    if (!track.length) return [...fixes];
    const lastT = track[track.length - 1].t;
    const newer = fixes.filter(p => p.t > lastT);
    return newer.length ? [...track, ...newer] : track;
}

/** Time of the i-th of n evenly spaced path points spanning [originT, endT]. */
function pointTime(i: number, n: number, originT: number, endT: number): number {
    return originT + (i / (n - 1)) * (endT - originT);
}

/**
 * The forecast leg as timed points, excluding the origin point and anything at
 * or before `afterT` (the end of the observed track). Empty when the forecast
 * is malformed or lies entirely in the past.
 */
export function timedForecastLeg(
    path: Array<[number, number]>,
    originT: number | null,
    endT: number | null,
    afterT: number | null,
): TimedPoint[] {
    if (path.length < 2 || originT === null || endT === null || endT <= originT) return [];
    const out: TimedPoint[] = [];
    for (let i = 1; i < path.length; i++) {
        const t = pointTime(i, path.length, originT, endT);
        if (afterT !== null && t <= afterT) continue;
        out.push({ lon: path[i][0], lat: path[i][1], t });
    }
    return out;
}

/**
 * The projected path to draw. When the newest fix is older than the forecast
 * origin (or there is none), the stored path is drawn as is. When fixes have
 * arrived since the forecast was generated, the path starts at the newest fix
 * and keeps only the points still ahead of it in time, so the projection
 * continues from where the balloon actually is.
 */
export function liveForecastPath(
    path: Array<[number, number]>,
    originT: number | null,
    endT: number | null,
    lastFix: TimedPoint | null,
): Array<[number, number]> {
    if (lastFix === null || originT === null || endT === null || lastFix.t <= originT) return path;
    const ahead = timedForecastLeg(path, originT, endT, lastFix.t);
    if (!ahead.length) return [];
    return [[lastFix.lon, lastFix.lat], ...ahead.map((p): [number, number] => [p.lon, p.lat])];
}
