import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCubeManifest, cubeBlobPath, cubeFilesFor, cubeManifestPath, cubeSetId, devicesToUpload, readCubeHeader, setIdsFromKeys } from './upload_cubes.mjs';

/** A `.slwc` with just a header (the upload step only parses the header). */
function slwc(header) {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Math.ceil(json.length / 4) * 4;
  const buf = Buffer.alloc(4 + len, 0x20);
  buf.writeUInt32LE(len, 0);
  json.copy(buf, 4);
  return buf;
}

test('a device cube set is exactly its forecast, reconstruction and member cubes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stratolink-cubes-'));
  try {
    for (const f of ['s-1-fc.slwc', 's-1.slwc', 's-1-m00.slwc', 's-1-m01.slwc', 's-1-a00.slwc', 's-10-fc.slwc', 's-10-m00.slwc', 's-1.json', 'plan.json', 's-1-fc.slwc.tmp']) {
      writeFileSync(join(dir, f), '');
    }
    assert.deepEqual(cubeFilesFor(dir, 's-1'), ['s-1-a00.slwc', 's-1-fc.slwc', 's-1-m00.slwc', 's-1-m01.slwc', 's-1.json', 's-1.slwc']);
    assert.deepEqual(cubeFilesFor(dir, 's-10'), ['s-10-fc.slwc', 's-10-m00.slwc']);
    assert.deepEqual(cubeFilesFor(dir, 'ghost'), []);
    assert.deepEqual(cubeFilesFor(join(dir, 'missing'), 's-1'), []);
    /* Devices: requested > plan builds > forecast cubes on disk. */
    assert.deepEqual(devicesToUpload(dir, null, 'only'), ['only']);
    assert.deepEqual(devicesToUpload(dir, { devices: [{ device_id: 'a', action: 'build' }, { device_id: 'b', action: 'skip' }] }, null), ['a']);
    assert.deepEqual(devicesToUpload(dir, { devices: [{ device_id: 'b', action: 'skip' }] }, null).sort(), ['s-1', 's-10']);
  } finally { rmSync(dir, { recursive: true }); }
});

test('blob keys nest each versioned set under cubes/{device}/{set}/ with the manifest beside the sets', () => {
  const header = { generated_at: '2026-10-23T20:36:45.240040+00:00' };
  assert.equal(cubeSetId(header), '20261023T203645Z');
  assert.equal(cubeSetId({}, new Date('2026-10-23T21:00:00Z')), '20261023T210000Z');
  assert.equal(cubeBlobPath('stratolink-1', '20261023T203645Z', 'stratolink-1-m03.slwc'), 'cubes/stratolink-1/20261023T203645Z/stratolink-1-m03.slwc.gz');
  assert.equal(cubeManifestPath('stratolink-1'), 'cubes/stratolink-1/manifest.json');
  /* Set ids come back newest first; the manifest and other devices are ignored. */
  assert.deepEqual(setIdsFromKeys('s-1', [
    'cubes/s-1/manifest.json', 'cubes/s-1/20261023T143000Z/s-1-fc.slwc.gz', 'cubes/s-1/20261023T203645Z/s-1-fc.slwc.gz',
    'cubes/s-1/20261023T203645Z/s-1-m00.slwc.gz', 'cubes/s-10/20261023T203645Z/s-10-fc.slwc.gz',
  ]), ['20261023T203645Z', '20261023T143000Z']);
});

test('the set manifest records the cube build time, the forecast span and member counts', () => {
  const t0 = Date.parse('2026-10-23T17:00:00Z');
  const header = { v: 2, t0Ms: t0, stepMs: 3_600_000, nGrids: 31, levelHpa: 280, generated_at: '2026-10-23T17:40:00+00:00', latest_cycle_utc: '2026-10-23T12:00:00+00:00' };
  assert.deepEqual(readCubeHeader(slwc(header)), header);
  const files = ['d-fc.slwc', 'd.slwc', 'd-m00.slwc', 'd-m01.slwc', 'd-m02.slwc', 'd-a00.slwc'];
  const ingest = { sources: { gefs: { members_expected: 31, devices: { d: { expected: 3 } } }, aigefs: { members_expected: 31 } } };
  const reconHeader = { v: 5, t0Ms: t0 - 6 * 3_600_000, stepMs: 3 * 3_600_000, nGrids: 5 };
  const m = buildCubeManifest({ deviceId: 'd', setId: 'S', header, reconHeader, files, ingest, planGeneratedAt: 'p',
    planDevice: { device_id: 'd', origin_utc: '2026-10-23T17:20:00Z' }, now: new Date('2026-10-23T17:45:00Z') });
  assert.equal(m.set, 'S');
  assert.equal(m.origin_utc, '2026-10-23T17:20:00Z');
  assert.deepEqual(m.reconstruction_cube, { t0_utc: '2026-10-23T11:00:00.000Z', end_utc: '2026-10-23T23:00:00.000Z', step_h: 3, n_grids: 5, level_hpa: null });
  assert.equal(m.cube_generated_at, header.generated_at);
  assert.equal(m.uploaded_at, '2026-10-23T17:45:00.000Z');
  assert.equal(m.plan_generated_at, 'p');
  assert.deepEqual(m.forecast_cube, { t0_utc: '2026-10-23T17:00:00.000Z', end_utc: '2026-10-24T23:00:00.000Z', step_h: 1, n_grids: 31, level_hpa: 280 });
  assert.deepEqual(m.members, { gefs: 3, aigefs: 1 });
  assert.deepEqual(m.members_expected, { gefs: 3, aigefs: 31 });
  assert.deepEqual(m.files, files);
  /* No ingest manifest (local run): no expectations, still a valid set. */
  const bare = buildCubeManifest({ deviceId: 'd', setId: 'S', header, files, ingest: null });
  assert.deepEqual(bare.members_expected, {});
  assert.equal(bare.origin_utc, null);
  assert.equal(bare.reconstruction_cube, null);
});
