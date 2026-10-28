/**
 * GPS quirks of the May 2026 firmware (lib/wind/trackSegments.ts), the same
 * rules as mission_fixes in scripts/gfs_ingest.py:
 *   - repairSplitFixes: a packet whose lon moved but lat did not takes the
 *     latitude of the next packet (≤ 15 min later) when that packet changes it
 *   - dropFrozenRepeats: only the first packet of a run of identical positions
 * and appendFrozenTail (lib/wind/pathReconstruction.ts): the wind drift from the
 * last fix to the last frozen ping.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { dropFrozenRepeats, repairSplitFixes } from '../lib/wind/trackSegments.ts';

const fix = (t, lat, lon) => ({ t, lat, lon });

test('dropFrozenRepeats keeps the first packet of each run of identical positions', () => {
    const track = [
        fix(0, 40, -6), fix(1, 40, -6), fix(2, 40, -6), fix(3, 40.1, -5.9),
        fix(4, 40.1, -5.8), fix(5, 40.1, -5.8),
    ];
    assert.deepEqual(dropFrozenRepeats(track).map((f) => f.t), [0, 3, 4]);
});

test('dropFrozenRepeats: one coordinate changing is a new fix; a return to an old position is too', () => {
    const track = [fix(0, 40, -6), fix(1, 40, -5.9), fix(2, 40, -6)];
    assert.deepEqual(dropFrozenRepeats(track).map((f) => f.t), [0, 1, 2]);
});

test('dropFrozenRepeats leaves empty and single-fix tracks alone', () => {
    assert.deepEqual(dropFrozenRepeats([]), []);
    assert.deepEqual(dropFrozenRepeats([fix(0, 1, 2)]), [fix(0, 1, 2)]);
});

const at = (min) => new Date(Date.UTC(2026, 4, 28, 8, min)).toISOString();

test('repairSplitFixes copies the stale coordinate back from the next packet', () => {
    /* Coordinates from stratolink-3, 2026-05-28 17:04–17:19 UTC: lon moved at 17:09 with
     * a stale lat; the fresh lat arrived at 17:14 with everything else unchanged. */
    const track = [
        fix(at(0), 40.61678, -5.365152), fix(at(5), 40.61678, -5.30643),
        fix(at(10), 40.547228, -5.30643), fix(at(15), 40.547228, -5.30643),
    ];
    const repaired = repairSplitFixes(track);
    assert.deepEqual(repaired[1], fix(at(5), 40.547228, -5.30643));
    assert.deepEqual(dropFrozenRepeats(repaired).map((f) => f.t), [at(0), at(5)]);
});

test('repairSplitFixes leaves a lat-only move alone (the firmware never left lon stale)', () => {
    const track = [fix(at(0), 40.0, -6.0), fix(at(5), 40.1, -6.0), fix(at(10), 40.1, -5.9)];
    assert.deepEqual(repairSplitFixes(track), track);
});

test('repairSplitFixes leaves a split fix alone when the next packet is late or does not complete it', () => {
    const late = [fix(at(0), 40.6, -5.4), fix(at(5), 40.6, -5.3), fix(at(60), 40.5, -5.3)];
    assert.deepEqual(repairSplitFixes(late), late);
    const unfinished = [fix(at(0), 40.6, -5.4), fix(at(5), 40.6, -5.3), fix(at(10), 40.6, -5.3)];
    assert.deepEqual(repairSplitFixes(unfinished), unfinished);
});

test('repairSplitFixes does not touch fixes where both coordinates moved, nor mutate its input', () => {
    const track = [fix(at(0), 40.0, -6.0), fix(at(5), 40.1, -5.9), fix(at(10), 40.2, -5.8)];
    const copy = structuredClone(track);
    assert.deepEqual(repairSplitFixes(track), copy);
    assert.deepEqual(track, copy);
});

/* ── appendFrozenTail (lib/wind/pathReconstruction.ts) ─────────────────── */

const HOUR = 3_600_000;
/** Uniform wind (m/s) over a 1° box from −10…50° lat/lon, hourly slices from t = 0. */
function uniformCube(u, v, slices) {
    const grid = () => ({ lat0: -10, dLat: 1, nLat: 61, lon0: -10, dLon: 1, nLon: 61, U: new Float32Array(61 * 61).fill(u), V: new Float32Array(61 * 61).fill(v) });
    return {
        t0Ms: 0, stepMs: HOUR, gridStep: 1, levelHpa: 300, isTube: false, source: 'test',
        bounds: { latMin: -10, latMax: 50, lonMin: -10, lonMax: 50 },
        grids: Array.from({ length: slices }, grid),
    };
}
const lastFix = { lat: 10, lon: 10, time_utc: new Date(0).toISOString() };
const recon = () => ({
    reconstructed_path: [[9, 10], [10, 10]],
    reconstructed_track: [{ lon: 9, lat: 10, time_utc: new Date(-HOUR).toISOString() }, { lon: 10, lat: 10, time_utc: lastFix.time_utc }],
    gap_bridges: [], gaps: [], compute_ms: 0,
});

test('appendFrozenTail drifts with the wind from the last fix to the last ping', async () => {
    const { appendFrozenTail } = await import('../lib/wind/pathReconstruction.ts');
    const until = 70 * 60_000;                                   // 1 h 10 min of frozen pings
    const out = appendFrozenTail(recon(), lastFix, until, uniformCube(10, 0, 4), 280);
    const tail = out.reconstructed_track.slice(2);
    assert.equal(tail.length, 7);                                // 10-min steps, the last one ends on the ping
    assert.equal(tail.at(-1).time_utc, new Date(until).toISOString());
    const expectLon = 10 + (10 * 4200) / (111_320 * Math.cos((10 * Math.PI) / 180));
    assert.ok(Math.abs(tail.at(-1).lon - expectLon) < 2e-4, `${tail.at(-1).lon} vs ${expectLon}`);
    assert.equal(tail.at(-1).lat, 10);
    assert.deepEqual(out.reconstructed_path.at(-1), [tail.at(-1).lon, tail.at(-1).lat]);
    assert.deepEqual(out.frozen_tail, { from_utc: lastFix.time_utc, until_utc: new Date(until).toISOString(), reached_utc: tail.at(-1).time_utc });
});

test('appendFrozenTail stops where the cube ends and leaves a ping-less flight alone', async () => {
    const { appendFrozenTail } = await import('../lib/wind/pathReconstruction.ts');
    const short = appendFrozenTail(recon(), lastFix, 5 * HOUR, uniformCube(10, 0, 3), 280);   // slices 0–2 h
    assert.equal(short.frozen_tail.reached_utc, new Date(2 * HOUR).toISOString());
    const none = recon();
    assert.equal(appendFrozenTail(none, lastFix, 30_000, uniformCube(10, 0, 3), 280), none);   // ping within a minute
});
