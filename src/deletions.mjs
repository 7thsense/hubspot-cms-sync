// src/deletions.mjs — MANAGED DELETIONS (clean-slate support).
//
// A declarative, reviewable list of content to REMOVE from an account — the
// destructive sibling of managed redirects. Mirrors that workflow:
//   - sync/deletions.csv : rows of `surface,key[,reason]` (one item to delete each)
//   - `hcms delete <account>`        : PLAN only (dry-run) — what WOULD be deleted
//   - `hcms delete <account> --apply`: actually DELETE the listed items
//
// HARD SAFETY:
//   - DRY-RUN BY DEFAULT. Nothing is deleted without --apply.
//   - Read-only portals (prod, unless HCMS_ALLOW_PROD_PUSH=1 clears readOnlyPortalIds)
//     are refused for --apply.
//   - Deletes ONLY items explicitly listed. A key that matches nothing is reported as
//     `absent` (idempotent — already gone / or a typo the operator can see), never a
//     wildcard delete.
//   - An unknown surface or unparseable row is a hard error before any delete.
//
// planDeletions() is PURE (specs + inventory -> plan), so it unit-tests with fixtures.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { account as realAccount, getAll as realGetAll, hub as realHub } from './lib/hub.mjs';
import { SURFACE_BY_KEY, redirectPath, buildGitIndex } from './reconcile.mjs';

// Page surfaces whose deletion should be covered by a redirect (else a live URL 404s
// at cutover). Posts/tags/authors/menus are not URL-bearing in the same way.
const REDIRECTED_SURFACES = new Set(['site-pages', 'landing-pages']);

const READ_ONLY_PORTAL = '529456';

function readOnlySet(config) {
  return new Set((config?.readOnlyPortalIds?.length ? config.readOnlyPortalIds : [READ_ONLY_PORTAL]).map(String));
}

// ---------------------------------------------------------------------------
// Parse `surface,key[,reason]` CSV. Blank lines and # comments ignored; a leading
// header row (`surface,...`) is skipped.
// ---------------------------------------------------------------------------
export function parseDeletionsCsv(text) {
  const specs = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const cells = line.split(',').map((c) => c.trim());
    if (cells[0] === 'surface') continue; // header
    const [surface, key, ...rest] = cells;
    if (!surface || !key) {
      throw new Error(`deletions: malformed row (need "surface,key"): ${rawLine}`);
    }
    specs.push({ surface, key, reason: rest.join(',') || '' });
  }
  return specs;
}

export function readDeletionSpecs(file) {
  const text = readFileSync(file, 'utf8');
  if (file.endsWith('.json')) {
    const raw = JSON.parse(text);
    if (!Array.isArray(raw)) throw new Error('deletions JSON must be an array of {surface,key,reason}');
    return raw.map((r) => {
      if (!r?.surface || !r?.key) throw new Error(`deletions: each entry needs surface+key: ${JSON.stringify(r)}`);
      return { surface: String(r.surface), key: String(r.key), reason: String(r.reason ?? '') };
    });
  }
  return parseDeletionsCsv(text);
}

// ---------------------------------------------------------------------------
// planDeletions(specs, inventoryBySurface, surfaceByKey) -> plan[]   [PURE]
// Each plan item: { surface, key, reason, id, action: 'delete'|'absent' }
// Throws on an unknown surface (a typo in the surface column must fail loudly).
// ---------------------------------------------------------------------------
export function planDeletions(specs, inventoryBySurface, surfaceByKey = SURFACE_BY_KEY) {
  const indexCache = new Map();
  const indexFor = (surfaceKey) => {
    if (indexCache.has(surfaceKey)) return indexCache.get(surfaceKey);
    const surface = surfaceByKey[surfaceKey];
    const items = inventoryBySurface[surfaceKey] || [];
    const map = new Map();
    for (const it of items) {
      const k = surface.keyOf(it);
      if (!map.has(k)) map.set(k, surface.label(it).id);
    }
    indexCache.set(surfaceKey, map);
    return map;
  };

  return specs.map((spec) => {
    const surface = surfaceByKey[spec.surface];
    if (!surface) {
      throw new Error(`deletions: unknown surface "${spec.surface}" (known: ${Object.keys(surfaceByKey).join(', ')})`);
    }
    const id = indexFor(spec.surface).get(spec.key);
    return id
      ? { surface: spec.surface, key: spec.key, reason: spec.reason, id, action: 'delete' }
      : { surface: spec.surface, key: spec.key, reason: spec.reason, id: null, action: 'absent' };
  });
}

