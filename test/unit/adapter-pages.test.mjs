// Unit tests for sync/adapters/pages.mjs — NO real network, NO real disk.
// hub/getAll/fs are injected via the adapter's ctx hooks; the registry is a
// plain refs.mjs Registry built in-memory.
//
//   node --test test/unit/adapter-pages.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  name,
  dependsOn,
  isABVariant,
  isArchived,
  isTempSlug,
  isPortablePage,
  buildPagePayload,
  pull,
  push,
} from '../../src/adapters/pages.mjs';
import { emptyRegistry } from '../../src/lib/refs.mjs';

// ── helpers ────────────────────────────────────────────────────────────────

// In-memory manifest + page files keyed by a fake contentDir. The adapter reads
// the manifest from <contentDir>/../site.manifest.json, so we stub the loader by
// pointing readDir/readFileText at an in-memory tree AND providing a manifest
// through a tiny fs shim. Simpler: we drive pull/push entirely through the ctx
// hooks and stub loadManifestPages indirectly via a temp dir.
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Build a temp repo with content/ + site.manifest.json, returns { contentDir }.
// `fn` is async; we MUST await it before tearing down (else rmSync would delete
// the tree out from under the still-running adapter).
async function withRepo(manifest, pageFiles, fn) {
  const root = mkdtempSync(join(tmpdir(), 'pages-adapter-'));
  const contentDir = join(root, 'content');
  mkdirSync(join(contentDir, 'pages'), { recursive: true });
  if (manifest) writeFileSync(join(root, 'site.manifest.json'), JSON.stringify(manifest));
  for (const [fileName, body] of Object.entries(pageFiles || {})) {
    writeFileSync(join(contentDir, 'pages', fileName), typeof body === 'string' ? body : JSON.stringify(body));
  }
  try {
    return await fn({ contentDir, root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const ACCT = { name: 'dev', portalId: '246389711', key: 'k' };

// ── adapter contract ────────────────────────────────────────────────────────

test('exports the adapter interface', () => {
  assert.equal(name, 'pages');
  assert.ok(Array.isArray(dependsOn));
  assert.equal(typeof pull, 'function');
  assert.equal(typeof push, 'function');
});

// ── junk filters (codex #9) ─────────────────────────────────────────────────

test('isABVariant catches LOSER_AB_VARIANT / DRAFT_AB / abTestId', () => {
  assert.ok(isABVariant({ currentState: 'LOSER_AB_VARIANT' }));
  assert.ok(isABVariant({ state: 'DRAFT_AB' }));
  assert.ok(isABVariant({ abTestId: '6202485638' }));
  assert.ok(isABVariant({ abStatus: 'loser_variant' }));
  assert.ok(!isABVariant({ currentState: 'PUBLISHED' }));
  assert.ok(!isABVariant({ slug: 'about' }));
});

test('isArchived catches archivedInDashboard and a real archivedAt', () => {
  assert.ok(isArchived({ archivedInDashboard: true }));
  assert.ok(isArchived({ archivedAt: '2020-02-07T21:12:54.294Z' }));
  // 1970 epoch sentinel = "never archived"
  assert.ok(!isArchived({ archivedAt: '1970-01-01T00:00:00Z' }));
  assert.ok(!isArchived({ archivedInDashboard: false }));
});

test('isTempSlug catches temporary-slug/guid/ab-variant/archived/old, never the homepage', () => {
  assert.ok(isTempSlug('-temporary-slug-0bd9fbff-812f-4635-837f-13002a8e9af8'));
  assert.ok(isTempSlug('-88e6f13e-88d7-43d4-918d-d03c3090543b'));
  assert.ok(isTempSlug('-ab-variant-0ecf030f-9093-4481-8eb1-529f28647498'));
  assert.ok(isTempSlug('-archived-1'));
  assert.ok(isTempSlug('-old2'));
  assert.ok(!isTempSlug('')); // homepage
  assert.ok(!isTempSlug('about'));
  assert.ok(!isTempSlug('agency-partner-program'));
});

test('isPortablePage combines all three filters', () => {
  assert.ok(isPortablePage({ slug: 'about', currentState: 'PUBLISHED' }));
  assert.ok(!isPortablePage({ slug: 'about', currentState: 'LOSER_AB_VARIANT' }));
  assert.ok(!isPortablePage({ slug: '-temporary-slug-x' }));
  assert.ok(!isPortablePage({ slug: 'about', archivedInDashboard: true }));
});

// ── PULL: canonicalization strips volatile + logical-izes refs ──────────────

test('pull projects the definition, strips volatile fields, and writes desiredState', async () => {
  const written = {};
  const registry = emptyRegistry();
  // A realistic raw page with all the volatile noise + an embedded prod hubfs
  // featuredImage url that must become an @asset token.
  const rawPage = {
    id: '194241952782',
    slug: 'agency-partner-program',
    name: 'Seventh Sense | For Agencies',
    htmlTitle: 'Seventh Sense | For Agencies',
    metaDescription: 'desc',
    language: 'en',
    templatePath: 'templates/about.html',
    domain: 'www.theseventhsense.com',
    url: 'https://www.theseventhsense.com/agency-partner-program',
    currentState: 'PUBLISHED',
    state: 'PUBLISHED',
    publishDate: '2025-08-11T07:15:32Z',
    createdAt: '2025-08-11T07:15:32.666Z',
    updatedAt: '2025-09-01T00:00:00.000Z',
    createdById: '63716374',
    updatedById: '63716374',
    archivedAt: '1970-01-01T00:00:00Z',
    // canonicalPage() projects a definition allow-list and drops featuredImage,
    // so the portable per-account ref we exercise lives inside a SURVIVING field:
    // the widget carrier body (kept verbatim). The image url + portal id there
    // must be logical-ized.
    featuredImage: 'https://529456.fs1.hubspotusercontent-na1.net/hubfs/529456/for%20agencies.png',
    widgets: {
      hero: {
        body: { headline: 'hi', bg: 'https://529456.fs1.hubspotusercontent-na1.net/hubfs/529456/for%20agencies.png' },
        name: 'hero',
        type: 'module',
        label: '',
        css: {},
        child_css: {},
      },
    },
  };

  await withRepo(
    { pages: [{ slug: 'agency-partner-program', desiredState: 'publish' }] },
    {},
    async ({ contentDir }) => {
      const res = await pull(ACCT, {
        contentDir,
        registry,
        getAll: async () => [rawPage],
        writeFile: async (path, text) => {
          written[path] = text;
        },
      });
      assert.equal(res.pulled, 1);
    },
  );

  const out = Object.values(written)[0];
  assert.ok(out, 'a file was written');
  const obj = JSON.parse(out);

  // desiredState came from the manifest, not inferred.
  assert.equal(obj.desiredState, 'publish');

  // Definition fields kept.
  assert.equal(obj.slug, 'agency-partner-program');
  assert.equal(obj.htmlTitle, 'Seventh Sense | For Agencies');
  assert.equal(obj.templatePath, 'templates/about.html');
  assert.equal(obj.language, 'en');

  // Volatile / per-account fields stripped (canonicalPage projects an allow-list).
  for (const k of ['id', 'url', 'domain', 'currentState', 'state', 'publishDate', 'createdAt', 'updatedAt', 'createdById', 'updatedById', 'archivedAt']) {
    assert.ok(!(k in obj), `volatile key "${k}" must be stripped`);
  }

  // The serialized output must carry NO raw prod portal id and NO raw hubfs url.
  assert.ok(!out.includes('529456'), 'no raw portal id survives');
  assert.ok(!out.includes('hubspotusercontent'), 'no raw hubfs url survives');

  // The asset became a logical @asset token AND was registered into this acct's registry.
  assert.ok(out.includes('@asset:'), 'hubfs url became an @asset token');
  assert.ok(Object.keys(registry.assets).length > 0, 'asset registered into registry');
});

test('pull keeps only manifest-listed pages and excludes AB/archived/temp junk', async () => {
  const written = {};
  const registry = emptyRegistry();
  const raws = [
    { slug: 'about', name: 'About', htmlTitle: 'About', templatePath: 'templates/about.html', currentState: 'PUBLISHED' },
    { slug: 'secret', name: 'Secret', htmlTitle: 'Secret', templatePath: 'templates/about.html', currentState: 'PUBLISHED' }, // not in manifest
    { slug: 'about-loser', name: 'X', currentState: 'LOSER_AB_VARIANT' }, // AB junk (also not in manifest)
    { slug: '-temporary-slug-abc', name: 'Y', currentState: 'DRAFT' }, // temp junk
  ];

  await withRepo(
    { pages: [{ slug: 'about', desiredState: 'publish' }] },
    {},
    async ({ contentDir }) => {
      const res = await pull(ACCT, {
        contentDir,
        registry,
        getAll: async () => raws,
        writeFile: async (path, text) => {
          written[path] = text;
        },
      });
      assert.equal(res.pulled, 1, 'only the manifest-listed portable page is pulled');
    },
  );

  const files = Object.keys(written).map((p) => p.split('/').pop());
  assert.deepEqual(files, ['about.json']);
});

test('pull maps homepage empty slug to home.json with desiredState', async () => {
  const written = {};
  const registry = emptyRegistry();
  await withRepo(
    { pages: [{ slug: '', desiredState: 'publish' }] },
    {},
    async ({ contentDir }) => {
      await pull(ACCT, {
        contentDir,
        registry,
        getAll: async () => [{ slug: '', name: 'Home', htmlTitle: 'Home', templatePath: 'templates/home.html', currentState: 'PUBLISHED' }],
        writeFile: async (path, text) => {
          written[path] = text;
        },
      });
    },
  );
  const file = Object.keys(written)[0];
  assert.ok(file.endsWith('/home.json'), `homepage -> home.json (got ${file})`);
  assert.equal(JSON.parse(written[file]).slug, '');
});

// ── buildPagePayload (pure) ─────────────────────────────────────────────────

test('buildPagePayload projects only definition fields and drops leading slash on templatePath', () => {
  const p = buildPagePayload({
    slug: 'about',
    name: 'About',
    htmlTitle: 'About | SS',
    metaDescription: 'd',
    language: 'en',
    templatePath: '/templates/about.html',
    headHtml: '<meta>',
    footerHtml: '',
    linkRelCanonicalUrl: 'https://x/about',
    featuredImage: '@asset:og.png',
    featuredImageAltText: 'og',
    useFeaturedImage: true,
    widgets: { hero: {} }, // must NOT appear
    id: 'x', // must NOT appear
  });
  assert.deepEqual(p, {
    slug: 'about',
    name: 'About',
    htmlTitle: 'About | SS',
    metaDescription: 'd',
    language: 'en',
    templatePath: 'templates/about.html', // leading slash stripped
    headHtml: '<meta>',
    footerHtml: '',
    linkRelCanonicalUrl: 'https://x/about',
    featuredImage: '@asset:og.png',
    featuredImageAltText: 'og',
    useFeaturedImage: true,
  });
  assert.ok(!('widgets' in p) && !('id' in p), 'widgets + volatile id never pushed by this adapter');
});

// ── PUSH: create-vs-update decision by slug, via stubbed hub ─────────────────

// Build a hub stub that records calls and answers create/update/schedule.
function hubStub({ existingIdForSlug = {}, createId = 'NEW-1' } = {}) {
  const calls = [];
  const hub = async (acct, method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'POST' && path === '/cms/v3/pages/site-pages') {
      return { ok: true, status: 201, json: { id: createId } };
    }
    if (method === 'PATCH' && /\/draft$/.test(path)) {
      return { ok: true, status: 200, json: {} };
    }
    if (method === 'POST' && path === '/cms/v3/pages/site-pages/schedule') {
      return { ok: true, status: 204, json: {} };
    }
    return { ok: false, status: 500, json: { message: 'unexpected ' + method + ' ' + path } };
  };
  const resolvePageId = async (slug) => existingIdForSlug[slug] ?? null;
  return { hub, resolvePageId, calls };
}

test('push CREATES (POST) when the slug does not exist, then schedules publish', async () => {
  const registry = emptyRegistry('246389711');
  const { hub, resolvePageId, calls } = hubStub({ existingIdForSlug: {} });

  await withRepo(
    { pages: [{ slug: 'about', desiredState: 'publish' }] },
    {
      'about.json': {
        slug: 'about',
        name: 'About',
        htmlTitle: 'About | SS',
        metaDescription: 'd',
        language: 'en',
        templatePath: 'templates/about.html',
        desiredState: 'publish',
      },
    },
    async ({ contentDir }) => {
      const res = await push(ACCT, { contentDir, registry, hub, resolvePageId, now: 1_700_000_000_000 });
      assert.equal(res.pushed, 1);
    },
  );

  const create = calls.find((c) => c.method === 'POST' && c.path === '/cms/v3/pages/site-pages');
  assert.ok(create, 'a CREATE POST was issued');
  assert.equal(create.body.slug, 'about');
  assert.equal(create.body.templatePath, 'templates/about.html');
  assert.ok(!('id' in create.body) && !('widgets' in create.body), 'no volatile/widget fields in body');

  // No PATCH should have happened (page did not exist).
  assert.ok(!calls.some((c) => c.method === 'PATCH'), 'no PATCH on create path');

  // Publish via schedule with a future .000Z date.
  const sched = calls.find((c) => c.path === '/cms/v3/pages/site-pages/schedule');
  assert.ok(sched, 'schedule was called for a publish page');
  assert.equal(sched.body.id, 'NEW-1');
  assert.match(sched.body.publishDate, /\.000Z$/);
});

test('push UPDATES (PATCH /{id}/draft) when the slug already exists — idempotent by slug', async () => {
  const registry = emptyRegistry('246389711');
  const { hub, resolvePageId, calls } = hubStub({ existingIdForSlug: { about: '999' } });

  await withRepo(
    { pages: [{ slug: 'about', desiredState: 'publish' }] },
    {
      'about.json': {
        slug: 'about',
        name: 'About',
        htmlTitle: 'About | SS',
        metaDescription: 'd2',
        language: 'en',
        templatePath: 'templates/about.html',
        desiredState: 'publish',
      },
    },
    async ({ contentDir }) => {
      await push(ACCT, { contentDir, registry, hub, resolvePageId, now: 1_700_000_000_000 });
    },
  );

  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch, 'a PATCH /draft was issued');
  assert.equal(patch.path, '/cms/v3/pages/site-pages/999/draft');
  assert.equal(patch.body.metaDescription, 'd2');

  // No CREATE on update path.
  assert.ok(!calls.some((c) => c.method === 'POST' && c.path === '/cms/v3/pages/site-pages'), 'no CREATE on update path');
});

test('a SECOND identical pages.push is idempotent: same UPDATE set, ZERO creates, no duplicate pages', async () => {
  // Models a real re-push against the same portal: the FIRST push creates pages
  // that do not yet exist; once created they are resolvable by slug, so the
  // SECOND identical push must find every page and PATCH-in-place — never POST a
  // duplicate. We emulate the portal's growing state with a mutable slug->id map
  // that the create populates (mirroring resolvePageBySlug after a create).
  const registry = emptyRegistry('246389711');
  const calls = [];
  const existingIdForSlug = {}; // starts empty (nothing on the portal yet)
  let nextId = 1;
  const hub = async (acct, method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'POST' && path === '/cms/v3/pages/site-pages') {
      // mint an id AND register it by slug, so a later resolve finds it
      const id = `ID-${nextId++}`;
      existingIdForSlug[body.slug] = id;
      return { ok: true, status: 201, json: { id } };
    }
    if (method === 'PATCH' && /\/draft$/.test(path)) return { ok: true, status: 200, json: {} };
    if (method === 'POST' && path === '/cms/v3/pages/site-pages/schedule') return { ok: true, status: 204, json: {} };
    return { ok: false, status: 500, json: { message: 'unexpected ' + method + ' ' + path } };
  };
  // resolve reads the LIVE (mutating) map each call, like a real portal listing.
  const resolvePageId = async (slug) => existingIdForSlug[slug] ?? null;

  const manifest = {
    pages: [
      { slug: '', desiredState: 'publish' },
      { slug: 'about', desiredState: 'publish' },
      { slug: 'pricing', desiredState: 'draft' },
    ],
  };
  const def = (slug, name) => ({
    slug,
    name,
    htmlTitle: `${name} | SS`,
    metaDescription: `${name} desc`,
    language: 'en',
    templatePath: 'templates/p.html',
    desiredState: slug === 'pricing' ? 'draft' : 'publish',
  });
  const files = {
    'home.json': def('', 'Home'),
    'about.json': def('about', 'About'),
    'pricing.json': def('pricing', 'Pricing'),
  };

  await withRepo(manifest, files, async ({ contentDir }) => {
    // FIRST push: nothing exists -> three CREATEs.
    const r1 = await push(ACCT, { contentDir, registry, hub, resolvePageId, now: 1_700_000_000_000 });
    assert.equal(r1.pushed, 3);
    const creates1 = calls.filter((c) => c.method === 'POST' && c.path === '/cms/v3/pages/site-pages');
    assert.equal(creates1.length, 3, 'first push creates all three pages');
    assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0, 'no PATCH on the first (create) run');

    const beforeSecond = calls.length;

    // SECOND identical push: every page now exists -> three PATCHes, ZERO creates.
    const r2 = await push(ACCT, { contentDir, registry, hub, resolvePageId, now: 1_700_000_000_000 });
    assert.equal(r2.pushed, 3, 'second push touches the same three pages');

    const secondCalls = calls.slice(beforeSecond);
    const creates2 = secondCalls.filter((c) => c.method === 'POST' && c.path === '/cms/v3/pages/site-pages');
    assert.equal(creates2.length, 0, 'idempotent: a re-push creates ZERO duplicate pages');

    const patches2 = secondCalls.filter((c) => c.method === 'PATCH');
    assert.equal(patches2.length, 3, 'second push updates all three IN PLACE');
    // each PATCH targets the id minted on the first run (update-in-place, by slug)
    const patchedPaths = patches2.map((c) => c.path).sort();
    assert.deepEqual(patchedPaths, [
      '/cms/v3/pages/site-pages/ID-1/draft',
      '/cms/v3/pages/site-pages/ID-2/draft',
      '/cms/v3/pages/site-pages/ID-3/draft',
    ]);
    // the two publish pages are scheduled on BOTH runs (re-publish is idempotent);
    // the draft page is never scheduled, on either run.
    const sched2 = secondCalls.filter((c) => c.path === '/cms/v3/pages/site-pages/schedule');
    assert.equal(sched2.length, 2, 'only the two publish pages re-schedule; the draft does not');
  });
});

