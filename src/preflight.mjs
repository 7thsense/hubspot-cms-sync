// sync/preflight.mjs — BOOTSTRAP PREFLIGHT for `sync push <account>`.
//
// Usage:  node sync/preflight.mjs <account>
//
// codex finding #3: a "fresh account push" is really a push to a *prepared*
// account. Several prerequisites are UI-gated in HubSpot and cannot be created by
// the push orchestrator (blog container, homepage designation, custom domain) or
// depend on the service key carrying the right scopes. This preflight API-checks
// the TARGET account for those prerequisites and HARD-FAILS with exact remediation
// instructions before any write happens, so the push orchestrator only ever runs
// against an account that is actually ready.
//
// Checks (hard-fail unless noted):
//   1. blog container exists with the manifest's blog slug AND points at the
//      seventh-sense-theme blog templates (item + listing template paths).
//   2. a homepage is designated — a site page resolves at slug '' (root).
//   3. the service key carries the scopes push needs — probed by exercising one
//      endpoint per scope family (forms list, a content/page GET, a files search)
//      and reporting which are missing.
//   4. (REPORT-ONLY) custom domain / hs-sites domain availability — never fails
//      the run; surfaced so the operator knows where the site will publish.
//
// PRODUCTION (portalId 529456) IS READ-ONLY. Even though preflight performs only
// reads, it REFUSES to run against prod (hard guard, regardless of CLI args) so it
// can never be wired into a prod push by mistake — the same guard the push
// orchestrator enforces.
//
// Exit codes:  0 + "ready"  when every hard check passes;
//              non-zero + a remediation checklist when any hard check fails.
//
// The readiness EVALUATION is a pure function (evaluateReadiness) over gathered
// probe results, so it unit-tests without the network. gatherProbes() is the thin
// API layer that feeds it.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { account, hub } from './lib/hub.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// Production portal is READ-ONLY; preflight refuses to run against it.
export const PROD_PORTAL_ID = '529456';

// The theme whose blog templates the container must reference.
export const THEME_NAME = 'seventh-sense-theme';

// Default blog slug when the manifest does not pin one.
const DEFAULT_BLOG_SLUG = 'blog';

// ---------------------------------------------------------------------------
// Manifest: the blog slug the target must host. The design's site.manifest.json
// may carry `{ "blog": { "slug": "blog" } }`; we also accept the committed blog
// container.json (content/blog/container.json) as a fallback source of the slug.
// ---------------------------------------------------------------------------

/**
 * Resolve the blog slug the target account must host.
 * Precedence: site.manifest.json `blog.slug` -> content/blog/container.json `slug`
 * -> DEFAULT_BLOG_SLUG. Pure-ish (reads repo files only, never the network).
 * @param {string} [repoRoot]
 * @returns {string}
 */
export function manifestBlogSlug(repoRoot = REPO_ROOT) {
  const manifestPath = join(repoRoot, 'site.manifest.json');
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const slug = m?.blog?.slug;
      if (slug != null && String(slug) !== '') return String(slug);
    } catch {
      /* fall through to the container file / default */
    }
  }
  const containerPath = join(repoRoot, 'content', 'blog', 'container.json');
  if (existsSync(containerPath)) {
    try {
      const c = JSON.parse(readFileSync(containerPath, 'utf8'));
      if (c?.slug != null && String(c.slug) !== '') return String(c.slug);
    } catch {
      /* fall through to default */
    }
  }
  return DEFAULT_BLOG_SLUG;
}

