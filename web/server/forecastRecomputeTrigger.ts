/**
 * Per-fix forecast recompute trigger.
 *
 * When the TTN webhook stores a packet with a GPS position for a flying
 * balloon, it asks GitHub to run .github/workflows/forecast-recompute.yml for
 * that device (`repository_dispatch`, event `new-fix`), which re-anchors the
 * stored forecast on the new fix from the cube set the last scheduled ingest
 * published — no NOAA download. This is strictly best-effort and off the
 * response path: the webhook has already answered TTN by the time the dispatch
 * is in flight (Vercel's `waitUntil` keeps the function alive for it), a missing
 * token disables it, and no failure here can change the webhook's response.
 *
 * Debounce: a balloon's packet typically arrives several times within seconds
 * (regional alias echoes, TTN retries, duplicate deliveries), and every one of
 * them would otherwise start a run that the next one cancels. The first notify
 * for a device dispatches at once; further notifies inside DEBOUNCE_MS are
 * folded into ONE trailing dispatch at the end of the window (so a genuinely
 * newer fix in the burst still gets its run). The map is per function instance
 * — Vercel may run several — but the workflow's per-device concurrency group
 * (cancel-in-progress) and the recompute's own skip rules (the stored forecast
 * already starts from the newest fix) make an occasional extra dispatch a
 * cheap no-op rather than a duplicate forecast.
 */
import { createServerSupabase } from './supabaseServer.js';

export const DISPATCH_EVENT = 'new-fix';
export const DEFAULT_REPO = 'Stratolink-hq/Stratolink';
export const DEBOUNCE_MS = 20_000;
const DISPATCH_TIMEOUT_MS = 5_000;
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const REPO = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

export type RecomputeTriggerOptions = {
  env?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  /** `devices.status = 'flying'` lookup; the default queries Supabase. */
  isFlying?: (deviceId: string) => Promise<boolean>;
  /** Timer used for the trailing dispatch (tests inject a capturing one). */
  schedule?: (fn: () => void, ms: number) => void;
  now?: () => number;
  debounceMs?: number;
  /** Keeps the serverless function alive until `promise` settles (Vercel `waitUntil`). */
  keepAlive?: (promise: Promise<unknown>) => void;
  log?: (message: string) => void;
};

/** Vercel's request context `waitUntil` (what `@vercel/functions` wraps); a
 *  no-op elsewhere, where the promise simply runs in the background. */
export function vercelWaitUntil(promise: Promise<unknown>): void {
  const ctx = (globalThis as Record<symbol, { get?: () => { waitUntil?: (p: Promise<unknown>) => void } | undefined } | undefined>)[
    Symbol.for('@vercel/request-context')
  ]?.get?.();
  ctx?.waitUntil?.(promise);
}

async function defaultIsFlying(deviceId: string): Promise<boolean> {
  const { data, error } = await createServerSupabase().from('devices').select('status').eq('device_id', deviceId).maybeSingle();
  if (error) throw new Error('Device registry unavailable');
  return data?.status === 'flying';
}

export function createRecomputeTrigger(options: RecomputeTriggerOptions = {}) {
  const env = options.env ?? process.env;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const isFlying = options.isFlying ?? defaultIsFlying;
  const schedule = options.schedule ?? ((fn, ms) => { setTimeout(fn, ms).unref?.(); });
  const now = options.now ?? Date.now;
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const keepAlive = options.keepAlive ?? vercelWaitUntil;
  const log = options.log ?? ((message: string) => console.warn(message));
  const state = new Map<string, { lastAt: number; pending: boolean }>();

  function config(): { token: string; repo: string } | null {
    const token = env.GITHUB_DISPATCH_TOKEN;
    if (!token) return null;
    const repo = env.GITHUB_DISPATCH_REPO || DEFAULT_REPO;
    if (!REPO.test(repo)) return null;
    return { token, repo };
  }

  /** One `repository_dispatch` call. Resolves true when GitHub accepted it (204). */
  async function dispatch(deviceId: string): Promise<boolean> {
    const cfg = config();
    if (!cfg) return false;
    const response = await fetchFn(`https://api.github.com/repos/${cfg.repo}/dispatches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'stratolink-ttn-webhook',
      },
      body: JSON.stringify({ event_type: DISPATCH_EVENT, client_payload: { device: deviceId } }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });
    if (response.status !== 204) {
      log(`forecast recompute dispatch for ${deviceId} rejected: HTTP ${response.status}`);
      return false;
    }
    return true;
  }

  async function run(deviceId: string): Promise<void> {
    try {
      if (!(await isFlying(deviceId))) return;
      await dispatch(deviceId);
    } catch (error) {
      log(`forecast recompute dispatch for ${deviceId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Called by the webhook after a GPS fix is stored. Never throws, never awaits. */
  function notify(deviceId: string): void {
    try {
      if (!config() || !ID.test(deviceId)) return;
      const t = now();
      const s = state.get(deviceId);
      if (s && t - s.lastAt < debounceMs) {
        if (s.pending) return;
        s.pending = true;
        const wait = debounceMs - (t - s.lastAt);
        keepAlive(new Promise<void>((resolve) => {
          schedule(() => {
            s.pending = false;
            s.lastAt = now();
            run(deviceId).finally(resolve);
          }, wait);
        }));
        return;
      }
      state.set(deviceId, { lastAt: t, pending: false });
      keepAlive(run(deviceId));
    } catch (error) {
      log(`forecast recompute trigger error for ${deviceId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { notify, dispatch, enabled: () => config() !== null };
}

export const recomputeTrigger = createRecomputeTrigger();