test('push does NOT schedule pages with desiredState other than publish', async () => {
  const registry = emptyRegistry('246389711');
  const { hub, resolvePageId, calls } = hubStub({ existingIdForSlug: { about: '999' } });

  await withRepo(
    { pages: [{ slug: 'about', desiredState: 'draft' }] },
    {
      'about.json': {
        slug: 'about',
        name: 'About',
        htmlTitle: 'About',
        metaDescription: 'd',
        language: 'en',
        templatePath: 'templates/about.html',
        desiredState: 'draft',
      },
    },
    async ({ contentDir }) => {
      await push(ACCT, { contentDir, registry, hub, resolvePageId });
    },
  );

  assert.ok(calls.some((c) => c.method === 'PATCH'), 'draft page is still written (PATCH)');
  assert.ok(!calls.some((c) => c.path === '/cms/v3/pages/site-pages/schedule'), 'draft page is NOT scheduled');
});

test('push skips files not listed in the manifest', async () => {
  const registry = emptyRegistry('246389711');
  const { hub, resolvePageId, calls } = hubStub({ existingIdForSlug: {} });

  await withRepo(
    { pages: [{ slug: 'about', desiredState: 'publish' }] },
    {
      'about.json': { slug: 'about', name: 'A', htmlTitle: 'A', templatePath: 'templates/about.html', language: 'en' },
      'rogue.json': { slug: 'rogue', name: 'R', htmlTitle: 'R', templatePath: 'templates/about.html', language: 'en' },
    },
    async ({ contentDir }) => {
      const res = await push(ACCT, { contentDir, registry, hub, resolvePageId, now: 1_700_000_000_000 });
      assert.equal(res.pushed, 1, 'only the manifest-listed page is pushed');
    },
  );
  assert.ok(!calls.some((c) => c.body && c.body.slug === 'rogue'), 'rogue.json never pushed');
});