// ---------------------------------------------------------------------------
// gatherProbes(acct, { blogSlug, hub, getAll, resolveBlogBySlug, resolvePageBySlug })
//   -> probes object consumed by evaluateReadiness.
//
// All four collaborators are injectable so the gather step (and therefore the
// whole CLI) is testable without a live portal. Each probe records a coarse
// shape that the pure evaluator reasons over; gather NEVER throws on an API
// error — it captures the failure so evaluateReadiness can turn it into a scope
// or readiness finding.
// ---------------------------------------------------------------------------
export async function gatherProbes(acct, opts = {}) {
  const {
    blogSlug = DEFAULT_BLOG_SLUG,
    hub: hubFn = hub,
  } = opts;

  const probes = { blogSlug };

  // --- blog container (legacy v2 list; matched by slug, never objects[0]) ------
  // We use the raw v2 endpoint (not resolveBlogBySlug) because we also need the
  // template paths to confirm it points at the theme, and the status to tell a
  // scope failure (403) apart from "no blog yet" (200 + empty).
  {
    const r = await hubFn(acct, 'GET', '/content/api/v2/blogs?limit=100');
    probes.blog = { status: r.status, ok: r.ok };
    if (r.ok) {
      const objects = r.json?.objects || [];
      const match = objects.find((b) => String(b.slug ?? '') === String(blogSlug));
      probes.blog.found = !!match;
      if (match) {
        probes.blog.itemTemplatePath = match.item_template_path || '';
        probes.blog.listingTemplatePath = match.listing_template_path || '';
      }
      probes.blog.slugsSeen = objects.map((b) => String(b.slug ?? ''));
    } else {
      probes.blog.message = r.json?.message || '';
    }
  }

  // --- homepage designation (a site page resolves at root slug '') ------------
  {
    const r = await hubFn(acct, 'GET', '/cms/v3/pages/site-pages?limit=100');
    probes.homepage = { status: r.status, ok: r.ok };
    if (r.ok) {
      const results = r.json?.results || [];
      probes.homepage.found = results.some((p) => String(p.slug ?? '') === '');
    } else {
      probes.homepage.message = r.json?.message || '';
    }
  }

  // --- scope probes: one cheap GET per scope family push needs ----------------
  // forms (forms scope), content GET (content scope), files search (files scope).
  const scopeProbe = async (id, method, path) => {
    const r = await hubFn(acct, method, path);
    // 401/403 => the key lacks the scope. Any other status (incl. 404/200) means
    // the scope is present; the endpoint answered us.
    return { id, status: r.status, ok: r.ok, denied: r.status === 401 || r.status === 403, message: r.json?.message || '' };
  };
  probes.scopes = {
    forms: await scopeProbe('forms', 'GET', '/forms/v2/forms?limit=1'),
    content: await scopeProbe('content', 'GET', '/cms/v3/pages/site-pages?limit=1'),
    files: await scopeProbe('files', 'GET', '/files/v3/files/search?limit=1'),
  };

  // --- (report-only) domain availability --------------------------------------
  {
    const d = await hubFn(acct, 'GET', '/cms/v3/domains');
    probes.domains = { status: d.status, ok: d.ok };
    if (d.ok) {
      const results = d.json?.results || [];
      probes.domains.list = results.map((x) => ({
        domain: x.domain,
        isResolving: !!x.isResolving,
        isHsSitesDomain: !!(x.isHsSitesDomain ?? x.is_hs_sites_domain),
      }));
    } else {
      probes.domains.message = d.json?.message || '';
    }
  }

  return probes;
}

