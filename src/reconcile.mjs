// src/reconcile.mjs — READ-ONLY cross-account content reconciliation.
//
// For every content SURFACE and every account, inventory the account's items and
// classify each against the git canonical tree:
//   - synced     : present in git AND on the account (the expected state)
//   - orphan     : LIVE on the account but ABSENT from git — content the migration
//                  left behind (decide: rebuild / redirect / intentionally drop)
//   - missing    : present in git but NOT on the account — would be created by push
// Non-live account items (draft / A/B variant / archived) are counted, not listed —
// they are usually intentional exclusions, not orphans.
//
// This NEVER writes. It surfaces a report for the operator to resolve; it must not
// auto-migrate an orphan nor auto-delete one (especially on read-only prod, where an
// orphan is a pull-into-git candidate). Deep field-level CONFLICT diffing (same key,
// different content) is a follow-up; v1 reports orphan/missing/synced.
//
// PURE core: classifySurface() is a pure function over {gitKeys, accountItems}, so it
// unit-tests with fixtures and no network. The IO (account fetch, git read) is thin.

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { account as realAccount, getAll as realGetAll, hub as realHub } from './lib/hub.mjs';
import { loadPages, loadPosts } from './lib/content-view.mjs';
import { readRedirectSpecs } from './redirects.mjs';

// A page is "live" (a real published page, not draft/A-B/archived junk) when its
// currentState is a PUBLISHED form and it is neither archived nor an A/B variant.
function isLivePage(p) {
  const st = String(p.currentState ?? p.state ?? '');
  if (p.archived || p.abTestId) return false;
  if (st === 'LOSER_AB_VARIANT' || st === 'DRAFT_AB' || st === 'AB') return false;
  return /PUBLISHED/.test(st);
}

// Redirect sources mix absolute URLs (prod: http://www.theseventhsense.com/team) and
// bare paths (git/dev: /team). Compare on the PATH so a path-based redirect present on
// any source host counts as synced; strip scheme+host, keep a leading slash.
export function redirectPath(s) {
  const str = String(s ?? '');
  const m = /^https?:\/\/[^/]+(\/.*)?$/i.exec(str);
  return m ? (m[1] || '/') : str;
}

// ---------------------------------------------------------------------------
// Surface definitions. Each declares how to fetch the account's items, which are
// "live" (worth flagging as orphans), the canonical key, and a compact label.
// ---------------------------------------------------------------------------
export const SURFACES = [
  {
    key: 'site-pages',
    fetch: (acct, { getAll }) => getAll(acct, '/cms/v3/pages/site-pages'),
    live: isLivePage,
    keyOf: (p) => String(p.slug ?? ''),
    label: (p) => ({ key: String(p.slug ?? ''), state: String(p.currentState ?? p.state ?? ''), url: p.url ?? '', id: String(p.id ?? '') }),
  },
  {
    key: 'landing-pages',
    fetch: (acct, { getAll }) => getAll(acct, '/cms/v3/pages/landing-pages'),
    live: isLivePage,
    keyOf: (p) => String(p.slug ?? ''),
    label: (p) => ({ key: String(p.slug ?? ''), state: String(p.currentState ?? p.state ?? ''), url: p.url ?? '', id: String(p.id ?? '') }),
  },
  {
    key: 'blog-posts',
    fetch: (acct, { getAll }) => getAll(acct, '/cms/v3/blogs/posts'),
    live: (p) => String(p.state ?? '') === 'PUBLISHED',
    keyOf: (p) => String(p.slug ?? ''),
    label: (p) => ({ key: String(p.slug ?? ''), state: String(p.state ?? ''), url: p.url ?? '', id: String(p.id ?? '') }),
  },
  {
    key: 'blog-authors',
    fetch: (acct, { getAll }) => getAll(acct, '/cms/v3/blogs/authors'),
    live: () => true,
    keyOf: (a) => String(a.slug ?? ''),
    label: (a) => ({ key: String(a.slug ?? ''), state: '', url: '', id: String(a.id ?? '') }),
  },
  {
    key: 'blog-tags',
    fetch: (acct, { getAll }) => getAll(acct, '/cms/v3/blogs/tags'),
    live: () => true,
    keyOf: (t) => String(t.slug ?? ''),
    label: (t) => ({ key: String(t.slug ?? ''), state: '', url: '', id: String(t.id ?? '') }),
  },
  {
    key: 'url-redirects',
    fetch: (acct, { getAll }) => getAll(acct, '/cms/v3/url-redirects'),
    live: () => true,
    keyOf: (r) => redirectPath(r.routePrefix ?? r.url ?? ''),
    label: (r) => ({ key: redirectPath(r.routePrefix ?? r.url ?? ''), state: '', url: String(r.destination ?? ''), id: String(r.id ?? '') }),
  },
  {
    key: 'menus',
    // The advanced-menus endpoint is the v2 content API (returns { objects }).
    fetch: async (acct, { hub }) => {
      const { ok, json } = await hub(acct, 'GET', '/content/api/v2/menus');
      return ok && Array.isArray(json?.objects) ? json.objects : [];
    },
    live: () => true,
    keyOf: (m) => String(m.name ?? m.label ?? ''),
    label: (m) => ({ key: String(m.name ?? m.label ?? ''), state: '', url: '', id: String(m.id ?? '') }),
  },
];

