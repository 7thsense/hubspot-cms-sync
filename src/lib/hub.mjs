// sync/lib/hub.mjs — account + HTTP layer for HubSpot bidirectional sync.
//
// The account/HTTP plumbing shared by every adapter and orchestrator. Pure,
// importable, unit-testable: account resolution and paging accumulation do not
// touch the network (paging is driven through an injectable hub function), and
// slug matching is a pure helper over a fetched list.
//
// Accounts: sync/accounts.json maps name -> { portalId, label }.
// Keys: per-portal service keys (Bearer) at $HUBSPOT_KEY_DIR/<portalId>.key
//       (default ~/.hubspot/<portalId>.key). Never committed.
//
// Production (portalId 529456) is READ-ONLY. This module provides NO default
// that writes to prod — callers pass an explicit account object every time.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfigSyncFallback } from '../config.mjs';

const API = 'https://api.hubapi.com';

const __dirname = dirname(fileURLToPath(import.meta.url));

function fallbackConfig() {
  return loadConfigSyncFallback();
}

function keyDir(cfg = fallbackConfig()) {
  return cfg.keyDir || process.env[cfg.keyDirEnv || 'HUBSPOT_KEY_DIR'] || join(homedir(), '.hubspot');
}

/**
 * Load and parse sync/accounts.json.
 * @returns {object} parsed account registry (name -> { portalId, label })
 */
