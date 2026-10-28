import assert from 'node:assert/strict';
import test from 'node:test';
import { GPS_DARK_MS, appendForecastLegs, estimatedLeg, forecastTimes, liveEstimateT, projectedPosition } from './forecastTrack.ts';

const H = 3_600_000;
const legs = { predictedHindcast: [[0, 0], [1, 0], [2, 0]], path: [[2, 0], [4, 0], [6, 0]], originT: 10 * H, endT: 14 * H, staleGps: true };

test('forecast times come from the origin and horizon, or not at all', () => {
    assert.deepEqual(forecastTimes('1970-01-01T10:00:00Z', 4), { originT: 10 * H, endT: 14 * H });
    assert.deepEqual(forecastTimes('1970-01-01T10:00:00Z', '4'), { originT: 10 * H, endT: 14 * H });
    assert.deepEqual(forecastTimes('1970-01-01T10:00:00Z', undefined), { originT: 10 * H, endT: null });
    assert.deepEqual(forecastTimes(undefined, 4), { originT: null, endT: null });
});

test('the forecast legs continue the track from its last point', () => {
    const track = appendForecastLegs([{ lon: 0, lat: 0, t: 8 * H }], legs);
    assert.deepEqual(track.map(point => [point.lon, point.t / H]), [[0, 8], [1, 9], [2, 10], [4, 12], [6, 14]]);
    /* No drift leg when the forecast starts at the last fix. */
    assert.deepEqual(appendForecastLegs([{ lon: 2, lat: 0, t: 10 * H }], legs).map(point => point.t / H), [10, 12, 14]);
});

test('live follows the forecast only while GPS is dark and the forecast knows the last fix', () => {
    assert.equal(liveEstimateT(legs, 8 * H, 11 * H), 11 * H);
    assert.equal(liveEstimateT(legs, 8 * H, 20 * H), 14 * H, 'parks at the horizon end');
    assert.equal(liveEstimateT(legs, 8 * H, null), 10 * H, 'origin before the clock mounts');
    assert.equal(liveEstimateT(legs, 10.5 * H, 11 * H), null, 'superseded by a newer fix');
    const fresh = { ...legs, staleGps: false, originT: 8 * H };
    assert.equal(liveEstimateT(fresh, 8 * H, 8 * H + GPS_DARK_MS - 1), null, 'GPS still fresh');
    assert.equal(liveEstimateT(fresh, 8 * H, 9 * H), 9 * H, 'dark once the fix is an hour old');
    assert.equal(liveEstimateT({ ...legs, originT: null }, 8 * H, 11 * H), null);
});

test('projected positions glide along the forecast, wrap longitude and refuse stale forecasts', () => {
    const lastFix = { lon: 0, lat: 0, t: 8 * H };
    assert.deepEqual(projectedPosition(lastFix, legs, 11 * H), { lat: 0, lon: 3 });
    assert.deepEqual(projectedPosition(lastFix, legs, 99 * H), { lat: 0, lon: 6 });
    assert.deepEqual(projectedPosition({ lon: 179, lat: 0, t: 0 }, { ...legs, predictedHindcast: [], path: [[179, 0], [181, 0]], originT: 0, endT: 2 * H }, 2 * H), { lat: 0, lon: -179 });
    assert.equal(projectedPosition({ ...lastFix, t: 11 * H }, legs, 12 * H), null);
    assert.equal(projectedPosition(lastFix, { ...legs, path: [] }, 12 * H), null);
});

test('the estimated leg runs from the last fix to the balloon and no further', () => {
    const lastFix = { lon: 0, lat: 0, t: 8 * H };
    assert.deepEqual(estimatedLeg(lastFix, legs, 9.5 * H), { drift: [[0, 0], [1, 0], [1.5, 0]], ahead: [] });
    assert.deepEqual(estimatedLeg(lastFix, legs, 11 * H), { drift: [[0, 0], [1, 0], [2, 0]], ahead: [[2, 0], [3, 0]] });
    assert.deepEqual(estimatedLeg(lastFix, legs, 99 * H).ahead.at(-1), [6, 0]);
    assert.equal(estimatedLeg(lastFix, legs, 8 * H), null);
    assert.equal(estimatedLeg({ ...lastFix, t: 11 * H }, legs, 12 * H), null);
});

test('lastFixTime is the first packet of a trailing run of frozen-GPS repeats', async () => {
    const { lastFixTime } = await import('./forecastTrack.ts');
    const rows = [
        { t: 1, lat: 36.0, lon: -4.0 }, { t: 2, lat: 36.8893, lon: -4.5322 }, { t: 3, lat: null, lon: null },
        { t: 4, lat: 36.8893, lon: -4.5322 }, { t: 5, lat: 36.8893, lon: -4.5322 }, { t: 6, lat: null, lon: null },
    ];
    assert.equal(lastFixTime(rows), 2);
    assert.equal(lastFixTime([{ t: 1, lat: 1, lon: 2 }, { t: 2, lat: 1, lon: 3 }]), 2);
    assert.equal(lastFixTime([{ t: 1, lat: null, lon: null }]), null);
});
