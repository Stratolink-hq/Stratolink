/**
 * GPS quirks of the May 2026 firmware (lib/wind/trackSegments.ts), the same
 * rules as mission_fixes in scripts/gfs_ingest.py:
 *   - repairSplitFixes: a packet whose lon moved but lat did not takes the
 *     latitude of the next packet (≤ 15 min later) when that packet changes it
 *   - dropFrozenRepeats: only the first packet of a run of identical positions
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