test('push hard-fails on an unresolved @logical ref (no network write proceeds)', async () => {
  // Registry has NO mapping for @form:contact -> resolve() throws.
  const registry = emptyRegistry('246389711');
  const { hub, resolvePageId, calls } = hubStub({ existingIdForSlug: {} });

  await withRepo(
    { pages: [{ slug: 'about', desiredState: 'publish' }] },
    {
      // headHtml carries an unresolved @form token.
      'about.json':
        '{\n  "slug": "about",\n  "name": "A",\n  "htmlTitle": "A",\n  "language": "en",\n  "templatePath": "templates/about.html",\n  "headHtml": "@form:contact",\n  "desiredState": "publish"\n}\n',
    },
    async ({ contentDir }) => {
      await assert.rejects(
        () => push(ACCT, { contentDir, registry, hub, resolvePageId }),
        /@form:contact|no mapping/,
      );
    },
  );
  assert.equal(calls.length, 0, 'no hub calls before the ref-resolution failure');
});

test('push throws when site.manifest.json lists no pages (manifest is the only push list)', async () => {
  const registry = emptyRegistry('246389711');
  const { hub, resolvePageId } = hubStub({});
  await withRepo(
    { pages: [] },
    { 'about.json': { slug: 'about', name: 'A', htmlTitle: 'A', templatePath: 'templates/about.html' } },
    async ({ contentDir }) => {
      await assert.rejects(() => push(ACCT, { contentDir, registry, hub, resolvePageId }), /only push list/);
    },
  );
});

