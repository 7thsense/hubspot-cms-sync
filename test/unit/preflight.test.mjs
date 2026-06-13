// Unit tests for sync/preflight.mjs — pure readiness evaluation + mocked hub.
//   node --test test/unit/preflight.test.mjs
//
// The readiness EVALUATION is pure: given stubbed probe results it returns
// ready=true or a specific failures list. We also exercise gatherProbes with a
// recording mock hub (no network) and the prod READ-ONLY guard in main().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  evaluateReadiness,
  gatherProbes,
  manifestBlogSlug,
  sourceRepairability,
  renderReport,
  main,
  THEME_NAME,
  PROD_PORTAL_ID,
} from '../../src/preflight.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A fully-ready probe set (every hard check passes; domain present).
function readyProbes() {
  return {
    blogSlug: 'blog',
    blog: {
      ok: true,
      status: 200,
      found: true,
      itemTemplatePath: `${THEME_NAME}/templates/blog-post.html`,
      listingTemplatePath: `${THEME_NAME}/templates/blog-listing.html`,
      slugsSeen: ['blog'],
    },
    homepage: { ok: true, status: 200, found: true },
    scopes: {
      forms: { id: 'forms', status: 200, denied: false },
      content: { id: 'content', status: 200, denied: false },
      files: { id: 'files', status: 200, denied: false },
    },
    domains: { ok: true, status: 200, list: [{ domain: 'example.com', isResolving: true }] },
  };
}

const idsOf = (checks) => checks.map((c) => c.id);
const failIds = (evald) => evald.failures.map((c) => c.id);

// ---------------- ready ----------------

test('evaluateReadiness: all prerequisites present -> ready, no failures', () => {
  const e = evaluateReadiness(readyProbes(), { blogSlug: 'blog' });
  assert.equal(e.ready, true);
  assert.deepEqual(e.failures, []);
  // every hard check passed; domain note present
  assert.ok(e.checks.find((c) => c.id === 'blog-container' && c.ok));
  assert.ok(e.checks.find((c) => c.id === 'homepage' && c.ok));
  assert.ok(e.checks.find((c) => c.id === 'scopes' && c.ok));
  assert.ok(e.checks.find((c) => c.id === 'domain' && c.reportOnly));
});

// ---------------- blog: missing container ----------------

test('evaluateReadiness: no blog with the manifest slug -> blog-container failure', () => {
  const p = readyProbes();
  p.blog = { ok: true, status: 200, found: false, slugsSeen: ['blog-old-pages'] };
  const e = evaluateReadiness(p, { blogSlug: 'blog' });
  assert.equal(e.ready, false);
  assert.deepEqual(failIds(e), ['blog-container']);
  const f = e.failures[0];
  assert.match(f.detail, /slug "blog"/);
  assert.match(f.detail, /blog-old-pages/); // surfaces what DOES exist
  assert.match(f.remediation, /Settings -> Website -> Blog/);
});

test('evaluateReadiness: no blogs exist at all -> blog-container failure', () => {
  const p = readyProbes();
  p.blog = { ok: true, status: 200, found: false, slugsSeen: [] };
  const e = evaluateReadiness(p, { blogSlug: 'blog' });
  assert.equal(e.ready, false);
  assert.deepEqual(failIds(e), ['blog-container']);
  assert.match(e.failures[0].detail, /no blogs exist/);
});

// ---------------- blog: wrong templates ----------------

test('evaluateReadiness: blog exists but templates are not the theme -> blog-templates failure', () => {
  const p = readyProbes();
  p.blog.itemTemplatePath = 'generated_layouts/123.html';
  p.blog.listingTemplatePath = 'generated_layouts/456.html';
  const e = evaluateReadiness(p, { blogSlug: 'blog', themeName: THEME_NAME });
  assert.equal(e.ready, false);
  assert.deepEqual(failIds(e), ['blog-templates']);
  assert.match(e.failures[0].detail, new RegExp(THEME_NAME));
});

