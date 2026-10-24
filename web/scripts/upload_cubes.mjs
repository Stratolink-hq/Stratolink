#!/usr/bin/env node
/**
 * Cube upload — the last ingest step of .github/workflows/gfs-ingest.yml.
 *
 * Publishes the cubes the ingest just wrote to WIND_CUBE_DIR (the GFS forecast
 * tube `{device}-fc.slwc`, the reconstruction cube `{device}.slwc` and every
 * GEFS / AIGEFS member `{device}-mNN.slwc` / `{device}-aNN.slwc`) to the private
 * Blob store as one VERSIONED set, `cubes/{device}/{set}/{file}.gz` (`set` =
 * the ingest's build time), then writes `cubes/{device}/manifest.json` naming
 * that set and its files (build time, what the cubes cover, member counts).
 * The recompute tier (.github/workflows/forecast-recompute.yml →
 * scripts/recompute_forecast.ts) reads the manifest and pulls exactly the files
 * it names back onto a runner to re-anchor the forecast on each new GPS fix
 * without touching NOAA. ~40 KB per member, ~3 MB per device per run.
 *
 * Why versioned + manifest-last: a run that built fewer members (an ensemble
 * step killed at its timeout) must not leave the previous run's extra members
 * beside its own — the compute lists members from disk, so an in-place
 * overwrite would silently mix two runs' cubes and hide the INCOMPLETE stamp.
 * A reader never sees a half-written set either: the manifest only points at a
 * set once every file of it is up. After the manifest the previous set is kept
 * (a recompute may be mid-download) and older ones are deleted;
 * scripts/blob_cleanup.mjs also purges anything older than two days (a landed
 * balloon's sets and manifest).
 *
 * Which devices: the plan (FORECAST_PLAN) devices marked `build`, else every
 * device with a forecast cube in the directory (local runs).
 *
 *   node scripts/upload_cubes.mjs [device]        (npm run forecast:upload-cubes)
 * Env: BLOB_READ_WRITE_TOKEN, WIND_CUBE_DIR (default .windcube/cubes),
 *      FORECAST_PLAN, FORECAST_MANIFEST (member expectations for the manifest).
 */
import { del, list, put } from '@vercel/blob';
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

/** The set id a cube build gets: its forecast cube's `generated_at` compacted
 *  to `YYYYMMDDTHHMMSSZ` (sorts chronologically; safe as a key segment). */
export function cubeSetId(header, now = new Date()) {
    const ms = Date.parse(header?.generated_at ?? '');
    const d = Number.isFinite(ms) ? new Date(ms) : now;
    return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
/** Blob key of one cube file inside a device's versioned set. */
export function cubeBlobPath(deviceId, setId, fileName) {
    return `cubes/${encodeURIComponent(deviceId)}/${setId}/${fileName}.gz`;
}
export function cubeManifestPath(deviceId) {
    return `cubes/${encodeURIComponent(deviceId)}/manifest.json`;
}
/** Set ids under a device's prefix, newest first, from the listed object keys. */
export function setIdsFromKeys(deviceId, pathnames) {
    const prefix = `cubes/${encodeURIComponent(deviceId)}/`;
    const ids = new Set();
    for (const key of pathnames) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash > 0) ids.add(rest.slice(0, slash));
    }
    return [...ids].sort().reverse();
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

const span = (h) => (h
    ? { t0_utc: new Date(h.t0Ms).toISOString(),
        end_utc: new Date(h.t0Ms + Math.max(0, (h.nGrids ?? 0) - 1) * (h.stepMs ?? HOUR_MS)).toISOString(),
        step_h: (h.stepMs ?? HOUR_MS) / HOUR_MS, n_grids: h.nGrids ?? 0, level_hpa: h.levelHpa ?? null }
    : null);

/** The per-device manifest: which set is current, what it covers and holds.
 *  `header` is the forecast cube's `.slwc` header, `reconHeader` the
 *  reconstruction cube's (null for a single-fix device), `files` the uploaded
 *  names (without `.gz`), `planDevice` the plan step's record for the device
 *  (its `origin_utc` = the fix the cubes were laid out from). */
