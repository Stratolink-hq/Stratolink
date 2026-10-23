/**
 * Recompute-tier rules — whether a per-fix recompute of one device's forecast
 * should run, shared by scripts/recompute_forecast.ts and its tests.
 *
 * The scheduled worker (.github/workflows/gfs-ingest.yml) downloads NOAA data
 * four times a day and publishes each flying device's cube set to Blob
 * (`cubes/{device}/…`, scripts/upload_cubes.mjs). Between runs a balloon keeps
 * reporting fixes every ~20 min, so the stored forecast's origin falls up to 6 h
 * behind it. The recompute tier (.github/workflows/forecast-recompute.yml,
 * dispatched by the TTN webhook on each stored fix) pulls that cube set back onto
 * a runner and re-integrates the forecast from the newest fix — no Python, no
 * GRIB, no NOAA. It must be a no-op whenever a run could not improve the stored
 * forecast, because the webhook fires it for every packet.
 *
 * Pure: no I/O.
 */
import { HORIZON_H } from './forecastPlan';
import type { StoredForecastSummary } from './forecastPlan';

export type CubeSetSummary = {
    /** When the ingest built the set (the forecast cube's `generated_at`). */
    cube_generated_at: string | null;
    /** Time span of the forecast cube: first and last slice, epoch ms. */
    t0Ms: number;
    tEndMs: number;
};

export type RecomputeInput = {
    deviceId: string;
    /** `devices.status` — only `flying` balloons are recomputed. */
    status: string | null;
    /** `devices.connection_status = 'connected'`. */
    connected: boolean;
    /** Newest GPS fix in the mission window (null in launch-only mode or with no fixes). */
    newestFixUtc: string | null;
    nFixes: number;
    stored: StoredForecastSummary | null;
    /** The device's cube set in Blob, or null when there is none (or no forecast cube). */
    cubes: CubeSetSummary | null;
};

export type RecomputeDecision = {
    device_id: string;
    action: 'build' | 'skip';
    reason: string;
    origin_utc: string | null;
};

const HOUR_MS = 3_600_000;

function parseMs(iso: string | null | undefined): number | null {
    if (!iso) return null;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
}

const fmtH = (h: number) => (h >= 48 ? `${(h / 24).toFixed(1)} d` : `${h.toFixed(1)} h`);

/**
 * Decide one device. In order: the device must be flying and connected, have a
 * fix to start from, the stored forecast must not already start from that fix,
 * and the cube set must exist and span the fix and "now" (the forecast
 * integrates forward from now; a cube that ends before it has no wind to give).
 * A cube that ends before now + HORIZON_H still builds — the compute truncates
 * honestly (`coverage_limited`) and the next scheduled run restores the horizon.
 */
export function decideRecompute(d: RecomputeInput, nowMs = Date.now()): RecomputeDecision {
    const base = { device_id: d.deviceId, origin_utc: d.newestFixUtc };
    if (d.status !== 'flying') {
        return { ...base, action: 'skip', reason: `device is not flying (status ${d.status ?? 'unset'})` };
    }
    if (!d.connected) return { ...base, action: 'skip', reason: 'device is not a connected registry entry' };

    const fixMs = parseMs(d.newestFixUtc);
    if (d.nFixes < 1 || fixMs == null) {
        return { ...base, origin_utc: null, action: 'skip', reason: 'no GPS fix in the mission window to start from' };
    }

    const storedFixMs = parseMs(d.stored?.last_fix_utc);
    if (storedFixMs != null && Math.abs(storedFixMs - fixMs) < 1000) {
        return {
            ...base, action: 'skip',
            reason: `stored forecast (${d.stored?.generated_at}) already starts from the newest fix ${d.newestFixUtc}`,
        };
    }

    if (!d.cubes) return { ...base, action: 'skip', reason: 'no cube set in Blob (the scheduled ingest has not published one)' };
    const fmt = (ms: number) => new Date(ms).toISOString();
    if (fixMs < d.cubes.t0Ms || fixMs > d.cubes.tEndMs) {
        return {
            ...base, action: 'skip',
            reason: `cube set (${fmt(d.cubes.t0Ms)} → ${fmt(d.cubes.tEndMs)}) does not cover the newest fix ${d.newestFixUtc}`,
        };
    }
    if (nowMs > d.cubes.tEndMs) {
        return {
            ...base, action: 'skip',
            reason: `cube set ends ${fmt(d.cubes.tEndMs)}, ${fmtH((nowMs - d.cubes.tEndMs) / HOUR_MS)} before now — stale, wait for the scheduled ingest`,
        };
    }

    const aheadH = (d.cubes.tEndMs - nowMs) / HOUR_MS;
    const behindH = storedFixMs == null ? null : (fixMs - storedFixMs) / HOUR_MS;
    return {
        ...base, action: 'build',
        reason: (behindH == null ? 'no stored forecast yet' : `stored forecast starts ${fmtH(behindH)} behind the newest fix`)
            + `; cubes built ${d.cubes.cube_generated_at ?? 'at an unknown time'} cover +${fmtH(aheadH)}`
            + (aheadH < HORIZON_H ? ` (short of the ${HORIZON_H} h horizon — forecast will be coverage-limited)` : ''),
    };
}
