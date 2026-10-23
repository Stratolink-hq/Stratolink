#!/usr/bin/env node
/**
 * Cube upload — the last ingest step of .github/workflows/gfs-ingest.yml.
 *
 * Publishes the cubes the ingest just wrote to WIND_CUBE_DIR (the GFS forecast
 * tube `{device}-fc.slwc`, the reconstruction cube `{device}.slwc` and every
 * GEFS / AIGEFS member `{device}-mNN.slwc` / `{device}-aNN.slwc`) to the private
 * Blob store under `cubes/{device}/{file}.gz`, plus a `cubes/{device}/manifest.json`
 * describing the set (when it was built, what it covers, member counts). The
 * recompute tier (.github/workflows/forecast-recompute.yml →
 * scripts/recompute_forecast.ts) pulls exactly these files back onto a runner to
 * re-anchor the forecast on each new GPS fix without touching NOAA. ~40 KB per
 * member, ~2.5 MB per device per run; scripts/blob_cleanup.mjs purges sets older
 * than two days (a landed balloon's cubes), live sets are overwritten in place.
 *
 * Which devices: the plan (FORECAST_PLAN) devices marked `build`, else every
 * device with a forecast cube in the directory (local runs). The manifest is
 * written last so a reader that finds it can expect the cubes beside it.
 *
 *   node scripts/upload_cubes.mjs [device]        (npm run forecast:upload-cubes)
 * Env: BLOB_READ_WRITE_TOKEN, WIND_CUBE_DIR (default .windcube/cubes),
 *      FORECAST_PLAN, FORECAST_MANIFEST (member expectations for the manifest).
 */
import { put } from '@vercel/blob';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

export const CUBE_SET_VERSION = 1;
const HOUR_MS = 3_600_000;

const cubeDir = process.env.WIND_CUBE_DIR ?? join(process.cwd(), '.windcube', 'cubes');
const planPath = process.env.FORECAST_PLAN ?? join(process.cwd(), '.windcube', 'plan.json');
const manifestPath = process.env.FORECAST_MANIFEST ?? join(process.cwd(), '.windcube', 'manifest.json');

const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

/** Blob key of one cube file inside a device's set. */
export function cubeBlobPath(deviceId, fileName) {
    return `cubes/${encodeURIComponent(deviceId)}/${fileName}.gz`;
}
export function cubeManifestPath(deviceId) {
    return `cubes/${encodeURIComponent(deviceId)}/manifest.json`;
}

/** The files of one device's cube set in `dir`: `{id}-fc.slwc`, `{id}.slwc`,
 *  `{id}-mNN.slwc`, `{id}-aNN.slwc` (and legacy `.json`), sorted. */
export function cubeFilesFor(dir, deviceId) {
    const re = new RegExp(`^${deviceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-fc|-[ma]\\d+)?\\.(slwc|json)$`);
    let files = [];
    try { files = readdirSync(dir); } catch { return []; }
    return files.filter((f) => re.test(f)).sort();
}

/** Parse just the header of a packed `.slwc` cube: `[uint32 LE len][JSON]`. */
export function readCubeHeader(buf) {
    const len = buf.readUInt32LE(0);
    return JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
}

/** Devices to upload: a requested id, else the plan's `build` devices, else every
 *  device with a forecast cube on disk. */
export function devicesToUpload(dir, plan, only) {
    if (only) return [only];
    const planned = plan?.devices?.filter((d) => d.action === 'build').map((d) => d.device_id);
    if (planned?.length) return planned;
    let files = [];
    try { files = readdirSync(dir); } catch { return []; }
    return [...new Set(files.map((f) => f.match(/^(.+)-fc\.(slwc|json)$/)?.[1]).filter(Boolean))];
}

/** The per-device manifest: what the set covers and holds. `header` is the
 *  forecast cube's `.slwc` header, `files` the uploaded names (without `.gz`). */