test('evaluateReadiness: allowRepairable treats source-owned blog-template drift as non-blocking', () => {
  const p = readyProbes();
  p.blog.itemTemplatePath = '@marketplace/FastestThemes/Dark_free_Theme/templates/Blog-Post.html';
  p.blog.listingTemplatePath = '@marketplace/FastestThemes/Dark_free_Theme/templates/Blog-Listing.html';
  const e = evaluateReadiness(p, {
    blogSlug: 'blog',
    themeName: THEME_NAME,
    allowRepairable: true,
    repairable: { blogTemplates: true },
  });
  assert.equal(e.ready, true);
  assert.deepEqual(e.failures, []);
  assert.ok(e.checks.find((c) => c.id === 'blog-templates' && c.ok && c.repairable));
});

test('evaluateReadiness: only listing template wrong still fails blog-templates', () => {
  const p = readyProbes();
  p.blog.listingTemplatePath = '';
  const e = evaluateReadiness(p, { blogSlug: 'blog' });
  assert.equal(e.ready, false);
  assert.deepEqual(failIds(e), ['blog-templates']);
  assert.match(e.failures[0].detail, /listing template/);
});

// ---------------- homepage ----------------

test('evaluateReadiness: no homepage at root slug -> homepage failure', () => {
  const p = readyProbes();
  p.homepage = { ok: true, status: 200, found: false };
  const e = evaluateReadiness(p, { blogSlug: 'blog' });
  assert.equal(e.ready, false);
  assert.deepEqual(failIds(e), ['homepage']);
  assert.match(e.failures[0].remediation, /homepage/i);
});

test('evaluateReadiness: allowRepairable treats source-owned missing homepage as non-blocking', () => {
  const p = readyProbes();
  p.homepage = { ok: true, status: 200, found: false };
  const e = evaluateReadiness(p, {
    blogSlug: 'blog',
    allowRepairable: true,
    repairable: { homepage: true },
  });
  assert.equal(e.ready, true);
  assert.deepEqual(e.failures, []);
  assert.ok(e.checks.find((c) => c.id === 'homepage' && c.ok && c.repairable));
});

// ---------------- scopes ----------------

test('evaluateReadiness: a denied scope probe -> scopes failure listing the missing scope', () => {
  const p = readyProbes();
  p.scopes.files = { id: 'files', status: 403, denied: true };
  const e = evaluateReadiness(p, { blogSlug: 'blog' });
  assert.equal(e.ready, false);
  assert.deepEqual(failIds(e), ['scopes']);
  assert.match(e.failures[0].detail, /missing scope\(s\): files/);
});

test('evaluateReadiness: multiple missing scopes listed in order', () => {
  const p = readyProbes();
  p.scopes.forms = { id: 'forms', status: 401, denied: true };
  p.scopes.content = { id: 'content', status: 403, denied: true };
  const e = evaluateReadiness(p, { blogSlug: 'blog' });
  assert.deepEqual(failIds(e), ['scopes']);
  assert.match(e.failures[0].detail, /forms, content/);
});

// blog/homepage list failing (no content scope) surfaces as their own failures too
test('evaluateReadiness: content list 403 -> blog-container + homepage both fail', () => {
  const p = readyProbes();
  p.blog = { ok: false, status: 403, message: 'missing content scope' };
  p.homepage = { ok: false, status: 403, message: 'missing content scope' };
  p.scopes.content = { id: 'content', status: 403, denied: true };
  const e = evaluateReadiness(p, { blogSlug: 'blog' });
  assert.equal(e.ready, false);
  assert.deepEqual(failIds(e), ['blog-container', 'homepage', 'scopes']);
});

// ---------------- domain is report-only ----------------

test('evaluateReadiness: no domains connected does NOT block readiness (report-only)', () => {
  const p = readyProbes();
  p.domains = { ok: true, status: 200, list: [] };
  const e = evaluateReadiness(p, { blogSlug: 'blog' });
  assert.equal(e.ready, true); // still ready
  assert.deepEqual(e.failures, []); // domain is not a hard failure
  const d = e.checks.find((c) => c.id === 'domain');
  assert.equal(d.ok, false);
  assert.equal(d.reportOnly, true);
});

test('evaluateReadiness: domain read error is report-only too', () => {
  const p = readyProbes();
  p.domains = { ok: false, status: 403, message: 'no scope' };
  const e = evaluateReadiness(p, { blogSlug: 'blog' });
  assert.equal(e.ready, true);
  assert.deepEqual(e.failures, []);
});

// ---------------- aggregate of several failures ----------------

