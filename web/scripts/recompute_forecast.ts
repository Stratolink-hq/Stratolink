/**
 * Recompute prepare step — runs first in .github/workflows/forecast-recompute.yml
 * (dispatched by the TTN webhook for every stored GPS fix of a flying device,
 * see server/forecastRecomputeTrigger.ts).
 *
 * Decides whether re-anchoring ONE device's forecast on its newest fix can do
 * anything (rules in lib/wind/forecastRecompute.ts), and when it can, pulls the
 * device's cube set that the last scheduled ingest published to Blob
 * (`cubes/{device}/manifest.json` → `cubes/{device}/{set}/…`,
 * scripts/upload_cubes.mjs; only the files the manifest names, so a thinner
 * run never inherits an older run's members) into WIND_CUBE_DIR and writes
 * the plan + manifest files that `npm run forecast:compute -- <device>` then
 * consumes exactly as it does after a scheduled ingest. A skip is written to the
 * plan too, so the compute step reports it and exits clean. Nothing here touches
 * NOAA: the cubes are the scheduled run's, only the integration is redone.
 *
 * Usage:  npx tsx scripts/recompute_forecast.ts <deviceId> [--dry]
 *   --dry → decide and print, download nothing, write nothing
 * Env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY,
 *      BLOB_READ_WRITE_TOKEN (required: the cubes and the stored forecast live there),
 *      WIND_CUBE_DIR (default .windcube/cubes), FORECAST_PLAN, FORECAST_MANIFEST.
 */
import { get } from '@vercel/blob';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createServiceRoleClient } from '@/lib/supabase';
import { buildForecastInputForDevice } from '@/lib/wind/buildForecastInput';
import { isBlobStorageConfigured, readStoredForecast } from '@/lib/wind/forecastStorage';
import { emptyManifest, writeManifest, type ForecastManifest } from '@/lib/wind/forecastManifest';
import { planConfigFromEnv, storedForecastSummary, PLAN_VERSION, type ForecastPlan, type StoredForecastSummary } from '@/lib/wind/forecastPlan';
import { decideRecompute, type CubeSetSummary, type RecomputeDecision } from '@/lib/wind/forecastRecompute';

const CUBE_DIR = process.env.WIND_CUBE_DIR ?? join(process.cwd(), '.windcube', 'cubes');
const PLAN_PATH = process.env.FORECAST_PLAN ?? join(process.cwd(), '.windcube', 'plan.json');
const MANIFEST_PATH = process.env.FORECAST_MANIFEST ?? join(process.cwd(), '.windcube', 'manifest.json');

type DeviceRow = {
    device_id: string;
    status: string | null;
    connection_status: string | null;
    launched_at: string | null;
    launch_lat: number | null;
    launch_lon: number | null;
};

async function readDevice(id: string): Promise<DeviceRow | null> {
    const { data, error } = await createServiceRoleClient()
        .from('devices')
        .select('device_id, status, connection_status, launched_at, launch_lat, launch_lon')
        .eq('device_id', id)
        .maybeSingle();
    if (error) throw new Error(`devices query failed: ${error.message}`);
    return (data as DeviceRow | null) ?? null;
}

/** Header of a packed `.slwc` cube: `[uint32 LE len][JSON …]`. */
function cubeHeader(buf: Buffer): { t0Ms: number; stepMs: number; nGrids: number; generated_at?: string } {
    const len = buf.readUInt32LE(0);
    return JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
}

/** The set manifest scripts/upload_cubes.mjs writes last: which versioned set
 *  is current and what it holds. */
type CubeSetManifest = {
    version?: number;
    set?: string;
    cube_generated_at?: string | null;
    origin_utc?: string | null;
    forecast_cube?: { t0_utc: string; end_utc: string } | null;
    reconstruction_cube?: { t0_utc: string; end_utc: string } | null;
    members_expected?: Record<string, number>;
    files?: string[];
};