test('push throws CONTENT_TITLE_MISSING guard when name and htmlTitle are both empty', async () => {
  const registry = emptyRegistry('246389711');
  const { hub, resolvePageId } = hubStub({ existingIdForSlug: { about: '1' } });
  await withRepo(
    { pages: [{ slug: 'about', desiredState: 'publish' }] },
    { 'about.json': { slug: 'about', name: '', htmlTitle: '', language: 'en', templatePath: 'templates/about.html' } },
    async ({ contentDir }) => {
      await assert.rejects(() => push(ACCT, { contentDir, registry, hub, resolvePageId }), /CONTENT_TITLE_MISSING/);
    },
  );
});

test('push REJECTS a file whose body slug disagrees with its filename slug and makes ZERO hub calls', async () => {
  // A hand-edit left about.json's body slug as "different" while the filename is
  // about.json (filename slug "about"). The manifest gates on the FILENAME slug,
  // but create-vs-update keys off the BODY slug — pushing would risk minting a
  // DUPLICATE page. push() must fail closed BEFORE any create/update hub call.
  const registry = emptyRegistry('246389711');
  const { hub, resolvePageId, calls } = hubStub({ existingIdForSlug: { about: '999' } });

  await withRepo(
    { pages: [{ slug: 'about', desiredState: 'publish' }] },
    {
      'about.json': {
        slug: 'different',
        name: 'About',
        htmlTitle: 'About | SS',
        metaDescription: 'd',
        language: 'en',
        templatePath: 'templates/about.html',
        desiredState: 'publish',
      },
    },
    async ({ contentDir }) => {
      await assert.rejects(
        () => push(ACCT, { contentDir, registry, hub, resolvePageId, now: 1_700_000_000_000 }),
        /body slug "different" != filename slug "about"/,
      );
    },
  );

  // Fail-closed: NO create, NO update, NO schedule — zero hub calls of any kind.
  assert.ok(!calls.some((c) => c.method === 'POST' && c.path === '/cms/v3/pages/site-pages'), 'no CREATE on slug skew');
  assert.ok(!calls.some((c) => c.method === 'PATCH'), 'no UPDATE on slug skew');
  assert.ok(!calls.some((c) => c.path === '/cms/v3/pages/site-pages/schedule'), 'no schedule on slug skew');
});