// ---------------------------------------------------------------------------
// syncDeletions(name, { apply, file, config }, deps) -> result   (DRY-RUN default)
// ---------------------------------------------------------------------------
export async function syncDeletions(name, options = {}, deps = {}) {
  const { apply = false, file, config: optionConfig } = options;
  const {
    account = realAccount,
    getAll = realGetAll,
    hub = realHub,
    readSpecs = readDeletionSpecs,
    surfaceByKey = SURFACE_BY_KEY,
  } = deps;
  const config = deps.config || optionConfig;
  const acct = await account(name, config);

  if (apply && readOnlySet(config).has(String(acct.portalId))) {
    throw new Error(
      `portal is read-only: account "${acct.name}" maps to portal ${acct.portalId}; `
      + 'deletions refuses to --apply (set HCMS_ALLOW_PROD_PUSH=1 / clear readOnlyPortalIds to override)',
    );
  }

  const sourceFile = file || (config?.root ? resolve(config.root, 'sync/deletions.csv') : 'sync/deletions.csv');
  const specs = readSpecs(sourceFile);

  // Fetch the inventory once per DISTINCT surface that appears in the list.
  const io = { getAll, hub };
  const surfacesNeeded = [...new Set(specs.map((s) => s.surface))];
  const inventoryBySurface = {};
  for (const sk of surfacesNeeded) {
    const surface = surfaceByKey[sk];
    if (!surface) throw new Error(`deletions: unknown surface "${sk}"`);
    inventoryBySurface[sk] = await surface.fetch(acct, io);
  }

  const plan = planDeletions(specs, inventoryBySurface, surfaceByKey);

  // REDIRECT-COVERAGE GUARD: a page being deleted should have a redirect from its path,
  // or the URL 404s at cutover. Annotate each page deletion with redirectCovered so the
  // report can warn. Read-only (fetches the account's redirects once if needed).
  const needsCoverage = plan.some((p) => p.action === 'delete' && REDIRECTED_SURFACES.has(p.surface));
  if (needsCoverage) {
    let redirectCovered = new Set();
    try {
      const redirects = await getAll(acct, '/cms/v3/url-redirects');
      redirectCovered = new Set(redirects.map((r) => redirectPath(r.routePrefix ?? r.url ?? '')));
    } catch { /* can't read redirects -> treat as uncovered (warn) */ }
    // A NEW git page at the same slug also covers the path (the redesign serves it after
    // cutover) — that's not a 404, so it shouldn't be flagged. Read the git page sets.
    let gitPaths = new Set();
    if (config?.contentDirPath) {
      try {
        const gi = await buildGitIndex(config);
        gitPaths = new Set([...(gi['site-pages'] || []), ...(gi['landing-pages'] || [])].map((s) => `/${String(s).replace(/^\//, '')}`));
      } catch { /* no git tree -> only redirects count */ }
    }
    for (const p of plan) {
      if (p.action === 'delete' && REDIRECTED_SURFACES.has(p.surface)) {
        const path = `/${String(p.key).replace(/^\//, '')}`;
        p.redirectCovered = redirectCovered.has(path) || gitPaths.has(path);
        p.coveredByNewPage = !redirectCovered.has(path) && gitPaths.has(path);
      }
    }
  }

  if (apply) {
    for (const item of plan) {
      if (item.action !== 'delete') continue;
      const path = surfaceByKey[item.surface].deletePath(item.id);
      const r = await hub(acct, 'DELETE', path);
      // 404 = already gone; treat as success (idempotent).
      if (!r.ok && r.status !== 404) {
        const msg = r.json?.message || r.json?.category || `HTTP ${r.status}`;
        throw new Error(`delete ${item.surface}/${item.key} (${item.id}) -> ${r.status}: ${msg}`);
      }
      item.deleted = true;
    }
  }

  return {
    account: acct.name,
    portalId: acct.portalId,
    file: sourceFile,
    apply,
    plan,
    counts: {
      delete: plan.filter((x) => x.action === 'delete').length,
      absent: plan.filter((x) => x.action === 'absent').length,
    },
  };
}

export function renderDeletionReport(result) {
  const lines = [];
  const verb = result.apply ? 'DELETED' : 'WOULD DELETE (dry-run — pass --apply to execute)';
  lines.push(`deletions for ${result.account} (portal ${result.portalId}) from ${result.file}`);
  lines.push(`${verb}: ${result.counts.delete}   absent (already gone / no match): ${result.counts.absent}`);
  const uncovered = result.plan.filter((p) => p.action === 'delete' && p.redirectCovered === false);
  for (const item of result.plan) {
    const mark = item.action === 'delete' ? (result.apply ? '✓ deleted' : '• will delete') : '· absent';
    let cov = '';
    if (item.redirectCovered === false) cov = '  ⚠ NO REDIRECT (would 404 at cutover)';
    else if (item.coveredByNewPage) cov = '  (path served by a new git page — ok)';
    lines.push(`  ${mark}  ${item.surface}/${item.key}${item.reason ? `  (${item.reason})` : ''}${cov}`);
  }
  if (uncovered.length) {
    lines.push(`\n⚠ ${uncovered.length} page deletion(s) have NO redirect — add redirects (sync/redirects.csv) before cutover so old URLs don't 404:`);
    for (const u of uncovered) lines.push(`    /${String(u.key).replace(/^\//, '')}`);
  }
  return lines.join('\n');
}

export async function main(name, options = {}) {
  const result = await syncDeletions(name, options);
  console.log(renderDeletionReport(result));
  return result;
}