// ---------------------------------------------------------------------------
// classifySurface(gitKeys, accountItems, surface) -> classification  [PURE]
// ---------------------------------------------------------------------------
export function classifySurface(gitKeys, accountItems, surface) {
  const items = Array.isArray(accountItems) ? accountItems : [];
  const live = items.filter((it) => surface.live(it));
  const liveKeys = new Set(live.map((it) => surface.keyOf(it)));

  const orphans = live
    .filter((it) => !gitKeys.has(surface.keyOf(it)))
    .map((it) => surface.label(it));
  const synced = [...liveKeys].filter((k) => gitKeys.has(k));
  const missing = [...gitKeys].filter((k) => !liveKeys.has(k));

  return {
    surface: surface.key,
    counts: {
      git: gitKeys.size,
      account_total: items.length,
      account_live: live.length,
      account_nonlive: items.length - live.length,
      synced: synced.length,
      orphans: orphans.length,
      missing: missing.length,
    },
    orphans: orphans.sort((a, b) => a.key.localeCompare(b.key)),
    missing: missing.sort(),
  };
}

// ---------------------------------------------------------------------------
// Git canonical index: one Set of keys per surface, read from the committed tree.
// ---------------------------------------------------------------------------
async function readJsonSafe(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function buildGitIndex(config, { loadPagesFn = loadPages, loadPostsFn = loadPosts } = {}) {
  const contentDir = config.contentDirPath;
  const blogDir = join(contentDir, 'blog');

  // A missing/empty content tree is a valid input (empty git index) — never throw.
  const safe = async (fn) => { try { return await fn(); } catch { return []; } };
  const [pages, posts] = await Promise.all([
    safe(() => loadPagesFn(contentDir)),
    safe(() => loadPostsFn(contentDir)),
  ]);
  const authors = (await readJsonSafe(join(blogDir, 'authors.json'))) || [];
  const tags = (await readJsonSafe(join(blogDir, 'tags.json'))) || [];

  const landingDir = join(contentDir, 'landing-pages');
  const landingSlugs = new Set(); // populated once a landing-pages adapter lands

  let redirectKeys = new Set();
  if (config.redirectsFilePath && existsSync(config.redirectsFilePath)) {
    try {
      redirectKeys = new Set(readRedirectSpecs(config.redirectsFilePath).map((s) => redirectPath(s.routePrefix ?? '')));
    } catch { /* malformed csv -> empty */ }
  }

  return {
    'site-pages': new Set(pages.map((p) => String(p.slug ?? ''))),
    'landing-pages': landingSlugs,
    'blog-posts': new Set(posts.map((p) => String(p.slug ?? ''))),
    'blog-authors': new Set((Array.isArray(authors) ? authors : []).map((a) => String(a.slug ?? '')).filter(Boolean)),
    'blog-tags': new Set((Array.isArray(tags) ? tags : []).map((t) => String(t.slug ?? '')).filter(Boolean)),
    'url-redirects': redirectKeys,
    'menus': new Set(),
    _meta: { landingDir },
  };
}

// ---------------------------------------------------------------------------
// reconcile(accountNames, { config }) -> report object  (READ-ONLY)
// ---------------------------------------------------------------------------
export async function reconcile(accountNames, { config, accountFn = realAccount, getAll = realGetAll, hub = realHub } = {}) {
  const gitIndex = await buildGitIndex(config);
  const io = { getAll, hub };
  const accounts = [];

  for (const name of accountNames) {
    const acct = await accountFn(name);
    const surfaces = [];
    for (const surface of SURFACES) {
      let items = [];
      let error = null;
      try {
        items = await surface.fetch(acct, io);
      } catch (e) {
        error = e.message;
      }
      const result = classifySurface(gitIndex[surface.key] ?? new Set(), items, surface);
      surfaces.push(error ? { ...result, error } : result);
    }
    accounts.push({ name, portalId: acct.portalId, surfaces });
  }

  return { gitIndex, accounts };
}

// ---------------------------------------------------------------------------
// Human-readable report.
// ---------------------------------------------------------------------------
// Cap a long key list so the report stays readable; the full set is in the returned
// report object (for JSON consumers / a future --json flag).
function capList(keys, cap = 40) {
  const shown = keys.slice(0, cap).map((k) => k || '(home)').join('  ');
  return keys.length > cap ? `${shown}  …(+${keys.length - cap} more)` : shown;
}

export function formatReport({ accounts }, { cap = 40 } = {}) {
  const lines = [];
  for (const acct of accounts) {
    lines.push(`\n=== ${acct.name} (portal ${acct.portalId}) ===`);
    for (const s of acct.surfaces) {
      if (s.error) {
        lines.push(`  ${s.surface.padEnd(16)} ERROR: ${s.error}`);
        continue;
      }
      const c = s.counts;
      lines.push(
        `  ${s.surface.padEnd(16)} git=${c.git} live=${c.account_live} (+${c.account_nonlive} non-live)`
        + `  synced=${c.synced} orphan=${c.orphans} missing=${c.missing}`,
      );
      if (s.orphans.length) {
        lines.push(`     ORPHANS (live on account, not in git): ${capList(s.orphans.map((o) => o.key), cap)}`);
      }
      if (s.missing.length) {
        lines.push(`     MISSING (in git, not on account): ${capList(s.missing, cap)}`);
      }
    }
  }
  return lines.join('\n');
}

export async function main(accountNames, { config } = {}) {
  if (!accountNames || accountNames.length === 0) {
    throw new Error('reconcile: at least one account name is required');
  }
  const report = await reconcile(accountNames, { config });
  console.log(formatReport(report));
  return report;
}