// ── PUSH: archive state — written as a draft, never force-published ──────────

test('push writes an archive page as a draft (PATCH) and NEVER schedules it', async () => {
  const registry = emptyRegistry('246389711');
  const { hub, resolvePageId, calls } = hubStub({ existingIdForSlug: { 'old-page': '777' } });

  await withRepo(
    { pages: [{ slug: 'old-page', desiredState: 'archive' }] },
    {
      'old-page.json': {
        slug: 'old-page',
        name: 'Old Page',
        htmlTitle: 'Old Page',
        metaDescription: 'd',
        language: 'en',
        templatePath: 'templates/about.html',
        desiredState: 'archive',
      },
    },
    async ({ contentDir }) => {
      const res = await push(ACCT, { contentDir, registry, hub, resolvePageId, now: 1_700_000_000_000 });
      assert.equal(res.pushed, 1, 'an archive page is still written (as a draft)');
    },
  );

  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch, 'archive page is written as a draft (PATCH /draft)');
  assert.equal(patch.path, '/cms/v3/pages/site-pages/777/draft');
  assert.ok(
    !calls.some((c) => c.path === '/cms/v3/pages/site-pages/schedule'),
    'archive page must NOT be force-published via schedule',
  );
});

test('push CREATES a never-seen archive page as a draft but does not publish it', async () => {
  const registry = emptyRegistry('246389711');
  const { hub, resolvePageId, calls } = hubStub({ existingIdForSlug: {} });

  await withRepo(
    { pages: [{ slug: 'fresh-archive', desiredState: 'archive' }] },
    {
      'fresh-archive.json': {
        slug: 'fresh-archive',
        name: 'Fresh',
        htmlTitle: 'Fresh',
        language: 'en',
        templatePath: 'templates/about.html',
        desiredState: 'archive',
      },
    },
    async ({ contentDir }) => {
      await push(ACCT, { contentDir, registry, hub, resolvePageId, now: 1_700_000_000_000 });
    },
  );

  assert.ok(
    calls.some((c) => c.method === 'POST' && c.path === '/cms/v3/pages/site-pages'),
    'a brand-new archive page is created as a draft',
  );
  assert.ok(
    !calls.some((c) => c.path === '/cms/v3/pages/site-pages/schedule'),
    'a freshly-created archive page is never scheduled for publish',
  );
});

