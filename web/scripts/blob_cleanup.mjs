// List (and, with --apply, delete) stale objects in the private forecast Blob
// store: cube sets under `cubes/` that are older than CUBE_MAX_AGE_DAYS (the
// ingest overwrites a flying balloon's set in place four times a day, so an old
// set belongs to a balloon that is no longer built — landed, lost, frozen) and
// `forecasts/*.lock.json` from the retired on-demand compute path. Everything
// else — forecasts/{device}.json and the hindcasts/ caches — is live and never
// touched. The scheduled worker runs this with --apply after each ingest.
//
//   node --env-file=.env.local scripts/blob_cleanup.mjs           # list only (default)
//   node --env-file=.env.local scripts/blob_cleanup.mjs --apply   # delete the listed objects
//
// Env: BLOB_READ_WRITE_TOKEN. Without --apply nothing is modified.
import { del, list } from '@vercel/blob';

const APPLY = process.argv.includes('--apply');
const unknown = process.argv.slice(2).filter((arg) => arg !== '--apply');
if (unknown.length) {
    console.error(`unknown argument(s): ${unknown.join(' ')}\nusage: node --env-file=.env.local scripts/blob_cleanup.mjs [--apply]`);
    process.exit(2);
}
if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('BLOB_READ_WRITE_TOKEN is not set (try: node --env-file=.env.local scripts/blob_cleanup.mjs)');
    process.exit(2);
}

/** Every blob under a prefix (the API pages at 1000). */
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

/** Cube sets older than this are purged: the recompute tier only ever reads a
 *  set written by the latest scheduled ingest (≤ 6 h old), so two days is ample
 *  slack for a paused schedule while still clearing landed balloons' sets. */
const CUBE_MAX_AGE_DAYS = 2;
const now = Date.now();
const STALE = [
    { label: `cubes/* older than ${CUBE_MAX_AGE_DAYS} days`, prefix: 'cubes/',
      keep: (b) => now - new Date(b.uploadedAt).getTime() < CUBE_MAX_AGE_DAYS * 86_400_000 },
    { label: 'forecasts/*.lock.json (retired on-demand compute locks)', prefix: 'forecasts/', keep: (b) => !b.pathname.endsWith('.lock.json') },
];

const kb = (bytes) => `${(bytes / 1024).toFixed(1).padStart(9)} KB`;
const stale = [];
for (const group of STALE) {
    const blobs = (await listAll(group.prefix)).filter((b) => !group.keep(b)).sort((a, b) => a.pathname.localeCompare(b.pathname));
    const total = blobs.reduce((sum, b) => sum + b.size, 0);
    console.log(`\n${group.label}: ${blobs.length} object(s), ${kb(total)}`);
    for (const b of blobs) console.log(`  ${kb(b.size)}  ${new Date(b.uploadedAt).toISOString().slice(0, 10)}  ${b.pathname}`);
    stale.push(...blobs);
}
const totalBytes = stale.reduce((sum, b) => sum + b.size, 0);
console.log(`\ntotal: ${stale.length} stale object(s), ${kb(totalBytes)}`);

if (!stale.length) process.exit(0);
if (!APPLY) {
    console.log('\nlist mode — nothing deleted. Re-run with --apply to delete the objects above.');
    process.exit(0);
}
/* del() takes URLs or pathnames; batch so one request carries many objects. */
for (let i = 0; i < stale.length; i += 100) {
    const batch = stale.slice(i, i + 100);
    await del(batch.map((b) => b.url));
    console.log(`deleted ${Math.min(i + 100, stale.length)}/${stale.length}`);
}
console.log('done');
