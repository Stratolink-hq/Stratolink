type V2FlightPoint = { lon: number; lat: number; t: number; alt?: number | null; alt_m?: number };

const EPS = 0.0008;
const FREEZE_MIN_MS = 18 * 60_000;

export type TrackSegments = {
    observed: V2FlightPoint[];
    freezeDrift: Array<[number, number]>;
    resumed: V2FlightPoint[];
};

/** Split track into observed, implied GPS-freeze drift, and post-resume segments when detectable. */
export function splitTrackSegments(track: V2FlightPoint[]): TrackSegments {
    if (track.length < 3) {
        return { observed: track, freezeDrift: [], resumed: [] };
    }

    let freezeStart = -1;
    let freezeEnd = -1;

    for (let i = 1; i < track.length; i++) {
        const prev = track[i - 1];
        const cur = track[i];
        const same =
            Math.abs(cur.lat - prev.lat) < EPS &&
            Math.abs(cur.lon - prev.lon) < EPS &&
            new Date(cur.t).getTime() - new Date(prev.t).getTime() >= FREEZE_MIN_MS;

        if (same && freezeStart < 0) freezeStart = i - 1;
        if (freezeStart >= 0 && !same) {
            freezeEnd = i - 1;
            break;
        }
    }

    if (freezeStart < 0 || freezeEnd < 0 || freezeEnd <= freezeStart) {
        return { observed: track, freezeDrift: [], resumed: [] };
    }

    const observed = track.slice(0, freezeStart + 1);
    const resumedPts = track.slice(freezeEnd);
    const a = observed[observed.length - 1];
    const b = resumedPts[0];
    const freezeDrift: Array<[number, number]> =
        a && b ? [[a.lon, a.lat], [b.lon, b.lat]] : [];

    return { observed, freezeDrift, resumed: resumedPts };
}

/** Drop frozen-GPS re-sends: a fix at exactly the same lat/lon as the previous
 *  kept fix. stratolink-3's receiver repeats its last position for hours while
 *  the balloon drifts on (82 repeats over Spain on 2026-05-28), and treating
 *  those as fixes pins the reconstruction to the stale spot, then jumps it to
 *  the next real fix in one short straight hop. Keeping only the first packet
 *  of each run turns the freeze into a single gap the wind smoother bridges,
 *  and makes the last fix the last *real* one (so stale-GPS dead-reckoning
 *  starts from it). Exact equality: a live receiver jitters, so only a re-send
 *  repeats bit for bit. Mirrors `mission_fixes` in scripts/gfs_ingest.py. */
export function dropFrozenRepeats<T extends { lat: number; lon: number }>(fixes: T[]): T[] {
    return fixes.filter((f, i) => i === 0 || f.lat !== fixes[i - 1].lat || f.lon !== fixes[i - 1].lon);
}

/** Next-packet window for a split fix: the stale coordinate's fresh value is
 *  read at the very next GPS wake (one telemetry interval, ~5 min). */
const SPLIT_FIX_MAX_GAP_MS = 15 * 60_000;

/** Repair split fixes: a packet whose lon changed but lat did not carries a
 *  stale latitude. The May 2026 firmware polled the receiver once per field,
 *  latitude first (SparkFun u-blox, no autoPVT); when that poll timed out on a
 *  slow wake it returned the cached old latitude, the longitude poll got a
 *  fresh solution, and that solution's latitude was only read at the next wake.
 *  So when the very next packet changes the latitude, that value belongs to
 *  this packet's solution: copy it back. (Longitude cannot go stale this way:
 *  a latitude poll that succeeds refreshes every field.) stratolink-3 over
 *  Spain: 127 m/s and 25 m/s staircase steps become 3–4 m/s, matching the
 *  GPS's own speed. Exact equality, as in dropFrozenRepeats. Run it before
 *  dropFrozenRepeats on every packet (repeats included). Mirrors
 *  `repair_split_fixes` in scripts/gfs_ingest.py. */
export function repairSplitFixes<T extends { lat: number; lon: number; t: string | number }>(fixes: T[]): T[] {
    const out = fixes.map((f) => ({ ...f }));
    for (let i = 1; i < out.length - 1; i++) {
        const [a, b, c] = [out[i - 1], out[i], out[i + 1]];
        if (new Date(c.t).getTime() - new Date(b.t).getTime() > SPLIT_FIX_MAX_GAP_MS) continue;
        if (b.lat === a.lat && b.lon !== a.lon && c.lat !== b.lat) b.lat = c.lat;
    }
    return out;
}