// ── PUSH: ignore state — never touches HubSpot at all ───────────────────────

test('push skips an ignore page entirely: no PATCH, no POST, no schedule', async () => {
  const registry = emptyRegistry('246389711');
  const { hub, resolvePageId, calls } = hubStub({ existingIdForSlug: { hidden: '555' } });

  await withRepo(
    { pages: [{ slug: 'hidden', desiredState: 'ignore' }] },
    {
      'hidden.json': {
        slug: 'hidden',
        name: 'Hidden',
        htmlTitle: 'Hidden',
        language: 'en',
        templatePath: 'templates/about.html',
        desiredState: 'ignore',
      },
    },
    async ({ contentDir }) => {
      const res = await push(ACCT, { contentDir, registry, hub, resolvePageId, now: 1_700_000_000_000 });
      assert.equal(res.pushed, 0, 'an ignore page is never pushed');
    },
  );

  assert.equal(calls.length, 0, 'an ignore page makes zero hub calls');
});

test('an ignore page with an UNRESOLVED @logical ref does NOT block the push of valid pages', async () => {
  // Robustness: the ignore-skip must happen BEFORE resolve(), so a junk ref in
  // an ignored file can never abort the whole push. 'about' must still publish.
  const registry = emptyRegistry('246389711');
  const { hub, resolvePageId, calls } = hubStub({ existingIdForSlug: { about: '111' } });

  await withRepo(
    {
      pages: [
        { slug: 'about', desiredState: 'publish' },
        { slug: 'hidden', desiredState: 'ignore' },
      ],
    },
    {
      'about.json': {
        slug: 'about',
        name: 'About',
        htmlTitle: 'About',
        language: 'en',
        templatePath: 'templates/about.html',
        desiredState: 'publish',
      },
      // hidden.json carries an unmapped @form token that resolve() would throw on.
      'hidden.json':
        '{\n  "slug": "hidden",\n  "name": "H",\n  "htmlTitle": "H",\n  "language": "en",\n  "templatePath": "templates/about.html",\n  "headHtml": "@form:contact",\n  "desiredState": "ignore"\n}\n',
    },
    async ({ contentDir }) => {
      const res = await push(ACCT, { contentDir, registry, hub, resolvePageId, now: 1_700_000_000_000 });
      assert.equal(res.pushed, 1, 'the valid publish page still pushes; the ignore junk is skipped');
    },
  );

  assert.ok(calls.some((c) => c.method === 'PATCH'), 'about was updated');
  assert.ok(calls.some((c) => c.path === '/cms/v3/pages/site-pages/schedule'), 'about was scheduled');
});

