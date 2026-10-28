import assert from 'node:assert/strict';
import test from 'node:test';
import { flightTrack } from './flightTrack.ts';
test('GPS spikes do not become flight paths while valid travel is retained', () => {
  const rows = [{ t: 0, lat: 37, lon: -122 }, { t: 60000, lat: 25, lon: -122 }, { t: 120000, lat: 37.01, lon: -122 }, { t: 180000, lat: -208, lon: 0 }];
  assert.deepEqual(flightTrack(rows), [rows[0], rows[2]]);
  assert.equal(rows.length, 4);
});

test('gpsFixes keeps one packet per GPS position and repairs a stale latitude', async () => {
  const { gpsFixes } = await import('./flightTrack.ts');
  const MIN = 60_000;
  /* Shaped like stratolink-3 on 2026-05-28: lon moves at 5 min with the old lat,
   * the fresh lat arrives at 10 min, then the GPS freezes on that position. */
  const rows = [
    { t: 0, lat: 40.61678, lon: -5.365152 }, { t: 5 * MIN, lat: 40.61678, lon: -5.30643 },
    { t: 10 * MIN, lat: 40.547228, lon: -5.30643 }, { t: 15 * MIN, lat: 40.547228, lon: -5.30643 },
    { t: 20 * MIN, lat: null, lon: null }, { t: 25 * MIN, lat: 40.547228, lon: -5.30643 },
  ];
  assert.deepEqual(gpsFixes(rows), [{ t: 0, lat: 40.61678, lon: -5.365152 }, { t: 5 * MIN, lat: 40.547228, lon: -5.30643 }]);
  assert.equal(rows[1].lat, 40.61678);   // input untouched
});
