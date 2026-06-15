// Unit tests for the landing-pages adapter — a thin instantiation of the shared
// page-sync core. Verifies it targets the LANDING-PAGES endpoint, the
// content/landing-pages subdir, and the manifest "landingPages" key (not "pages").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { name, dependsOn, pull, push } from '../../src/adapters/landing-pages.mjs';
import { emptyRegistry } from '../../src/lib/refs.mjs';

const ACCT = { name: 'dev', portalId: '246389711', key: 'k' };

test('landing-pages adapter metadata', () => {
  assert.equal(name, 'landing-pages');
  assert.deepEqual(dependsOn, ['forms', 'assets']);
});

test('pull reads the LANDING-PAGES endpoint and writes content/landing-pages/<slug>.json', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lp-'));
  const contentDir = join(root, 'content');
  mkdirSync(contentDir, { recursive: true });
  // Manifest at repo root lists landingPages (NOT pages).
  writeFileSync(join(root, 'site.manifest.json'), JSON.stringify({
    landingPages: [{ slug: 'try-it-free', desiredState: 'publish' }],
    pages: [{ slug: 'about', desiredState: 'publish' }],
  }));

  let endpointHit = null;
  const getAll = async (acct, path) => {
    endpointHit = path;
    return [
      { slug: 'try-it-free', name: 'Try', currentState: 'PUBLISHED', id: '1' },
      { slug: 'about', name: 'About', currentState: 'PUBLISHED', id: '2' }, // a site page -> not in landingPages -> skipped
    ];
  };
  try {
    const res = await pull(ACCT, { contentDir, registry: emptyRegistry('246389711'), getAll });
    assert.equal(endpointHit, '/cms/v3/pages/landing-pages', 'pulls the landing-pages endpoint');
    assert.equal(res.pulled, 1, 'only the manifest-listed landing page is pulled');
    const files = readdirSync(join(contentDir, 'landing-pages'));
    assert.deepEqual(files, ['try-it-free.json']);
    const written = JSON.parse(readFileSync(join(contentDir, 'landing-pages', 'try-it-free.json'), 'utf8'));
    assert.equal(written.slug, 'try-it-free');
    assert.equal(written.desiredState, 'publish');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('push targets the landing-pages endpoint + landingPages manifest, schedules publish', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lp-push-'));
  const contentDir = join(root, 'content');
  const lpDir = join(contentDir, 'landing-pages');
  mkdirSync(lpDir, { recursive: true });
  writeFileSync(join(root, 'site.manifest.json'), JSON.stringify({
    landingPages: [{ slug: 'try-it-free', desiredState: 'publish' }],
  }));
  writeFileSync(join(lpDir, 'try-it-free.json'), JSON.stringify({
    slug: 'try-it-free', name: 'Try It Free', htmlTitle: 'Try', metaDescription: '', language: 'en',
    templatePath: 'templates/lp.html', desiredState: 'publish',
  }));

  const calls = [];
  const hub = async (acct, method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'POST' && path === '/cms/v3/pages/landing-pages') return { ok: true, status: 200, json: { id: 'LP1' } };
    if (method === 'POST' && path === '/cms/v3/pages/landing-pages/schedule') return { ok: true, status: 204, json: {} };
    return { ok: true, status: 200, json: {} };
  };
  const resolvePageId = async () => null; // not present -> create
  try {
    const res = await push(ACCT, { contentDir, registry: emptyRegistry('246389711'), hub, resolvePageId, now: 1_000_000 });
    assert.equal(res.pushed, 1);
    assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/cms/v3/pages/landing-pages'), 'created via landing-pages endpoint');
    assert.ok(calls.some((c) => c.path === '/cms/v3/pages/landing-pages/schedule'), 'scheduled via landing-pages endpoint');
    // Never touches the site-pages endpoint.
    assert.ok(!calls.some((c) => c.path.includes('site-pages')), 'site-pages endpoint untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('push is a clean NO-OP when there are no landingPages (not a hard error like site-pages)', async () => {
  // Unlike site-pages, an absent/empty landingPages list legitimately means "this site
  // has none". The orchestrator runs this adapter unconditionally, so it must no-op,
  // never abort the whole push.
  const root = mkdtempSync(join(tmpdir(), 'lp-err-'));
  const contentDir = join(root, 'content');
  mkdirSync(join(contentDir, 'landing-pages'), { recursive: true });
  writeFileSync(join(root, 'site.manifest.json'), JSON.stringify({ pages: [{ slug: '', desiredState: 'publish' }] })); // no landingPages key
  const calls = [];
  const hub = async (a, m, p, b) => { calls.push({ m, p }); return { ok: true, status: 200, json: {} }; };
  try {
    const res = await push(ACCT, { contentDir, registry: emptyRegistry('246389711'), hub });
    assert.equal(res.pushed, 0, 'nothing pushed');
    assert.ok(res.notes.some((n) => /no landingPages/.test(n)), 'explains the no-op');
    assert.ok(!calls.some((c) => c.m === 'POST'), 'no writes attempted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