// ── PUSH: refuse when the manifest FILE is entirely absent ───────────────────

test('push refuses when site.manifest.json does not exist at all', async () => {
  const registry = emptyRegistry('246389711');
  const { hub, resolvePageId, calls } = hubStub({});
  // Pass `null` for the manifest so withRepo writes NO site.manifest.json file.
  await withRepo(
    null,
    { 'about.json': { slug: 'about', name: 'A', htmlTitle: 'A', templatePath: 'templates/about.html' } },
    async ({ contentDir }) => {
      await assert.rejects(() => push(ACCT, { contentDir, registry, hub, resolvePageId }), /only push list/);
    },
  );
  assert.equal(calls.length, 0, 'no hub calls when the manifest is missing');
});

// ── PULL: archive / ignore desiredState carried from the manifest ────────────

test('pull carries desiredState=archive from the manifest onto the page file', async () => {
  const written = {};
  const registry = emptyRegistry();
  await withRepo(
    { pages: [{ slug: 'old-page', desiredState: 'archive' }] },
    {},
    async ({ contentDir }) => {
      const res = await pull(ACCT, {
        contentDir,
        registry,
        getAll: async () => [
          { slug: 'old-page', name: 'Old', htmlTitle: 'Old', templatePath: 'templates/about.html', currentState: 'PUBLISHED' },
        ],
        writeFile: async (path, text) => {
          written[path] = text;
        },
      });
      assert.equal(res.pulled, 1);
    },
  );
  const obj = JSON.parse(Object.values(written)[0]);
  assert.equal(obj.desiredState, 'archive', 'archive desiredState is written, not inferred');
});

test('pull keeps an ignore page (reviewability) and tags it desiredState=ignore', async () => {
  const written = {};
  const registry = emptyRegistry();
  await withRepo(
    { pages: [{ slug: 'hidden', desiredState: 'ignore' }] },
    {},
    async ({ contentDir }) => {
      const res = await pull(ACCT, {
        contentDir,
        registry,
        getAll: async () => [
          { slug: 'hidden', name: 'H', htmlTitle: 'H', templatePath: 'templates/about.html', currentState: 'PUBLISHED' },
        ],
        writeFile: async (path, text) => {
          written[path] = text;
        },
      });
      assert.equal(res.pulled, 1, 'ignore pages ARE pulled for reviewability');
    },
  );
  const obj = JSON.parse(Object.values(written)[0]);
  assert.equal(obj.desiredState, 'ignore');
});

// ── manifest validation ──────────────────────────────────────────────────────

test('pull throws on an invalid desiredState in the manifest', async () => {
  const registry = emptyRegistry();
  await withRepo(
    { pages: [{ slug: 'about', desiredState: 'bogus' }] },
    {},
    async ({ contentDir }) => {
      await assert.rejects(
        () =>
          pull(ACCT, {
            contentDir,
            registry,
            getAll: async () => [{ slug: 'about', name: 'A', htmlTitle: 'A', templatePath: 'templates/about.html' }],
            writeFile: async () => {},
          }),
        /invalid desiredState/,
      );
    },
  );
});

// ── PUSH: per-item fresh scheduling + throw on schedule failure (codex #11) ──

// A hub stub that schedules N publish pages and lets the caller observe each
// schedule body. `scheduleResult(slug, i)` decides the schedule response so a
// test can fail a specific item.
function batchHubStub({ scheduleResult } = {}) {
  const calls = [];
  let schedIdx = 0;
  const hub = async (acct, method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'POST' && path === '/cms/v3/pages/site-pages') {
      // Each create returns a distinct id derived from the slug.
      return { ok: true, status: 201, json: { id: `NEW-${body.slug}` } };
    }
    if (method === 'PATCH' && /\/draft$/.test(path)) return { ok: true, status: 200, json: {} };
    if (method === 'POST' && path === '/cms/v3/pages/site-pages/schedule') {
      const r = scheduleResult ? scheduleResult(body, schedIdx) : { ok: true, status: 204, json: {} };
      schedIdx += 1;
      return r;
    }
    return { ok: false, status: 500, json: { message: 'unexpected ' + method + ' ' + path } };
  };
  const resolvePageId = async () => null; // all create
  return { hub, resolvePageId, calls };
}