test('evaluateReadiness: several missing prerequisites -> stable ordered failures list', () => {
  const p = readyProbes();
  p.blog = { ok: true, status: 200, found: false, slugsSeen: [] };
  p.homepage = { ok: true, status: 200, found: false };
  p.scopes.files = { id: 'files', status: 403, denied: true };
  const e = evaluateReadiness(p, { blogSlug: 'blog' });
  assert.equal(e.ready, false);
  assert.deepEqual(failIds(e), ['blog-container', 'homepage', 'scopes']);
});

// ---------------- renderReport ----------------

test('renderReport: ends with "ready" when ready', () => {
  const e = evaluateReadiness(readyProbes(), { blogSlug: 'blog' });
  const out = renderReport(e, { account: 'dev', portalId: '246389711', blogSlug: 'blog' });
  assert.match(out, /\[PASS\] blog-container/);
  assert.match(out, /\nready$/);
});

test('renderReport: lists blocking prerequisites when not ready', () => {
  const p = readyProbes();
  p.homepage = { ok: true, status: 200, found: false };
  const e = evaluateReadiness(p, { blogSlug: 'blog' });
  const out = renderReport(e, { account: 'dev', portalId: '246389711', blogSlug: 'blog' });
  assert.match(out, /\[FAIL\] homepage/);
  assert.match(out, /NOT READY — 1 blocking prerequisite/);
});

test('renderReport: marks repairable checks as WARN while keeping readiness', () => {
  const p = readyProbes();
  p.homepage = { ok: true, status: 200, found: false };
  const e = evaluateReadiness(p, {
    blogSlug: 'blog',
    allowRepairable: true,
    repairable: { homepage: true },
  });
  const out = renderReport(e, { account: 'dev', portalId: '246389711', blogSlug: 'blog' });
  assert.match(out, /\[WARN\] homepage/);
  assert.match(out, /\nready$/);
});

// ---------------- manifestBlogSlug ----------------