// ---------------------------------------------------------------------------
// evaluateReadiness(probes, { blogSlug, themeName }) -> { ready, checks, failures }
//
// PURE. Turns gathered probes into a deterministic checklist. Each check is
// { id, ok, detail, remediation }. `ready` is true only when every HARD check
// (everything except report-only domain) passes. `failures` is the subset of
// checks with ok === false AND reportOnly !== true, in stable order.
// ---------------------------------------------------------------------------
export function evaluateReadiness(probes, opts = {}) {
  const blogSlug = opts.blogSlug ?? probes.blogSlug ?? DEFAULT_BLOG_SLUG;
  const themeName = opts.themeName ?? THEME_NAME;
  const checks = [];

  const add = (c) => checks.push({ reportOnly: false, ...c });

  // --- 1. blog container ------------------------------------------------------
  const blog = probes.blog || {};
  if (blog.ok === false) {
    add({
      id: 'blog-container',
      ok: false,
      detail: `cannot list blogs (HTTP ${blog.status}${blog.message ? `: ${blog.message}` : ''})`,
      remediation:
        `Grant the service key the "content" scope, then ensure a blog exists. ` +
        `Listing blogs failed, so blog readiness cannot be confirmed.`,
    });
  } else if (!blog.found) {
    const seen = (blog.slugsSeen || []).filter(Boolean);
    add({
      id: 'blog-container',
      ok: false,
      detail:
        `no blog container with slug "${blogSlug}"` +
        (seen.length ? ` (found: ${seen.join(', ')})` : ' (no blogs exist)'),
      remediation:
        `Create the blog in HubSpot UI: Settings -> Website -> Blog -> "Create another blog", ` +
        `set its URL slug to "${blogSlug}". (Blog creation is UI-gated; push cannot do it.)`,
    });
  } else {
    // Container exists — confirm it points at the theme's blog templates.
    const item = blog.itemTemplatePath || '';
    const listing = blog.listingTemplatePath || '';
    const pointsAtTheme = (p) => p.includes(`${themeName}/`) || p.includes(`${themeName}\\`);
    const itemOk = pointsAtTheme(item);
    const listingOk = pointsAtTheme(listing);
    if (itemOk && listingOk) {
      add({ id: 'blog-container', ok: true, detail: `blog "${blogSlug}" exists and uses ${themeName} templates` });
    } else {
      const wrong = [];
      if (!itemOk) wrong.push(`post/item template "${item || '(unset)'}"`);
      if (!listingOk) wrong.push(`listing template "${listing || '(unset)'}"`);
      add({
        id: 'blog-templates',
        ok: false,
        detail: `blog "${blogSlug}" exists but ${wrong.join(' and ')} not under ${themeName}`,
        remediation:
          `In Settings -> Website -> Blog -> Templates, set the blog post and listing ` +
          `templates to the ${themeName} blog templates, then re-run preflight.`,
      });
    }
  }

  // --- 2. homepage designation ------------------------------------------------
  const homepage = probes.homepage || {};
  if (homepage.ok === false) {
    add({
      id: 'homepage',
      ok: false,
      detail: `cannot list site pages (HTTP ${homepage.status}${homepage.message ? `: ${homepage.message}` : ''})`,
      remediation: `Grant the service key the "content" scope so the homepage can be confirmed.`,
    });
  } else if (!homepage.found) {
    add({
      id: 'homepage',
      ok: false,
      detail: `no site page resolves at the root slug ''`,
      remediation:
        `Publish a page at the site root and designate it the homepage ` +
        `(Settings -> Website -> Pages -> "System pages"/homepage, or set the page's URL to the domain root). ` +
        `Homepage designation is UI-gated; push cannot do it.`,
    });
  } else {
    add({ id: 'homepage', ok: true, detail: `a page is designated at the root slug ''` });
  }

  // --- 3. service-key scopes --------------------------------------------------
  const scopes = probes.scopes || {};
  const missing = [];
  for (const id of ['forms', 'content', 'files']) {
    const s = scopes[id];
    if (!s || s.denied) missing.push(id);
  }
  if (missing.length === 0) {
    add({ id: 'scopes', ok: true, detail: `service key has forms, content, files scopes` });
  } else {
    add({
      id: 'scopes',
      ok: false,
      detail: `service key is missing scope(s): ${missing.join(', ')}`,
      remediation:
        `In HubSpot UI: Settings -> Integrations -> Private Apps -> (this app) -> Scopes, ` +
        `add the missing scope(s) [${missing.join(', ')}], regenerate the token if needed, ` +
        `and update $HUBSPOT_KEY_DIR/<portalId>.key.`,
    });
  }

  // --- 4. domain availability (REPORT-ONLY: never fails readiness) ------------
  const domains = probes.domains || {};
  if (domains.ok === false) {
    add({
      id: 'domain',
      ok: false,
      reportOnly: true,
      detail: `could not read domains (HTTP ${domains.status}${domains.message ? `: ${domains.message}` : ''}) — report only`,
      remediation: `(report only) Connect a custom domain or use the hs-sites domain in Settings -> Website -> Domains & URLs.`,
    });
  } else {
    const list = domains.list || [];
    const resolving = list.filter((d) => d.isResolving);
    if (list.length === 0) {
      add({
        id: 'domain',
        ok: false,
        reportOnly: true,
        detail: `no domains connected — content will publish only to the default hs-sites domain (report only)`,
        remediation: `(report only) Connect a custom domain in Settings -> Website -> Domains & URLs.`,
      });
    } else {
      add({
        id: 'domain',
        ok: true,
        reportOnly: true,
        detail:
          `domains: ${list.map((d) => d.domain).join(', ')}` +
          (resolving.length ? ` (resolving: ${resolving.map((d) => d.domain).join(', ')})` : ' (none resolving yet)'),
      });
    }
  }

  const failures = checks.filter((c) => !c.ok && !c.reportOnly);
  return { ready: failures.length === 0, checks, failures };
}