export function buildCubeManifest({ deviceId, header, files, ingest, planGeneratedAt, now = new Date() }) {
    const members = { gefs: 0, aigefs: 0 };
    for (const f of files) {
        if (/-m\d+\.slwc$/.test(f)) members.gefs++;
        else if (/-a\d+\.slwc$/.test(f)) members.aigefs++;
    }
    const expected = {};
    for (const src of ['gefs', 'aigefs']) {
        const rec = ingest?.sources?.[src];
        const exp = rec?.devices?.[deviceId]?.expected ?? rec?.members_expected;
        if (typeof exp === 'number') expected[src] = exp;
    }
    const stepMs = header?.stepMs ?? HOUR_MS;
    const nGrids = header?.nGrids ?? 0;
    return {
        version: CUBE_SET_VERSION,
        device_id: deviceId,
        uploaded_at: now.toISOString(),
        /* The ingest's own stamp — what the plan step compares cube freshness by. */
        cube_generated_at: header?.generated_at ?? null,
        latest_cycle_utc: header?.latest_cycle_utc ?? null,
        plan_generated_at: planGeneratedAt ?? null,
        forecast_cube: header
            ? { t0_utc: new Date(header.t0Ms).toISOString(), end_utc: new Date(header.t0Ms + Math.max(0, nGrids - 1) * stepMs).toISOString(),
                step_h: stepMs / HOUR_MS, n_grids: nGrids, level_hpa: header.levelHpa ?? null }
            : null,
        members,
        members_expected: expected,
        files,
    };
}

async function uploadDevice(deviceId) {
    const files = cubeFilesFor(cubeDir, deviceId);
    const fc = files.find((f) => /-fc\.slwc$/.test(f));
    if (!fc) {
        console.log(`  ${deviceId}: no forecast cube in ${cubeDir} — nothing to upload`);
        return false;
    }
    const header = readCubeHeader(readFileSync(join(cubeDir, fc)));
    let rawBytes = 0, gzBytes = 0;
    const t0 = Date.now();
    /* A few at a time: dozens of 40 KB members, one HTTP round-trip each. */
    const queue = [...files];
    const worker = async () => {
        for (let f = queue.shift(); f; f = queue.shift()) {
            const raw = readFileSync(join(cubeDir, f));
            const gz = gzipSync(raw, { level: 6 });
            rawBytes += raw.length; gzBytes += gz.length;
            await put(cubeBlobPath(deviceId, f), gz, {
                access: 'private', addRandomSuffix: false, contentType: 'application/gzip', allowOverwrite: true,
            });
        }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    const manifest = buildCubeManifest({
        deviceId, header, files, ingest: readJson(manifestPath), planGeneratedAt: readJson(planPath)?.generated_at,
    });
    await put(cubeManifestPath(deviceId), JSON.stringify(manifest), {
        access: 'private', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true,
    });
    const fcs = manifest.forecast_cube;
    console.log(
        `  ${deviceId}: ${files.length} cube(s), ${Math.round(rawBytes / 1024)} KB → ${Math.round(gzBytes / 1024)} KB gz` +
        ` in ${((Date.now() - t0) / 1000).toFixed(1)} s | members gefs ${manifest.members.gefs}, aigefs ${manifest.members.aigefs}` +
        ` | forecast cube ${fcs?.t0_utc ?? '?'} → ${fcs?.end_utc ?? '?'} | built ${manifest.cube_generated_at ?? '?'}`,
    );
    return true;
}

async function main() {
    const args = process.argv.slice(2).filter(Boolean);
    if (args.length > 1 || args.some((a) => !ID.test(a))) throw new Error('Invalid cube upload device argument');
    if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('BLOB_READ_WRITE_TOKEN is required to upload cubes');
    if (!existsSync(cubeDir) || !statSync(cubeDir).isDirectory()) {
        console.log(`no cube directory ${cubeDir} — nothing to upload`);
        return;
    }
    const devices = devicesToUpload(cubeDir, readJson(planPath), args[0] ?? null);
    if (!devices.length) {
        console.log('no devices to upload');
        return;
    }
    console.log(`uploading cube sets for ${devices.length} device(s) from ${cubeDir}`);
    let ok = 0;
    for (const id of devices) if (await uploadDevice(id)) ok++;
    console.log(`done: ${ok}/${devices.length} cube set(s) uploaded`);
    if (!ok) throw new Error('no cube set was uploaded');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => { console.error(error); process.exitCode = 1; });
}