test('manifestBlogSlug: reads site.manifest.json blog.slug first', () => {
  const root = mkdtempSync(join(tmpdir(), 'pf-'));
  try {
    writeFileSync(join(root, 'site.manifest.json'), JSON.stringify({ blog: { slug: 'news' } }));
    assert.equal(manifestBlogSlug(root), 'news');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manifestBlogSlug: falls back to content/blog/container.json slug', () => {
  const root = mkdtempSync(join(tmpdir(), 'pf-'));
  try {
    const blogDir = join(root, 'content', 'blog');
    mkdirSync(blogDir, { recursive: true });
    writeFileSync(join(blogDir, 'container.json'), JSON.stringify({ slug: 'insights' }));
    assert.equal(manifestBlogSlug(root), 'insights');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manifestBlogSlug: defaults to "blog" with no manifest/container', () => {
  const root = mkdtempSync(join(tmpdir(), 'pf-'));
  try {
    assert.equal(manifestBlogSlug(root), 'blog');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sourceRepairability: detects committed blog templates and published homepage', () => {
  const root = mkdtempSync(join(tmpdir(), 'pf-src-'));
  try {
    mkdirSync(join(root, 'content', 'blog'), { recursive: true });
    mkdirSync(join(root, 'content', 'pages'), { recursive: true });
    writeFileSync(join(root, 'site.manifest.json'), JSON.stringify({
      pages: [{ slug: '', desiredState: 'publish' }],
      blog: { slug: 'blog' },
    }));
    writeFileSync(join(root, 'content', 'blog', 'container.json'), JSON.stringify({
      slug: 'blog',
      itemTemplatePath: `${THEME_NAME}/templates/blog-post.html`,
      listingTemplatePath: `${THEME_NAME}/templates/blog.html`,
    }));
    writeFileSync(join(root, 'content', 'pages', 'home.json'), JSON.stringify({
      slug: '',
      desiredState: 'publish',
      templatePath: `${THEME_NAME}/templates/home.html`,
    }));

    assert.deepEqual(sourceRepairability(root, { blogSlug: 'blog', themeName: THEME_NAME }), {
      blogTemplates: true,
      homepage: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------- gatherProbes (mocked hub, no network) ----------------

test('gatherProbes: builds probe shapes from a mocked hub', async () => {
  const acct = { name: 'dev', portalId: '246389711', key: 'k' };
  const seen = [];
  const hubMock = async (a, method, path) => {
    seen.push(`${method} ${path}`);
    if (path.startsWith('/content/api/v2/blogs')) {
      return {
        ok: true,
        status: 200,
        json: {
          objects: [
            { slug: 'blog', item_template_path: `${THEME_NAME}/t/post.html`, listing_template_path: `${THEME_NAME}/t/list.html` },
            { slug: 'blog-old-pages', item_template_path: 'old/x.html', listing_template_path: 'old/y.html' },
          ],
        },
      };
    }
    if (path.startsWith('/cms/v3/pages/site-pages')) {
      return { ok: true, status: 200, json: { results: [{ slug: '' }, { slug: 'about' }] } };
    }
    if (path.startsWith('/forms/v2/forms')) return { ok: true, status: 200, json: [] };
    if (path.startsWith('/files/v3/files/search')) return { ok: true, status: 200, json: { results: [] } };
    if (path.startsWith('/cms/v3/domains')) return { ok: true, status: 200, json: { results: [{ domain: 'd.com', isResolving: true }] } };
    return { ok: true, status: 200, json: {} };
  };

  const probes = await gatherProbes(acct, { blogSlug: 'blog', hub: hubMock });
  assert.equal(probes.blog.found, true);
  assert.equal(probes.blog.itemTemplatePath, `${THEME_NAME}/t/post.html`);
  assert.equal(probes.homepage.found, true);
  assert.equal(probes.scopes.forms.denied, false);
  assert.equal(probes.scopes.files.denied, false);
  assert.equal(probes.domains.list[0].domain, 'd.com');

  // The gathered probes flow straight into a ready evaluation.
  const e = evaluateReadiness(probes, { blogSlug: 'blog' });
  assert.equal(e.ready, true);
});

test('gatherProbes: a 403 on forms is captured as a denied scope (no throw)', async () => {
  const acct = { name: 'dev', portalId: '246389711', key: 'k' };
  const hubMock = async (a, method, path) => {
    if (path.startsWith('/forms/v2/forms')) return { ok: false, status: 403, json: { message: 'no forms scope' } };
    if (path.startsWith('/content/api/v2/blogs')) return { ok: true, status: 200, json: { objects: [] } };
    if (path.startsWith('/cms/v3/pages/site-pages')) return { ok: true, status: 200, json: { results: [] } };
    if (path.startsWith('/files/v3/files/search')) return { ok: true, status: 200, json: { results: [] } };
    if (path.startsWith('/cms/v3/domains')) return { ok: true, status: 200, json: { results: [] } };
    return { ok: true, status: 200, json: {} };
  };
  const probes = await gatherProbes(acct, { blogSlug: 'blog', hub: hubMock });
  assert.equal(probes.scopes.forms.denied, true);
  const e = evaluateReadiness(probes, { blogSlug: 'blog' });
  assert.equal(e.ready, false);
  // blog missing, homepage missing, scopes missing forms
  assert.deepEqual(failIds(e), ['blog-container', 'homepage', 'scopes']);
});

// ---------------- PRODUCTION guard ----------------

test('main: refuses to run against the production portal (exit 3)', async () => {
  // Point the key dir at a temp dir holding a prod key so account('prod') resolves.
  const dir = mkdtempSync(join(tmpdir(), 'hubkeys-'));
  const prev = process.env.HUBSPOT_KEY_DIR;
  process.env.HUBSPOT_KEY_DIR = dir;
  const origWrite = process.stderr.write;
  let err = '';
  process.stderr.write = (s) => { err += s; return true; };
  try {
    writeFileSync(join(dir, `${PROD_PORTAL_ID}.key`), 'pat-prod\n');
    const code = await main(['prod'], {
      config: {
        accountsPath: join(__dirname, '..', 'fixtures', 'config', 'accounts.json'),
        keyDir: dir,
        readOnlyPortalIds: [PROD_PORTAL_ID],
      },
    });
    assert.equal(code, 3);
    assert.match(err, /Refusing to run/);
    assert.match(err, new RegExp(`read-only portal ${PROD_PORTAL_ID}`));
  } finally {
    process.stderr.write = origWrite;
    if (prev === undefined) delete process.env.HUBSPOT_KEY_DIR;
    else process.env.HUBSPOT_KEY_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main: usage error (no account arg) exits 2', async () => {
  const origWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    const code = await main([]);
    assert.equal(code, 2);
  } finally {
    process.stderr.write = origWrite;
  }
});