test('push computes a FRESH future publishDate per item (not one batch timestamp) — a slow batch never schedules in the past', async () => {
  // Three publish pages. nowFn() is called once per scheduled item and advances
  // a large amount between items (simulating a slow batch). With a single batch
  // timestamp, later items would carry the EARLIEST item's date; with per-item
  // fresh dates, each item's date reflects the clock AT its own schedule call and
  // every date stays in the future relative to its own `now`.
  const registry = emptyRegistry('246389711');
  const { hub, resolvePageId, calls } = batchHubStub();

  // Simulated clock: starts at T0, jumps +120s each time it is read.
  const T0 = 1_700_000_000_000;
  let tick = 0;
  const nowFn = () => T0 + tick++ * 120_000;

  await withRepo(
    {
      pages: [
        { slug: 'a', desiredState: 'publish' },
        { slug: 'b', desiredState: 'publish' },
        { slug: 'c', desiredState: 'publish' },
      ],
    },
    {
      'a.json': { slug: 'a', name: 'A', htmlTitle: 'A', language: 'en', templatePath: 'templates/about.html', desiredState: 'publish' },
      'b.json': { slug: 'b', name: 'B', htmlTitle: 'B', language: 'en', templatePath: 'templates/about.html', desiredState: 'publish' },
      'c.json': { slug: 'c', name: 'C', htmlTitle: 'C', language: 'en', templatePath: 'templates/about.html', desiredState: 'publish' },
    },
    async ({ contentDir }) => {
      const res = await push(ACCT, { contentDir, registry, hub, resolvePageId, nowFn });
      assert.equal(res.pushed, 3);
    },
  );

  const scheds = calls.filter((c) => c.path === '/cms/v3/pages/site-pages/schedule');
  assert.equal(scheds.length, 3, 'all three publish pages were scheduled');

  // Each schedule body's date must be DISTINCT (proves a fresh nowFn() read per
  // item, not one shared batch timestamp) and STRICTLY INCREASING with the clock.
  const dates = scheds.map((c) => new Date(c.body.publishDate).getTime());
  assert.equal(new Set(dates).size, 3, 'each item got a distinct fresh publishDate');
  assert.ok(dates[0] < dates[1] && dates[1] < dates[2], 'publishDates advance with the per-item clock');

  // And each item's date is its own (fresh) now + the ~90s lead — i.e. in the
  // future relative to the clock value read for THAT item, not the batch start.
  for (let i = 0; i < 3; i++) {
    assert.equal(dates[i], T0 + i * 120_000 + 90_000, `item ${i} date = its own now + lead`);
  }
});

test('push THROWS when an item schedule fails (non-2xx) — no silent draft/live divergence', async () => {
  // The SECOND publish item's schedule returns a 4xx. push() must throw (the draft
  // is updated but not live; a soft note would hide the divergence) and must NOT
  // continue scheduling the third item.
  const registry = emptyRegistry('246389711');
  const { hub, resolvePageId, calls } = batchHubStub({
    scheduleResult: (_body, i) =>
      i === 1
        ? { ok: false, status: 400, json: { message: 'PUBLISH_DATE_IN_PAST' } }
        : { ok: true, status: 204, json: {} },
  });

  await withRepo(
    {
      pages: [
        { slug: 'a', desiredState: 'publish' },
        { slug: 'b', desiredState: 'publish' },
        { slug: 'c', desiredState: 'publish' },
      ],
    },
    {
      'a.json': { slug: 'a', name: 'A', htmlTitle: 'A', language: 'en', templatePath: 'templates/about.html', desiredState: 'publish' },
      'b.json': { slug: 'b', name: 'B', htmlTitle: 'B', language: 'en', templatePath: 'templates/about.html', desiredState: 'publish' },
      'c.json': { slug: 'c', name: 'C', htmlTitle: 'C', language: 'en', templatePath: 'templates/about.html', desiredState: 'publish' },
    },
    async ({ contentDir }) => {
      await assert.rejects(
        () => push(ACCT, { contentDir, registry, hub, resolvePageId, now: 1_700_000_000_000 }),
        /schedule .*-> 400|PUBLISH_DATE_IN_PAST/,
      );
    },
  );

  const scheds = calls.filter((c) => c.path === '/cms/v3/pages/site-pages/schedule');
  // First scheduled (ok), second failed and threw — the third must NOT be attempted.
  assert.equal(scheds.length, 2, 'scheduling stops at the failed item; no further schedule calls');
});

// ── buildPagePayload defaults (no field-dropping / no undefined leaks) ────────

test('buildPagePayload supplies safe defaults (slug->"", language->"en", missing->"", useFeaturedImage->false)', () => {
  const p = buildPagePayload({ name: 'Only a name' });
  assert.deepEqual(p, {
    slug: '',
    name: 'Only a name',
    htmlTitle: '',
    metaDescription: '',
    language: 'en',
    templatePath: '',
    headHtml: '',
    footerHtml: '',
    linkRelCanonicalUrl: '',
    featuredImage: '',
    featuredImageAltText: '',
    useFeaturedImage: false,
  });
  // No undefined values leak into the HubSpot payload.
  for (const v of Object.values(p)) assert.notEqual(v, undefined);
});