// ---------------------------------------------------------------------------
// Rendering (pure): turn an evaluation into a human checklist string.
// ---------------------------------------------------------------------------
export function renderReport(evald, { account: acctName, portalId, blogSlug } = {}) {
  const lines = [];
  lines.push(`Bootstrap preflight — account "${acctName}" (portal ${portalId}), blog slug "${blogSlug}"`);
  for (const c of evald.checks) {
    const mark = c.ok ? 'PASS' : c.reportOnly ? 'NOTE' : 'FAIL';
    lines.push(`  [${mark}] ${c.id}: ${c.detail}`);
    if (!c.ok && c.remediation) lines.push(`         -> ${c.remediation}`);
  }
  if (evald.ready) {
    lines.push('ready');
  } else {
    lines.push(`NOT READY — ${evald.failures.length} blocking prerequisite(s):`);
    for (const f of evald.failures) lines.push(`  - ${f.id}: ${f.remediation || f.detail}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
export async function main(argv = process.argv.slice(2), opts = {}) {
  const { config } = opts;
  const acctName = argv[0];
  if (!acctName) {
    process.stderr.write('usage: node sync/preflight.mjs <account>\n');
    return 2;
  }

  let acct;
  try {
    acct = account(acctName, config);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }

  // PRODUCTION guard: refuse regardless of CLI args.
  const readOnly = new Set((config?.readOnlyPortalIds?.length ? config.readOnlyPortalIds : [PROD_PORTAL_ID]).map(String));
  if (readOnly.has(String(acct.portalId))) {
    process.stderr.write(
      `Refusing to run: account "${acctName}" maps to read-only portal ${acct.portalId}. ` +
        `Preflight (and push) must never target read-only accounts.\n`,
    );
    return 3;
  }

  const blogSlug = config?.blog?.slug || manifestBlogSlug(config?.root || REPO_ROOT);
  let probes;
  try {
    probes = await gatherProbes(acct, { blogSlug });
  } catch (e) {
    process.stderr.write(`preflight: probe error: ${e.message}\n`);
    return 1;
  }

  const evald = evaluateReadiness(probes, { blogSlug, themeName: config?.theme?.name || THEME_NAME });
  const report = renderReport(evald, { account: acctName, portalId: acct.portalId, blogSlug });
  process.stdout.write(report + '\n');
  return evald.ready ? 0 : 1;
}

// Run as a script (not when imported by the unit tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}

export default { main, gatherProbes, evaluateReadiness, manifestBlogSlug, renderReport };