export function buildCubeManifest({ deviceId, setId, header, reconHeader = null, files, ingest, planDevice = null, planGeneratedAt, now = new Date() }) {
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
    return {
        version: CUBE_SET_VERSION,
        device_id: deviceId,
        set: setId,
        uploaded_at: now.toISOString(),
        /* The ingest's own stamp — what the plan step compares cube freshness by. */
        cube_generated_at: header?.generated_at ?? null,
        latest_cycle_utc: header?.latest_cycle_utc ?? null,
        plan_generated_at: planGeneratedAt ?? null,
        /* The fix the tubes were laid out from: a recompute re-anchors only on
         * fixes within a few hours of it (lib/wind/forecastRecompute.ts). */
        origin_utc: planDevice?.origin_utc ?? null,
        forecast_cube: span(header),
        reconstruction_cube: span(reconHeader),
        members,
        members_expected: expected,
        files,
    };
}

/** Every object under a prefix (the API pages at 1000). */
async function listAll(prefix) {
    const blobs = [];
    let cursor;
    do {
        const page = await list({ prefix, cursor, limit: 1000 });
        blobs.push(...page.blobs);
        cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return blobs;
}

/** Delete every set of the device except `keep` (the new set and the one
 *  before it, which a recompute may still be downloading). */
async function pruneSets(deviceId, keep) {
    const prefix = `cubes/${encodeURIComponent(deviceId)}/`;
    const blobs = await listAll(prefix);
    const stale = blobs.filter((b) => {
        const rest = b.pathname.slice(prefix.length);
        const slash = rest.indexOf('/');
        return slash > 0 && !keep.includes(rest.slice(0, slash));
    });
    for (let i = 0; i < stale.length; i += 100) await del(stale.slice(i, i + 100).map((b) => b.url));
    return { deleted: stale.length, sets: setIdsFromKeys(deviceId, blobs.map((b) => b.pathname)) };
}

async function uploadDevice(deviceId) {
    const files = cubeFilesFor(cubeDir, deviceId);
    const fc = files.find((f) => /-fc\.slwc$/.test(f));
    if (!fc) {
        console.log(`  ${deviceId}: no forecast cube in ${cubeDir} — nothing to upload`);
        return false;
    }
    const header = readCubeHeader(readFileSync(join(cubeDir, fc)));
    const recon = files.find((f) => f === `${deviceId}.slwc`);
    const reconHeader = recon ? readCubeHeader(readFileSync(join(cubeDir, recon))) : null;
    const setId = cubeSetId(header);
    let rawBytes = 0, gzBytes = 0;
    const t0 = Date.now();
    /* A few at a time: dozens of 40 KB members, one HTTP round-trip each. */
    const queue = [...files];
    const worker = async () => {
        for (let f = queue.shift(); f; f = queue.shift()) {
            const raw = readFileSync(join(cubeDir, f));
            const gz = gzipSync(raw, { level: 6 });
            rawBytes += raw.length; gzBytes += gz.length;
            await put(cubeBlobPath(deviceId, setId, f), gz, {
                access: 'private', addRandomSuffix: false, contentType: 'application/gzip', allowOverwrite: true,
            });
        }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    const plan = readJson(planPath);
    const manifest = buildCubeManifest({
        deviceId, setId, header, reconHeader, files, ingest: readJson(manifestPath),
        planDevice: plan?.devices?.find((d) => d.device_id === deviceId) ?? null, planGeneratedAt: plan?.generated_at,
    });
    await put(cubeManifestPath(deviceId), JSON.stringify(manifest), {
        access: 'private', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true,
    });
    const fcs = manifest.forecast_cube;
    console.log(
        `  ${deviceId}: set ${setId}, ${files.length} cube(s), ${Math.round(rawBytes / 1024)} KB → ${Math.round(gzBytes / 1024)} KB gz` +
        ` in ${((Date.now() - t0) / 1000).toFixed(1)} s | members gefs ${manifest.members.gefs}, aigefs ${manifest.members.aigefs}` +
        ` | origin fix ${manifest.origin_utc ?? '?'} | forecast cube ${fcs?.t0_utc ?? '?'} → ${fcs?.end_utc ?? '?'}`,
    );
    /* Keep this set and the previous one; drop anything older. */
    const existing = setIdsFromKeys(deviceId, (await listAll(`cubes/${encodeURIComponent(deviceId)}/`)).map((b) => b.pathname));
    const previous = existing.find((id) => id !== setId);
    const pruned = await pruneSets(deviceId, previous ? [setId, previous] : [setId]);
    if (pruned.deleted) console.log(`  ${deviceId}: pruned ${pruned.deleted} object(s) of older sets (kept ${setId}${previous ? `, ${previous}` : ''})`);
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
