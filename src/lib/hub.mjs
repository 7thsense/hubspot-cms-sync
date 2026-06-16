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

/**
 * Make an authenticated JSON request against the HubSpot API.
 * Never throws on a non-2xx status — returns { ok, status, json } so callers
 * decide how to react (some endpoints, e.g. slug lookups, treat 404 as "none").
 * @param {{ key: string }} acct account object from account()
 * @param {string} method HTTP method
 * @param {string} path API path beginning with '/'
 * @param {*} [body] optional JSON body
 * @returns {Promise<{ ok: boolean, status: number, json: any }>}
 */
// Transient HubSpot failures — gateway 5xx (the 502/503/504 HTML error pages CloudFront
// returns under load) and 429 rate limits — are retried with exponential backoff so a
// single flaky response can't abort a whole push mid-stream. 4xx (real errors) are not
// retried. Network-level throws (ECONNRESET/timeouts) are retried too.
const HUB_MAX_ATTEMPTS = 5;
const isTransientStatus = (s) => s === 429 || (s >= 500 && s <= 599);

export async function hub(acct, method, path, body, opts = {}) {
  if (!acct || !acct.key) {
    throw new Error('hub() requires an account object with a key (from account()).');
  }
  const maxAttempts = opts.maxAttempts ?? HUB_MAX_ATTEMPTS;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let res;
    try {
      res = await fetch(API + path, {
        method,
        headers: {
          Authorization: `Bearer ${acct.key}`,
          'Content-Type': 'application/json',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      // Network error — retry with backoff, then rethrow on the final attempt.
      lastErr = e;
      if (attempt >= maxAttempts) throw e;
      await sleep(backoffMs(attempt, null));
      continue;
    }
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (isTransientStatus(res.status) && attempt < maxAttempts) {
      await sleep(backoffMs(attempt, res.headers.get('retry-after')));
      continue;
    }
    return { ok: res.ok, status: res.status, json };
  }
  // Exhausted retries on repeated network errors.
  throw lastErr;
}

// Exponential backoff with a Retry-After override (429s). attempt is 1-based.
function backoffMs(attempt, retryAfter) {
  const ra = Number.parseInt(retryAfter ?? '', 10);
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 30000);
  return Math.min(500 * 2 ** (attempt - 1), 8000);
}

/**
 * Follow v3 paging (paging.next.after), accumulating results[].
 * Throws with a clear message on any non-ok page.
 * @param {{ key: string }} acct account object
 * @param {string} path API path (query string allowed)
 * @returns {Promise<any[]>} concatenated results
 */
export async function getAll(acct, path) {
  const out = [];
  let after;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${path}${sep}limit=100${after ? `&after=${after}` : ''}`;
    const { ok, status, json } = await hub(acct, 'GET', url);
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
