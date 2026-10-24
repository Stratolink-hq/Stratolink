import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecomputeTrigger, DEBOUNCE_MS, DISPATCH_EVENT, vercelWaitUntil } from './forecastRecomputeTrigger.ts';

const env = { GITHUB_DISPATCH_TOKEN: 'ghp_unit_test_token' };

/** A trigger whose collaborators are all captured: fetch calls, scheduled
 *  timers (run by hand), kept-alive promises, a controllable clock. */
function harness({ env: e = env, flying = true, status = 204, fetchImpl = null } = {}) {
  const calls = [], timers = [], kept = [], logs = [];
  let t = 1_000_000;
  const trigger = createRecomputeTrigger({
    env: e,
    fetch: fetchImpl ?? (async (url, init) => { calls.push({ url, init }); return { status }; }),
    isFlying: async () => flying,
    schedule: (fn, ms) => timers.push({ fn, ms }),
    now: () => t,
    keepAlive: (p) => kept.push(p),
    log: (m) => logs.push(m),
  });
  const settle = () => Promise.all(kept);
  return { trigger, calls, timers, kept, logs, settle, advance: (ms) => { t += ms; } };
}

test('a stored fix for a flying device dispatches one repository_dispatch off the response path', async () => {
  const h = harness();
  assert.equal(h.trigger.enabled(), true);
  h.trigger.notify('stratolink-1');
  assert.equal(h.calls.length, 0, 'nothing awaited synchronously');
  assert.equal(h.kept.length, 1, 'the dispatch is handed to waitUntil');
  await h.settle();
  assert.equal(h.calls.length, 1);
  const { url, init } = h.calls[0];
  assert.equal(url, 'https://api.github.com/repos/Stratolink-hq/Stratolink/dispatches');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, 'Bearer ghp_unit_test_token');
  assert.equal(init.headers['x-github-api-version'], '2022-11-28');
  assert.deepEqual(JSON.parse(init.body), { event_type: DISPATCH_EVENT, client_payload: { device: 'stratolink-1' } });
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(h.logs, []);
});

test('without a token nothing is dispatched and nothing is looked up', async () => {
  const h = harness({ env: {} });
  assert.equal(h.trigger.enabled(), false);
  h.trigger.notify('stratolink-1');
  await h.settle();
  assert.equal(h.calls.length, 0);
  assert.equal(h.kept.length, 0);
  assert.equal(await h.trigger.dispatch('stratolink-1'), false);
  /* A malformed repo override disables it too (never a URL built from junk). */
  const bad = harness({ env: { ...env, GITHUB_DISPATCH_REPO: '../evil' } });
  bad.trigger.notify('stratolink-1');
  await bad.settle();
  assert.equal(bad.calls.length, 0);
});

test('a device that is not flying, or an invalid id, never reaches GitHub', async () => {
  const h = harness({ flying: false });
  h.trigger.notify('stratolink-2');
  await h.settle();
  assert.equal(h.calls.length, 0);
  const bad = harness();
  bad.trigger.notify('../secret');
  bad.trigger.notify('');
  await bad.settle();
  assert.equal(bad.calls.length, 0);
  assert.equal(bad.kept.length, 0);
});

test('a burst of packets yields one immediate dispatch plus one trailing one at the end of the window', async () => {
  const h = harness();
  h.trigger.notify('stratolink-1');
  h.advance(1_000);
  h.trigger.notify('stratolink-1');   // alias echo
  h.advance(1_000);
  h.trigger.notify('stratolink-1');   // TTN retry
  await Promise.all(h.kept.slice(0, 1));
  assert.equal(h.calls.length, 1, 'only the first packet dispatched so far');
  assert.equal(h.timers.length, 1, 'one trailing timer for the whole burst');
  assert.equal(h.timers[0].ms, DEBOUNCE_MS - 1_000, 'scheduled by the first echo, for the end of the window');
  assert.equal(h.kept.length, 2, 'the trailing dispatch is kept alive too');
  /* The window ends: the trailing dispatch fires once. */
  h.advance(DEBOUNCE_MS);
  h.timers[0].fn();
  await h.settle();
  assert.equal(h.calls.length, 2);
  /* A packet well after the window dispatches immediately again. */
  h.advance(DEBOUNCE_MS + 1);
  h.trigger.notify('stratolink-1');
  await h.settle();
  assert.equal(h.calls.length, 3);
  assert.equal(h.timers.length, 1);
  /* Devices are debounced independently. */
  h.trigger.notify('stratolink-3');
  await h.settle();
  assert.equal(h.calls.length, 4);
});

test('GitHub errors and network failures are logged, never thrown', async () => {
  const rejected = harness({ status: 401 });
  rejected.trigger.notify('stratolink-1');
  await rejected.settle();
  assert.equal(rejected.calls.length, 1);
  assert.match(rejected.logs[0], /rejected: HTTP 401/);

  const down = harness({ fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  down.trigger.notify('stratolink-1');
  await down.settle();
  assert.match(down.logs[0], /failed: ECONNRESET/);

  const registry = createRecomputeTrigger({ env, fetch: async () => ({ status: 204 }), isFlying: async () => { throw new Error('db down'); },
    keepAlive: (p) => registry.kept.push(p), log: (m) => registry.logs.push(m) });
  registry.kept = []; registry.logs = [];
  registry.notify('stratolink-1');
  await Promise.all(registry.kept);
  assert.match(registry.logs[0], /failed: db down/);
});

test('waitUntil shim uses the Vercel request context when present and is a no-op otherwise', () => {
  const key = Symbol.for('@vercel/request-context');
  assert.doesNotThrow(() => vercelWaitUntil(Promise.resolve()));
  const seen = [];
  globalThis[key] = { get: () => ({ waitUntil: (p) => seen.push(p) }) };
  try {
    const p = Promise.resolve();
    vercelWaitUntil(p);
    assert.deepEqual(seen, [p]);
  } finally { delete globalThis[key]; }
});
