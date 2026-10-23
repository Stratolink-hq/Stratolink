import assert from 'node:assert/strict';
import test from 'node:test';
import { extendWithNewerFixes, liveForecastPath, timedForecastLeg } from './liveTrack.ts';

const H = 3_600_000;
const track = [{ lon: -122.44, lat: 37.76, t: 0 }, { lon: -122.46, lat: 37.68, t: H }, { lon: -122.46, lat: 37.56, t: 2 * H }];

test('fixes reported after the stored track are appended in order', () => {
  const fixes = [{ lon: -122.44, lat: 37.76, t: 0 }, { lon: -122.46, lat: 37.56, t: 2 * H }, { lon: -122.41, lat: 37.40, t: 3 * H }, { lon: -122.37, lat: 37.15, t: 4 * H }];
  assert.deepEqual(extendWithNewerFixes(track, fixes), [...track, fixes[2], fixes[3]]);
});

test('a track with nothing newer is returned unchanged, and an empty track is just the fixes', () => {
  const same = extendWithNewerFixes(track, track);
  assert.equal(same, track);
  assert.deepEqual(extendWithNewerFixes([], track), track);
});

test('the forecast leg is timed evenly from origin to horizon, skipping the origin point', () => {
  const path = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]];
  const leg = timedForecastLeg(path, 10 * H, 14 * H, null);
  assert.deepEqual(leg.map(p => p.t / H), [11, 12, 13, 14]);
  assert.deepEqual(leg.map(p => p.lon), [1, 2, 3, 4]);
});

test('forecast points the balloon has flown past are dropped from the leg', () => {
  const path = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]];
  const leg = timedForecastLeg(path, 10 * H, 14 * H, 12 * H);
  assert.deepEqual(leg.map(p => p.t / H), [13, 14]);
  assert.deepEqual(timedForecastLeg(path, 10 * H, 14 * H, 14 * H), []);
  assert.deepEqual(timedForecastLeg(path, 10 * H, 10 * H, null), []);
  assert.deepEqual(timedForecastLeg([[0, 0]], 10 * H, 14 * H, null), []);
});

test('the drawn projection is the stored path while no fix postdates the forecast origin', () => {
  const path = [[0, 0], [1, 0], [2, 0]];
  assert.equal(liveForecastPath(path, 10 * H, 12 * H, null), path);
  assert.equal(liveForecastPath(path, 10 * H, 12 * H, { lon: 0, lat: 0, t: 10 * H }), path);
  assert.equal(liveForecastPath(path, null, 12 * H, { lon: 0, lat: 0, t: 11 * H }), path);
});

test('once newer fixes exist the projection starts at the newest fix and keeps only what is ahead', () => {
  const path = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]];
  const fix = { lon: 1.4, lat: 0.1, t: 11.5 * H };
  assert.deepEqual(liveForecastPath(path, 10 * H, 14 * H, fix), [[1.4, 0.1], [2, 0], [3, 0], [4, 0]]);
  assert.deepEqual(liveForecastPath(path, 10 * H, 14 * H, { ...fix, t: 14 * H }), []);
});