async function getBlob(pathname: string): Promise<Buffer | null> {
    const r = await get(pathname, { access: 'private', useCache: false });
    if (!r) return null;   // absent
    if (r.statusCode !== 200) throw new Error(`Blob get ${pathname} → ${r.statusCode}`);
    return Buffer.from(await new Response(r.stream).arrayBuffer());
}

async function readCubeSetManifest(id: string): Promise<CubeSetManifest | null> {
    const buf = await getBlob(`cubes/${encodeURIComponent(id)}/manifest.json`);
    if (!buf) return null;
    try {
        const m = JSON.parse(buf.toString('utf8')) as CubeSetManifest;
        return m && typeof m.set === 'string' && /^[A-Za-z0-9]+$/.test(m.set) && Array.isArray(m.files) ? m : null;
    } catch { return null; }
}

/** Pull the manifest's set onto disk (gunzipped, the ingest's own filenames)
 *  and summarise it from the forecast cube's header. Null when the set has no
 *  forecast cube. */
async function fetchCubeSet(id: string, manifest: CubeSetManifest, dry: boolean): Promise<CubeSetSummary | null> {
    const dir = `cubes/${encodeURIComponent(id)}/${manifest.set}/`;
    const safe = /^[A-Za-z0-9_.-]+\.(slwc|json)$/;
    const files = (manifest.files ?? []).filter((f) => safe.test(f) && f.startsWith(encodeURIComponent(id)));
    const fc = files.find((f) => f === `${encodeURIComponent(id)}-fc.slwc`);
    if (!fc) return null;
    const t0 = Date.now();
    if (!dry) mkdirSync(CUBE_DIR, { recursive: true });
    const fetchFile = async (name: string): Promise<Buffer> => {
        const buf = await getBlob(`${dir}${name}.gz`);
        if (!buf) throw new Error(`cube ${dir}${name}.gz named by the manifest is missing`);
        return gunzipSync(buf);
    };
    let bytes = 0;
    /* The forecast cube first (its header is the decision), then the rest a few at a time. */
    const fcBuf = await fetchFile(fc);
    const header = cubeHeader(fcBuf);
    bytes += fcBuf.length;
    if (!dry) writeFileSync(join(CUBE_DIR, fc), fcBuf);
    const queue = files.filter((f) => f !== fc);
    const worker = async () => {
        for (let f = queue.shift(); f; f = queue.shift()) {
            const buf = await fetchFile(f);
            bytes += buf.length;
            if (!dry) writeFileSync(join(CUBE_DIR, f), buf);
        }
    };
    if (!dry) await Promise.all(Array.from({ length: 6 }, worker));
    const members = files.filter((f) => /-[ma]\d+\.slwc$/.test(f)).length;
    console.log(
        `  ${id}: cube set ${manifest.set}, ${files.length} file(s) (${members} members), ${Math.round(bytes / 1024)} KB` +
        `${dry ? ' (dry: only the forecast cube read)' : ` → ${CUBE_DIR}`} in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
    );
    const reconEnd = manifest.reconstruction_cube?.end_utc ? Date.parse(manifest.reconstruction_cube.end_utc) : NaN;
    return {
        cube_generated_at: header.generated_at ?? manifest.cube_generated_at ?? null,
        t0Ms: header.t0Ms,
        tEndMs: header.t0Ms + Math.max(0, header.nGrids - 1) * header.stepMs,
        origin_fix_utc: manifest.origin_utc ?? null,
        recon_end_ms: Number.isFinite(reconEnd) ? reconEnd : null,
    };
}

function writePlanFiles(decision: RecomputeDecision, device: DeviceRow | null, nFixes: number, setManifest: CubeSetManifest | null, nowMs: number): void {
    const cfg = planConfigFromEnv();
    const plan: ForecastPlan = {
        version: PLAN_VERSION,
        generated_at: new Date(nowMs).toISOString(),
        config: { horizon_h: cfg.horizonH, dead_reckon_cap_h: cfg.deadReckonCapH, freeze_margin_h: cfg.freezeMarginH },
        requested_device: decision.device_id,
        force: false,
        devices: [{
            device_id: decision.device_id,
            action: decision.action,
            reason: `recompute: ${decision.reason}`,
            launched_at: device?.launched_at ?? null,
            origin_utc: decision.origin_utc,
            origin_age_h: decision.origin_utc ? Math.round(((nowMs - Date.parse(decision.origin_utc)) / 3_600_000) * 10) / 10 : null,
            n_fixes: nFixes,
            stored_generated_at: null,
        }],
    };
    mkdirSync(dirname(PLAN_PATH), { recursive: true });
    writeFileSync(PLAN_PATH, JSON.stringify(plan, null, 1));
    /* The manifest carries the member counts the scheduled ingest was configured
     * for, so a thin set is still stamped INCOMPLETE in the recomputed forecast. */
    const manifest: ForecastManifest = emptyManifest(plan.generated_at);
    const expected: Record<string, number> = setManifest?.members_expected ?? {};
    for (const src of ['gefs', 'aigefs']) {
        if (typeof expected[src] === 'number') {
            manifest.sources[src] = { members_expected: expected[src], devices: { [decision.device_id]: { expected: expected[src] } } };
        }
    }
    manifest.sources.recompute = {
        started_at: plan.generated_at,
        devices: { [decision.device_id]: { action: decision.action, reason: decision.reason, cube_generated_at: setManifest?.cube_generated_at ?? null } },
    };
    writeManifest(MANIFEST_PATH, manifest);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2).filter(Boolean);
    const dry = args.includes('--dry');
    const ids = args.filter((a) => a !== '--dry');
    if (ids.length !== 1 || ids[0].startsWith('-') || !/^[a-zA-Z0-9_-]{1,80}$/.test(ids[0])) {
        throw new Error('Invalid forecast device argument (exactly one device id is required)');
    }
    const id = ids[0];
    if (!isBlobStorageConfigured()) throw new Error('BLOB_READ_WRITE_TOKEN is required: the cube set and the stored forecast live in Blob');
    const nowMs = Date.now();

    const device = await readDevice(id);
    const connected = device?.connection_status === 'connected';
    let newestFixUtc: string | null = null;
    let nFixes = 0;
    let stored: StoredForecastSummary | null = null;
    let cubes: CubeSetSummary | null = null;
    let setManifest: CubeSetManifest | null = null;

    /* Cheap checks first; the cube download only when everything else says build. */
    if (device?.status === 'flying' && connected) {
        const input = await buildForecastInputForDevice(id);
        if (input) {
            const last = input.gpsFixes[input.gpsFixes.length - 1];
            const launchMs = device.launched_at ? Date.parse(device.launched_at) : NaN;
            const launchOnly = input.gpsFixes.length === 1 && last.lat === device.launch_lat && last.lon === device.launch_lon &&
                Date.parse(last.time_utc) === launchMs;
            nFixes = launchOnly ? 0 : input.gpsFixes.length;
            newestFixUtc = launchOnly ? null : last?.time_utc ?? null;
        }
        stored = storedForecastSummary(await readStoredForecast(id));
        const anyCubes = { cube_generated_at: null, t0Ms: -Infinity, tEndMs: Infinity, origin_fix_utc: null, recon_end_ms: null };
        const early = decideRecompute({ deviceId: id, status: device.status, connected, newestFixUtc, nFixes, stored, cubes: anyCubes }, nowMs);
        if (early.action === 'build') {
            setManifest = await readCubeSetManifest(id);
            if (setManifest) cubes = await fetchCubeSet(id, setManifest, dry);
        }
    }

    const decision = decideRecompute({ deviceId: id, status: device?.status ?? null, connected, newestFixUtc, nFixes, stored, cubes }, nowMs);
    console.log(`  ${id}: ${decision.action.toUpperCase()} — ${decision.reason}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `**${id}: ${decision.action}** — ${decision.reason}\n\n`);
    }
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `action=${decision.action}\n`);
    if (dry) {
        console.log('dry run — nothing written');
        return;
    }
    writePlanFiles(decision, device, nFixes, setManifest, nowMs);
    console.log(`wrote ${PLAN_PATH}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
