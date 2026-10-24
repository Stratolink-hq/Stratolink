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
    /** The fix the tubes were laid out from (the plan's `origin_utc` at ingest time). */
    origin_fix_utc: string | null;
    /** Last slice of the reconstruction cube, epoch ms (null: single-fix device, no recon cube). */
    recon_end_ms: number | null;
};

/**
 * How far past the fix the cubes were laid out from a newer fix may be and
 * still be re-anchored on. The forecast tube follows the dead-reckon from that
 * fix and the reconstruction cube ends two 3-h steps after it, so a balloon
 * that reappears after a longer silence sits outside both; its forecast waits
 * for the next scheduled ingest (≤ 6 h away, the same bound).
 */
export const REANCHOR_MAX_GAP_H = 6;

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
    /** Operator override: rebuild from the current set even when the stored
     *  forecast already starts from the newest fix. Every cube rule still applies. */
    force?: boolean;
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
 * and the cube set must exist, be no older than the cubes the stored forecast
 * came from, have been laid out from a fix within REANCHOR_MAX_GAP_H of the
 * newest one (and its reconstruction cube must reach it), and span the fix and
 * "now" (the forecast integrates forward from now; a cube that ends before it
 * has no wind to give).
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
    if (!d.force && storedFixMs != null && Math.abs(storedFixMs - fixMs) < 1000) {
        return {
            ...base, action: 'skip',
            reason: `stored forecast (${d.stored?.generated_at}) already starts from the newest fix ${d.newestFixUtc}`,
        };
    }

    if (!d.cubes) return { ...base, action: 'skip', reason: 'no cube set in Blob (the scheduled ingest has not published one)' };
    const fmt = (ms: number) => new Date(ms).toISOString();
    /* Never trade a forecast built from newer cubes for one from older cubes: a
     * scheduled run stores its forecast before it publishes its set, and a
     * recompute landing in that window would otherwise undo it. */
    const cubesBuiltMs = parseMs(d.cubes.cube_generated_at);
    const storedCubesMs = parseMs(d.stored?.cube_generated_at);
    if (cubesBuiltMs != null && storedCubesMs != null && cubesBuiltMs < storedCubesMs) {
        return {
            ...base, action: 'skip',
            reason: `cube set (built ${d.cubes.cube_generated_at}) is older than the stored forecast's cubes (${d.stored?.cube_generated_at}) — the scheduled run is ahead`,
        };
    }
    const originMs = parseMs(d.cubes.origin_fix_utc);
    if (originMs != null && fixMs - originMs > REANCHOR_MAX_GAP_H * HOUR_MS) {
        return {
            ...base, action: 'skip',
            reason: `newest fix is ${fmtH((fixMs - originMs) / HOUR_MS)} past the fix the cubes were laid out from (${d.cubes.origin_fix_utc}) — wait for the scheduled ingest`,
        };
    }
    if (d.cubes.recon_end_ms != null && fixMs > d.cubes.recon_end_ms) {
        return {
            ...base, action: 'skip',
            reason: `reconstruction cube ends ${fmt(d.cubes.recon_end_ms)}, before the newest fix ${d.newestFixUtc} — wait for the scheduled ingest`,
        };
    }
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
        reason: (d.force ? 'forced rebuild' : behindH == null ? 'no stored forecast yet' : `stored forecast starts ${fmtH(behindH)} behind the newest fix`)
            + `; cubes built ${d.cubes.cube_generated_at ?? 'at an unknown time'} cover +${fmtH(aheadH)}`
            + (aheadH < HORIZON_H ? ` (short of the ${HORIZON_H} h horizon — forecast will be coverage-limited)` : ''),
    };
}