export function loadAccounts(cfg = fallbackConfig()) {
  const accountsPath = cfg.accountsPath || join(cfg.root || process.cwd(), cfg.accountsFile || 'sync/accounts.json');
  let text;
  try {
    text = readFileSync(accountsPath, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read accounts file at ${accountsPath}: ${e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON in ${accountsPath}: ${e.message}`);
  }
}

/**
 * Resolve an account by name to { name, portalId, key }.
 * Reads the per-portal service key from $HUBSPOT_KEY_DIR/<portalId>.key.
 * @param {string} name account name as keyed in accounts.json
 * @returns {{ name: string, portalId: string, key: string }}
 */
export function account(name, cfg = fallbackConfig()) {
  const accounts = loadAccounts(cfg);
  const entry = accounts[name];
  if (!entry || typeof entry !== 'object' || !entry.portalId) {
    const known = Object.keys(accounts)
      .filter((k) => !k.startsWith('_'))
      .join(', ');
    throw new Error(`Unknown account "${name}". Known accounts: ${known || '(none)'}`);
  }
  const portalId = String(entry.portalId);
  const dir = keyDir(cfg);
  const keyFile = join(dir, `${portalId}.key`);
  if (!existsSync(keyFile)) {
    throw new Error(
      `No key for account "${name}" (portal ${portalId}) at ${keyFile}\n` +
        `  Create it: printf '%s' 'pat-naX-...' > ${keyFile} && chmod 600 ${keyFile}\n` +
        `  (override the directory with $HUBSPOT_KEY_DIR)`
    );
  }
  const key = readFileSync(keyFile, 'utf8').trim();
  if (!key) {
    throw new Error(`Key file ${keyFile} for account "${name}" is empty.`);
  }
  return { name, portalId, key };
}

// Transient HubSpot failures — gateway 5xx (the 502/503/504 HTML error pages CloudFront
// returns under load, and the odd one-off 500) and 429 rate limits — are retried per
// request with bounded exponential backoff, so one flaky response can't abort a whole
// push or republish mid-stream. 4xx (real errors) are never retried.
//
// Retrying is only safe when repeating the request cannot duplicate its effect, because
// a 5xx or a dropped connection does not prove the server did nothing:
//   - 429 is always retried: HubSpot rejected the request before processing it.
//   - 5xx and network throws are retried only for idempotent-safe requests
//     (isRetrySafe): reads, PUT/PATCH/DELETE (set-to-value / remove), and the POST
//     actions that converge on one end state (schedule, draft/push-live, batch reads,
//     search). A POST create is NOT retried — a 500 that actually created the object
//     would otherwise be repeated into a duplicate page, post, email or redirect.
export const HUB_MAX_ATTEMPTS = 5;
const RETRY_AFTER_CAP_MS = 30_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;

export const isTransientStatus = (s) => s === 429 || (s >= 500 && s <= 599);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE']);
const SAFE_POST_PATHS = [/\/schedule$/, /\/draft\/push-live$/, /\/batch\/read$/, /\/search$/];

/**
 * Pure: may this request be repeated after a 5xx / network failure without risking a
 * duplicate side effect? POST is safe only for the allowlisted converge-to-one-state
 * actions; every other POST is treated as a create.
 * @param {string} method HTTP method
 * @param {string} path API path (query string ignored)
 * @returns {boolean}
 */
export function isRetrySafe(method, path) {
  const m = String(method || 'GET').toUpperCase();
  if (SAFE_METHODS.has(m)) return true;
  if (m !== 'POST') return false;
  const bare = String(path || '').split('?')[0];
  return SAFE_POST_PATHS.some((re) => re.test(bare));
}

/**
 * Pure: delay before retry number `attempt` (1-based). A Retry-After header (delta
 * seconds or an HTTP-date) wins, capped at 30s; otherwise 0.5s, 1s, 2s, 4s, 8s (cap).
 * @param {number} attempt the attempt that just failed (1-based)
 * @param {string|null} [retryAfter] Retry-After header value
 * @param {number} [now] epoch ms, for HTTP-date resolution
 * @returns {number} milliseconds
 */
export function retryDelayMs(attempt, retryAfter, now = Date.now()) {
  if (retryAfter != null && String(retryAfter).trim() !== '') {
    const raw = String(retryAfter).trim();
    let ms = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - now;
    if (Number.isFinite(ms)) return Math.min(Math.max(ms, 0), RETRY_AFTER_CAP_MS);
  }
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const defaultOnRetry = ({ label, attempt, maxAttempts, status, error, delayMs }) => {
  const why = error ? `network error (${error.code || error.message})` : `HTTP ${status}`;
  process.stderr.write(`hub: ${label} -> ${why}; retry ${attempt + 1}/${maxAttempts} in ${delayMs}ms\n`);
};

/**
 * fetch() with per-request retry of transient failures (see the policy above).
 * Returns the final Response — a still-transient status on the last attempt is
 * returned, not thrown, so callers keep their own status handling. A network throw is
 * rethrown once attempts are exhausted (or immediately when the request is not
 * retry-safe).
 * @param {string} url
 * @param {object|(() => object)} init fetch init, or a factory for single-use bodies
 *   (FormData) that must be rebuilt per attempt
 * @param {{ retrySafe?: boolean, maxAttempts?: number, sleep?: Function,
 *   fetchImpl?: Function, onRetry?: Function, label?: string }} [opts]
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, init = {}, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? HUB_MAX_ATTEMPTS;
  const sleep = opts.sleep ?? defaultSleep;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const onRetry = opts.onRetry ?? defaultOnRetry;
  const makeInit = typeof init === 'function' ? init : () => init;
  let attemptInit = makeInit();
  const method = String(attemptInit.method || 'GET').toUpperCase();
  const retrySafe = opts.retrySafe ?? isRetrySafe(method, new URL(url).pathname);
  const label = opts.label ?? `${method} ${new URL(url).pathname}`;

  for (let attempt = 1; ; attempt += 1) {
    let res;
    try {
      if (attempt > 1) attemptInit = makeInit();
      res = await fetchImpl(url, attemptInit);
    } catch (error) {
      if (!retrySafe || attempt >= maxAttempts) throw error;
      const delayMs = retryDelayMs(attempt, null);
      onRetry({ label, attempt, maxAttempts, error, delayMs });
      await sleep(delayMs);
      continue;
    }
    const retryable = res.status === 429 || (retrySafe && isTransientStatus(res.status));
    if (!retryable || attempt >= maxAttempts) return res;
    const delayMs = retryDelayMs(attempt, res.headers?.get?.('retry-after'));
    onRetry({ label, attempt, maxAttempts, status: res.status, delayMs });
    // Release the discarded response's connection before retrying.
    await res.body?.cancel?.().catch(() => {});
    await sleep(delayMs);
  }
}

/**
 * Make an authenticated JSON request against the HubSpot API.
 * Never throws on a non-2xx status — returns { ok, status, json } so callers
 * decide how to react (some endpoints, e.g. slug lookups, treat 404 as "none").
 * Transient failures are retried per fetchWithRetry; opts passes through to it.
 * @param {{ key: string }} acct account object from account()
 * @param {string} method HTTP method
 * @param {string} path API path beginning with '/'
 * @param {*} [body] optional JSON body
 * @param {object} [opts] fetchWithRetry options (maxAttempts, sleep, retrySafe, …)
 * @returns {Promise<{ ok: boolean, status: number, json: any }>}
 */
export async function hub(acct, method, path, body, opts = {}) {
  if (!acct || !acct.key) {
    throw new Error('hub() requires an account object with a key (from account()).');
  }
  const res = await fetchWithRetry(
    API + path,
    {
      method,
      headers: {
        Authorization: `Bearer ${acct.key}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
    { retrySafe: isRetrySafe(method, path), label: `${method} ${path.split('?')[0]}`, ...opts },
  );
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, json };
}

/**
 * Follow v3 paging (paging.next.after), accumulating results[].
 * Throws with a clear message on any non-ok page.
 * @param {{ key: string }} acct account object
 * @param {string} path API path (query string allowed)
 * @param {object} [opts] hub()/fetchWithRetry options
 * @returns {Promise<any[]>} concatenated results
 */
export async function getAll(acct, path, opts = {}) {
  const out = [];
  let after;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${path}${sep}limit=100${after ? `&after=${after}` : ''}`;
    const { ok, status, json } = await hub(acct, 'GET', url, undefined, opts);
    if (!ok) {
      const msg = json?.message || json?.category || JSON.stringify(json).slice(0, 200);
      throw new Error(`GET ${url} -> ${status}: ${msg}`);
    }
    out.push(...(json.results || []));
    after = json.paging?.next?.after;
  } while (after);
  return out;
}

/**
 * Pure: pick the page id whose slug matches `slug` from a v3 page list.
 * '' (empty string) addresses the homepage. Exposed for unit testing.
 * @param {any[]} pages array of page objects ({ id, slug })
 * @param {string} slug normalized slug ('' = homepage)
 * @returns {string|null} matched page id or null
 */
export function matchPageSlug(pages, slug) {
  const want = slug == null ? '' : String(slug);
  for (const p of pages) {
    if (String(p.slug ?? '') === want) return String(p.id);
  }
  return null;
}

/**
 * Resolve a CMS site page id by slug ('' = homepage). Read call; returns null
 * when no page matches.
 * @param {{ key: string }} acct account object
 * @param {string} slug normalized slug
 * @returns {Promise<string|null>}
 */
export async function resolvePageBySlug(acct, slug) {
  const pages = await getAll(acct, '/cms/v3/pages/site-pages');
  return matchPageSlug(pages, slug);
}

/**
 * Pure: pick the legacy blog contentGroupId whose slug matches from the v2
 * /content/api/v2/blogs `objects` array. Exposed for unit testing.
 * @param {any[]} blogs array of blog containers ({ id, slug })
 * @param {string} slug normalized blog slug
 * @returns {string|null} matched contentGroupId or null
 */
export function matchBlogSlug(blogs, slug) {
  const want = slug == null ? '' : String(slug);
  for (const b of blogs) {
    if (String(b.slug ?? '') === want) return String(b.id);
  }
  return null;
}

/**
 * Resolve a blog container (contentGroupId) by slug via the legacy
 * /content/api/v2/blogs endpoint. Returns null when no blog matches.
 * Matching is by slug — never objects[0] — so a stale "Old" blog cannot win.
 * @param {{ key: string }} acct account object
 * @param {string} slug normalized blog slug
 * @returns {Promise<string|null>}
 */
export async function resolveBlogBySlug(acct, slug) {
  const { ok, status, json } = await hub(acct, 'GET', '/content/api/v2/blogs?limit=100');
  if (!ok) {
    const msg = json?.message || json?.category || JSON.stringify(json).slice(0, 200);
    throw new Error(`GET /content/api/v2/blogs -> ${status}: ${msg}`);
  }
  return matchBlogSlug(json.objects || [], slug);
}
