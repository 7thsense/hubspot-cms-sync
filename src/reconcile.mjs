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
    deletePath: (id) => `/cms/v3/pages/site-pages/${id}`,
  },
  {
    key: 'landing-pages',
    fetch: (acct, { getAll }) => getAll(acct, '/cms/v3/pages/landing-pages'),
    live: isLivePage,
    keyOf: (p) => String(p.slug ?? ''),
    label: (p) => ({ key: String(p.slug ?? ''), state: String(p.currentState ?? p.state ?? ''), url: p.url ?? '', id: String(p.id ?? '') }),
    deletePath: (id) => `/cms/v3/pages/landing-pages/${id}`,
  },
  {
    key: 'blog-posts',
    fetch: (acct, { getAll }) => getAll(acct, '/cms/v3/blogs/posts'),
    live: (p) => String(p.state ?? '') === 'PUBLISHED',
    keyOf: (p) => String(p.slug ?? ''),
    label: (p) => ({ key: String(p.slug ?? ''), state: String(p.state ?? ''), url: p.url ?? '', id: String(p.id ?? '') }),
    deletePath: (id) => `/cms/v3/blogs/posts/${id}`,
  },
  {
    key: 'blog-authors',
    fetch: (acct, { getAll }) => getAll(acct, '/cms/v3/blogs/authors'),
    live: () => true,
    keyOf: (a) => String(a.slug ?? ''),
    label: (a) => ({ key: String(a.slug ?? ''), state: '', url: '', id: String(a.id ?? '') }),
    deletePath: (id) => `/cms/v3/blogs/authors/${id}`,
  },
  {
    key: 'blog-tags',
    fetch: (acct, { getAll }) => getAll(acct, '/cms/v3/blogs/tags'),
    live: () => true,
    keyOf: (t) => String(t.slug ?? ''),
    label: (t) => ({ key: String(t.slug ?? ''), state: '', url: '', id: String(t.id ?? '') }),
    deletePath: (id) => `/cms/v3/blogs/tags/${id}`,
  },
  {
    key: 'url-redirects',
    fetch: (acct, { getAll }) => getAll(acct, '/cms/v3/url-redirects'),
    live: () => true,
    keyOf: (r) => redirectPath(r.routePrefix ?? r.url ?? ''),
    label: (r) => ({ key: redirectPath(r.routePrefix ?? r.url ?? ''), state: '', url: String(r.destination ?? ''), id: String(r.id ?? '') }),
    deletePath: (id) => `/cms/v3/url-redirects/${id}`,
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
    deletePath: (id) => `/content/api/v2/menus/${id}`,
  },
];

export const SURFACE_BY_KEY = Object.fromEntries(SURFACES.map((s) => [s.key, s]));

// Surfaces the toolkit does NOT migrate (no adapter). We PROBE them read-only so a
// non-empty one is FLAGGED loudly instead of silently dropped — the operator must know
// before cutover ("no surprises"). count() pulls a coarse size; a 403 MISSING_SCOPES is
// itself a finding (the credential can't even see it).
export const UNSUPPORTED_SURFACES = [
  { key: 'hubdb-tables', path: '/cms/v3/hubdb/tables?limit=1', note: 'HubDB tables — needs the hubdb scope on the credential to migrate' },
  { key: 'knowledge-base', path: '/cms/v3/knowledge-base/articles?limit=1', note: 'Knowledge Base articles — no adapter' },
  { key: 'marketing-emails', path: '/marketing/v3/emails?limit=1', note: 'Marketing emails — out of CMS scope; no adapter' },
  { key: 'hubdb-v2', path: '/hubdb/api/v2/tables?limit=1', note: 'HubDB (v2) — needs the hubdb scope' },
];

// probeUnsupported(acct, hub) -> [{ key, status, count, flagged, note }]
export async function probeUnsupported(acct, hub) {
  const out = [];
  for (const s of UNSUPPORTED_SURFACES) {
    try {
      const { ok, status, json } = await hub(acct, 'GET', s.path);
      const count = typeof json?.total === 'number' ? json.total
        : Array.isArray(json?.results) ? json.results.length
          : Array.isArray(json?.objects) ? json.objects.length : null;
      // Flag if there's content OR the credential is forbidden from even checking.
      const flagged = (ok && count > 0) || status === 403;
      out.push({ key: s.key, status, count, flagged, note: s.note });
    } catch (e) {
      out.push({ key: s.key, status: 'EXC', count: null, flagged: true, note: `${s.note} (${e.message.slice(0, 60)})` });
    }
  }
  return out;
}

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
    const unsupported = await probeUnsupported(acct, hub);
    accounts.push({ name, portalId: acct.portalId, surfaces, unsupported });
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
    const flagged = (acct.unsupported || []).filter((u) => u.flagged);
    if (flagged.length) {
      lines.push('  UNSUPPORTED SURFACES (no adapter — would NOT migrate; flagged so they are not a surprise):');
      for (const u of flagged) {
        const size = u.status === 403 ? 'FORBIDDEN (403 — credential lacks scope)' : `count=${u.count}`;
        lines.push(`     ⚠ ${u.key.padEnd(16)} ${size}  — ${u.note}`);
      }
    }
  }
  return lines.join('\n');
}

// emitDeletions(report, { surfaces }) -> deletions.csv text
// Turn an account's ORPHANS (live on the account, not in git) into a managed deletions
// list (surface,key,reason) ready for `hcms delete`. Defaults to page surfaces — the
// "old pages to remove" of a clean-slate; blog-posts/redirects are excluded by default
// because an orphan there is more likely content to KEEP/migrate than to delete. The
// operator REVIEWS + trims the file; nothing is deleted by generating it.
const DEFAULT_DELETION_SURFACES = ['site-pages', 'landing-pages', 'menus'];

export function emitDeletions(accountReport, { surfaces = DEFAULT_DELETION_SURFACES } = {}) {
  const lines = [
    '# Clean-slate deletions — generated from `hcms reconcile --emit-deletions`.',
    `# Source: ${accountReport.name} (portal ${accountReport.portalId}). REVIEW before applying.`,
    '# Each row is a LIVE item on the account that is NOT in git. Delete = remove at cutover.',
    '# Apply with: hcms delete <account> --apply  (prod requires HCMS_ALLOW_PROD_PUSH=1).',
    'surface,key,reason',
  ];
  let count = 0;
  for (const s of accountReport.surfaces) {
    if (!surfaces.includes(s.surface)) continue;
    for (const o of s.orphans) {
      lines.push(`${s.surface},${o.key},orphan (live on ${accountReport.name}, not in git)`);
      count += 1;
    }
  }
  return { text: `${lines.join('\n')}\n`, count };
}

export async function main(accountNames, { config, emitDeletionsFile, surfaces } = {}) {
  if (!accountNames || accountNames.length === 0) {
    throw new Error('reconcile: at least one account name is required');
  }
  const report = await reconcile(accountNames, { config });
  console.log(formatReport(report));

  if (emitDeletionsFile) {
    if (accountNames.length !== 1) {
      throw new Error('reconcile --emit-deletions: pass exactly ONE account (the one to clean-slate)');
    }
    const opts = surfaces ? { surfaces: surfaces.split(',').map((x) => x.trim()).filter(Boolean) } : {};
    const { text, count } = emitDeletions(report.accounts[0], opts);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(emitDeletionsFile, text);
    console.log(`\nWrote ${count} deletion candidate(s) -> ${emitDeletionsFile} (REVIEW before \`hcms delete\`).`);
  }
  return report;
}
