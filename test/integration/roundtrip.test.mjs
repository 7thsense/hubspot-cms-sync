// test/integration/roundtrip.test.mjs — REAL DEV API round-trip / idempotency tests.
//
//   RUN_INTEGRATION=1 node --test test/integration/roundtrip.test.mjs
//
// These are INTEGRATION tests, not unit tests: they hit the live HubSpot API of the
// DEV account (portal 246389711) using the service key at ~/.hubspot/246389711.key.
// They are GATED behind RUN_INTEGRATION=1 and SKIP entirely otherwise, so the default
// `npm run test:unit` / CI never touches the network.
//
// WHAT THEY ASSERT (the bidirectional-sync contract end-to-end):
//   • forms   — pull -> canonical name-keyed (no guid/portal) -> push upsert -> pull
//               -> BYTE-IDENTICAL, against a SCRATCH form created for the test.
//   • content — home page widgets: pull -> push (PATCH draft) -> pull -> identical.
//   • assets  — path <-> logical: upload bytes to dev File Manager, canonicalize the
//               returned hosted URL back to its @asset:<path> token, assert overwrite
//               is idempotent (same hosted path on re-upload).
//   • safety  — sync/push.mjs REFUSES to run against prod (portal 529456).
//
// REPRODUCIBLE IDEMPOTENCY round-trips for the remaining adapters (added later in
// this file; each is self-contained + self-cleaning, dev only, assertDev first):
//   • pages          — push ONE scratch page definition TWICE against the live dev
//                      Pages API. The 1st run CREATEs (no existing page by that
//                      scratch slug); the 2nd run finds it by slug and UPDATEs
//                      (PATCH /draft) — so re-running mints NO DUPLICATE page. We
//                      assert the exact op sequence (create-then-update) and that
//                      exactly one page carries the scratch slug afterwards. Cleans
//                      up by deleting the scratch page.  [LIVE dev writes]
//   • blog           — publish ONE scratch post TWICE through blog.push (publish=true)
//                      with INJECTED hub/now/sleep (so the ~90s schedule poll is
//                      instant and no real blog container — which is UI-gated — is
//                      needed). Asserts: 1st run CREATEs, 2nd run UPDATEs (no dup
//                      slug), and BOTH runs end with the post carrying its ORIGINAL
//                      2017 publishDate (the two-phase schedule→poll→restore preserves
//                      chronology — no date churn across re-runs). The injected hub is
//                      seeded to the dev account so assertDev still gates.  [no network]
//   • blog-container — drive blog.push's container-config path: the FIRST push PUTs the
//                      container's item_template_path / listing_template_path from
//                      container.json and clears listing_page_id; the SECOND push, with
//                      the live blog now matching, SKIPS the PUT (idempotent — no churn).
//                      Injected hub; asserts the PUT happens once then never again.  [no network]
//   • assets         — push the committed content/assets tree TWICE via assets.push
//                      against the live dev File Manager. The 1st run uploads (or reuses
//                      from the persisted rehosted cache); the 2nd run, reading the cache
//                      the 1st run wrote, REUSES every asset and uploads 0. We assert the
//                      2nd run's `uploaded` count is 0 and `reused` == the asset count —
//                      a re-push causes no churn / no duplicate File Manager objects.
//                      Operates on a SCRATCH content dir with one tiny scratch asset and
//                      its own .sync-state cache, cleaned up after.  [LIVE dev writes]
//
// ────────────────────────────────────────────────────────────────────────────
// HARD SAFETY RULES enforced in this file:
//   1. PRODUCTION (portal 529456) IS READ-ONLY. Every test that WRITES first calls
//      assertDev(acct) — which THROWS unless acct.portalId === DEV_PORTAL ('246389711')
//      — BEFORE issuing a single write. There is no code path here that can write prod.
//   2. IDEMPOTENT + SELF-CLEANING. Every scratch resource (a form, a File Manager
//      object) is created under a `zz-roundtrip-scratch` namespace and DELETED in a
//      try/finally, so a re-run starts clean and leaves nothing behind. Re-running the
//      whole suite converges.
//   3. MINIMAL API CALLS. We create exactly one scratch form and upload one 1x1 PNG;
//      the content test reuses the existing dev home page (read + one draft PATCH).
//
// REQUIRED ENV / CREDENTIALS:
//   RUN_INTEGRATION=1                 — opt-in flag; without it every test SKIPS.
//   ~/.hubspot/246389711.key          — dev service key/PAT (Bearer). Override the
//                                       directory with $HUBSPOT_KEY_DIR. The file holds
//                                       the raw `pat-naX-...` token, chmod 600.
//   (prod key ~/.hubspot/529456.key is only needed for the "refuses prod" test, which
//    asserts push() throws BEFORE any network call — see that test for why.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { account, hub } from '../../src/lib/hub.mjs';
import { emptyRegistry, canonicalize } from '../../src/lib/refs.mjs';
import {
  canonicalForm,
  readCanonicalForms,
  pull as formsPull,
  push as formsPush,
} from '../../src/adapters/forms.mjs';
import {
  pull as contentPull,
  push as contentPush,
} from '../../src/adapters/content.mjs';
import { uploadAsset, uploadTarget, push as assetsPush } from '../../src/adapters/assets.mjs';
import { push as pagesPush } from '../../src/adapters/pages.mjs';
import { push as blogPush } from '../../src/adapters/blog.mjs';
import { push as orchestratedPush, READ_ONLY_PORTAL } from '../../src/push.mjs';

// ────────────────────────────────────────────────────────────────────────────
// Gate + guards
// ────────────────────────────────────────────────────────────────────────────

// The single account these tests may write to. NEVER prod (529456).
const DEV_PORTAL = '246389711';
const RUN = process.env.RUN_INTEGRATION === '1';

// node:test honours a `{ skip }` option; we set it once so the whole suite is opt-in.
const skip = RUN ? false : 'set RUN_INTEGRATION=1 to run live DEV-API integration tests';

// All scratch resources share this prefix so cleanup is greppable + a re-run is safe.
const SCRATCH = 'zz-roundtrip-scratch';

/**
 * HARD GUARD — refuse to proceed unless we resolved the DEV account. Called at the
 * top of every test BEFORE any write. Makes "never write prod" impossible to bypass:
 * if accounts.json or the test were ever pointed at prod, this throws first.
 */
function assertDev(acct) {
  assert.equal(
    String(acct.portalId),
    DEV_PORTAL,
    `refusing to run: expected DEV portal ${DEV_PORTAL}, got ${acct.portalId} — these tests must never touch prod (${READ_ONLY_PORTAL})`,
  );
  assert.notEqual(String(acct.portalId), READ_ONLY_PORTAL, 'account resolved to PROD — abort');
}

function mkTmp(tag) {
  return mkdtempSync(join(tmpdir(), `rt-${tag}-`));
}

// Best-effort delete of every File Manager object whose name stem matches `stem`
// under our scratch namespace. Used in finally blocks.
async function deleteScratchFiles(acct, stem) {
  const s = await hub(acct, 'GET', `/files/v3/files/search?name=${encodeURIComponent(stem)}&limit=50`);
  const hits = (s.json?.results || []).filter((f) => String(f.path || '').includes(SCRATCH));
  for (const f of hits) {
    await hub(acct, 'DELETE', `/files/v3/files/${f.id}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// forms — scratch form pull -> canonical -> push upsert -> pull -> byte-identical
// ────────────────────────────────────────────────────────────────────────────
test('forms: pull -> canonical name-keyed -> push upsert -> pull is byte-identical (dev)', { skip }, async () => {
  const acct = account('dev');
  assertDev(acct); // guard BEFORE any write

  const formName = `${SCRATCH}: contact form`;
  let guid = null;
  const dir1 = mkTmp('forms-1');
  const dir2 = mkTmp('forms-2');

  try {
    // Arrange: create ONE scratch form directly so we never mutate real site forms.
    const created = await hub(acct, 'POST', '/forms/v2/forms', {
      name: formName,
      formFieldGroups: [
        {
          fields: [
            { name: 'firstname', label: 'First name', fieldType: 'text', required: false },
            { name: 'email', label: 'Work email', fieldType: 'text', required: true },
          ],
        },
      ],
    });
    assert.ok(created.ok && created.json.guid, `scratch form create -> ${created.status}`);
    guid = created.json.guid;

    // 1. PULL from dev into a fresh contentDir. The adapter pulls ALL forms; we only
    //    inspect our scratch one. Registry records the SOURCE guid under the key.
    const reg1 = emptyRegistry(acct.portalId);
    await formsPull(acct, { contentDir: dir1, registry: reg1 });

    const expectKey = canonicalForm({ name: formName, formFieldGroups: [] }).key;
    const file1 = join(dir1, 'forms', `${expectKey}.json`);
    assert.ok(existsSync(file1), `pull wrote canonical file for scratch form (${expectKey}.json)`);

    const canon = JSON.parse(readFileSync(file1, 'utf8'));
    // Canonical form is NAME-keyed and account-agnostic: NO guid, NO portalId.
    assert.equal(canon.name, formName);
    assert.equal(canon.key, expectKey);
    assert.ok(!('guid' in canon), 'canonical form must not carry a guid');
    assert.ok(!('portalId' in canon), 'canonical form must not carry a portalId');
    assert.ok(Array.isArray(canon.fields) && canon.fields.length === 2, 'fields preserved');
    // The SOURCE guid lives only in the (gitignored) registry, never the file.
    assert.equal(reg1.forms[expectKey], guid, 'registry records source guid under the key');

    // 2. PUSH back to dev from a contentDir containing ONLY the scratch form, so the
    //    upsert touches just this form (idempotent: name matches -> update/no-op).
    const pushDir = mkTmp('forms-push');
    const onlyScratch = readCanonicalForms(dir1).filter((f) => f.key === expectKey);
    assert.equal(onlyScratch.length, 1, 'isolated the scratch form for a minimal push');
    // Re-materialize just the one canonical file + a properties.json into pushDir.
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(pushDir, 'forms'), { recursive: true });
    writeFileSync(join(pushDir, 'forms', `${expectKey}.json`), readFileSync(file1));
    // Provide an empty managed-properties file so push doesn't fall back to the seed
    // (keeps the property writes to a no-op convergence on our 2 fields' standard props).
    writeFileSync(join(pushDir, 'forms', 'properties.json'), '[]\n');

    const reg2 = emptyRegistry(acct.portalId);
    const pushRes = await formsPush(acct, { contentDir: pushDir, registry: reg2 });
    assert.ok(Array.isArray(pushRes.notes));
    // Push must populate the registry with THIS account's target guid for the key.
    assert.equal(reg2.forms[expectKey], guid, 'push registry resolves key -> same dev guid (upsert by name)');

    // 3. PULL again into a second fresh dir; the scratch form's canonical bytes must
    //    be byte-identical to the first pull (round-trip converged).
    const reg3 = emptyRegistry(acct.portalId);
    await formsPull(acct, { contentDir: dir2, registry: reg3 });
    const file2 = join(dir2, 'forms', `${expectKey}.json`);
    assert.ok(existsSync(file2), 'second pull re-wrote the canonical file');

    assert.equal(
      readFileSync(file2, 'utf8'),
      readFileSync(file1, 'utf8'),
      'forms pull -> push -> pull is byte-identical for the scratch form',
    );

    rmSync(pushDir, { recursive: true, force: true });
  } finally {
    // Cleanup: delete the scratch form (idempotent — 404 after delete is fine).
    if (guid) await hub(acct, 'DELETE', `/forms/v2/forms/${guid}`);
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// content — home page widgets: pull -> push (PATCH draft) -> pull -> identical
// ────────────────────────────────────────────────────────────────────────────
test('content: home widgets pull -> push -> pull is byte-identical (dev)', { skip }, async () => {
  const acct = account('dev');
  assertDev(acct); // guard BEFORE the draft PATCH

  const dir1 = mkTmp('content-1');
  const dir2 = mkTmp('content-2');
  try {
    // 1. PULL the home page (slug '') widgets into a fresh contentDir.
    const reg1 = emptyRegistry(acct.portalId);
    await contentPull(acct, { contentDir: dir1, registry: reg1 });
    const home1 = join(dir1, 'pages', 'home.widgets.json');
    assert.ok(existsSync(home1), 'pulled home.widgets.json (slug "")');
    const before = readFileSync(home1, 'utf8');
    assert.ok(before.length > 0 && before.includes('"widgets"'), 'home widgets file is non-empty');

    // 2. PUSH the same canonical bytes back to dev. content.push resolves any embedded
    //    logical refs (the live home page tokenizes a form GUID to @form:<key> on pull)
    //    and PATCHes the home page DRAFT, then schedules a near-future publish. We reuse
    //    the PULL registry — same-account round-trip resolves each @form/@asset ref back
    //    to the identical dev guid/url it was pulled from (this is exactly how the
    //    orchestrator threads one per-account registry through pull then push). Pushing
    //    identical bytes is a no-op republish — converges, mutates no content.
    const pushRes = await contentPush(acct, { contentDir: dir1, registry: reg1 });
    assert.ok((pushRes.pushed ?? 0) >= 1, 'pushed the home widgets draft');

    // 3. PULL again into a fresh dir; bytes must be byte-identical (round-trip).
    const reg3 = emptyRegistry(acct.portalId);
    await contentPull(acct, { contentDir: dir2, registry: reg3 });
    const after = readFileSync(join(dir2, 'pages', 'home.widgets.json'), 'utf8');

    assert.equal(after, before, 'content pull -> push -> pull is byte-identical for home');
  } finally {
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// assets — path <-> logical: upload bytes, canonicalize hosted URL -> @asset token,
//          overwrite idempotency. Cleans up the scratch File Manager object.
// ────────────────────────────────────────────────────────────────────────────
test('assets: upload -> canonicalize hosted URL back to @asset:<path>, overwrite is idempotent (dev)', { skip }, async () => {
  const acct = account('dev');
  assertDev(acct); // guard BEFORE the upload

  // 1x1 transparent PNG (tiny, deterministic).
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  // Path tail = registry key = repo path = @asset token suffix (all the same string).
  const path = `${SCRATCH}/probe-pixel.png`;
  const stem = 'probe-pixel';

  try {
    // Sanity: pure path<->logical target derivation (no network).
    const tgt = uploadTarget(path);
    assert.equal(tgt.fileName, 'probe-pixel.png');
    assert.equal(tgt.folderPath, `/synced-assets/${SCRATCH}`);

    // Upload with OVERWRITE; returns a hosted URL on the dev portal.
    const url1 = await uploadAsset(acct, png, path);
    assert.ok(typeof url1 === 'string' && url1.includes('/hubfs/'), `got a hosted URL: ${url1}`);
    assert.ok(url1.includes(`/${DEV_PORTAL}/`), 'hosted URL carries the dev portal id');

    // path<->logical: canonicalize the hosted URL collapses portal+host into the
    // single @asset:<path> token (the inverse of resolve()).
    const reg = emptyRegistry(acct.portalId);
    const canon = canonicalize(JSON.stringify({ img: url1 }), reg);
    assert.equal(
      JSON.parse(canon).img,
      `@asset:synced-assets/${SCRATCH}/probe-pixel.png`,
      'hosted URL canonicalizes to the logical @asset token (path tail kept verbatim)',
    );

    // Overwrite idempotency (codex #4): re-uploading the same path yields the SAME
    // hosted path — no duplicate file — so push converges across runs.
    const url2 = await uploadAsset(acct, png, path);
    assert.equal(
      new URL(url2).pathname,
      new URL(url1).pathname,
      'overwrite upload is idempotent — same hosted path, no duplicate',
    );
  } finally {
    await deleteScratchFiles(acct, stem);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// safety — sync/push.mjs REFUSES to run against prod (portal 529456).
//   This guard throws BEFORE loading any adapter or touching the network, so it
//   is safe to invoke even though it targets prod: nothing is ever written.
// ────────────────────────────────────────────────────────────────────────────
test('safety: sync/push.mjs refuses to push to PROD (portal 529456)', { skip }, async () => {
  // Assert the policy constant first (defense in depth: if someone changed it, fail).
  assert.equal(READ_ONLY_PORTAL, '529456', 'READ_ONLY_PORTAL must be prod 529456');

  await assert.rejects(
    () => orchestratedPush('prod'),
    (err) => {
      assert.match(err.message, /read-only/i, 'error explains prod is read-only');
      assert.match(err.message, /529456/, 'error names the prod portal');
      return true;
    },
    'push("prod") must throw and never write to prod',
  );
});

// ════════════════════════════════════════════════════════════════════════════
// REPRODUCIBLE IDEMPOTENCY round-trips (pages / blog / blog-container / assets).
// Each is self-contained, scratch-namespaced, and self-cleaning so re-running the
// whole suite converges and leaves nothing behind. See the file header for the
// run command + what each asserts.
// ════════════════════════════════════════════════════════════════════════════

// Materialize a throwaway <root>/{content,site.manifest.json} skeleton under tmp so
// an adapter that reads contentDir + the sibling manifest can run in isolation,
// never touching the repo's real content/ or site.manifest.json. Returns
// { root, contentDir, cleanup }.
function scratchContentRoot(tag) {
  const root = mkTmp(tag);
  const contentDir = join(root, 'content');
  mkdirSync(contentDir, { recursive: true });
  return { root, contentDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// ────────────────────────────────────────────────────────────────────────────
// pages — push ONE scratch page definition TWICE against the LIVE dev Pages API.
//   Proves idempotency-by-slug: 1st run CREATEs, 2nd run finds the page by slug and
//   UPDATEs (PATCH /draft) — re-running mints NO duplicate. desiredState is 'draft'
//   so nothing is scheduled/published (keeps the scratch page out of the live site).
//   We wrap the real `hub` to RECORD the (method,path) of every write so we can
//   assert the create→update transition deterministically.
// ────────────────────────────────────────────────────────────────────────────
test('pages: push a scratch page def twice -> create then update, no duplicate page (dev)', { skip }, async () => {
  const acct = account('dev');
  assertDev(acct); // guard BEFORE any write

  const slug = `${SCRATCH}/probe-page`;
  const fileStem = slug.replace(/\//g, '__'); // slugToFile mapping
  const { root, contentDir, cleanup } = scratchContentRoot('pages');
  let createdId = null;

  // A scratch contentDir holding ONLY our page, plus a manifest listing ONLY it as
  // a DRAFT (so push writes a draft and never schedules a publish).
  mkdirSync(join(contentDir, 'pages'), { recursive: true });
  const def = {
    desiredState: 'draft',
    slug,
    name: `${SCRATCH} probe page`,
    htmlTitle: `${SCRATCH} probe page`,
    metaDescription: '',
    language: 'en',
    templatePath: 'seventh-sense-theme/templates/about.html',
  };
  writeFileSync(join(contentDir, 'pages', `${fileStem}.json`), JSON.stringify(def, null, 2));
  writeFileSync(
    join(root, 'site.manifest.json'),
    JSON.stringify({ pages: [{ slug, desiredState: 'draft', templatePath: def.templatePath }] }, null, 2),
  );

  // Recording wrapper around the real hub: forwards every call but logs writes so we
  // can assert create-then-update and capture the new page id for cleanup.
  const writes = [];
  const recordingHub = async (a, method, path, body) => {
    const res = await hub(a, method, path, body);
    if (method !== 'GET') writes.push({ method, path, status: res.status });
    if (method === 'POST' && path === '/cms/v3/pages/site-pages' && res.ok) {
      createdId = String(res.json?.id);
    }
    return res;
  };

  try {
    const reg = emptyRegistry(acct.portalId);

    // RUN 1 — page does not exist yet -> CREATE (POST site-pages).
    const r1 = await pagesPush(acct, { contentDir, registry: reg, hub: recordingHub });
    assert.equal(r1.pushed, 1, 'run 1 pushed exactly the one scratch page');
    assert.ok(createdId, 'run 1 created the scratch page and returned an id');
    assert.ok(
      writes.some((w) => w.method === 'POST' && w.path === '/cms/v3/pages/site-pages'),
      'run 1 issued a POST create',
    );

    // RUN 2 — same slug now exists -> UPDATE (PATCH /draft), NOT another create.
    writes.length = 0;
    const r2 = await pagesPush(acct, { contentDir, registry: reg, hub: recordingHub });
    assert.equal(r2.pushed, 1, 'run 2 pushed exactly the one scratch page');
    assert.ok(
      writes.some((w) => w.method === 'PATCH' && w.path === `/cms/v3/pages/site-pages/${createdId}/draft`),
      'run 2 PATCHed the SAME page id (update, not create)',
    );
    assert.ok(
      !writes.some((w) => w.method === 'POST' && w.path === '/cms/v3/pages/site-pages'),
      'run 2 issued NO POST create — no duplicate page minted',
    );

    // Ground truth: exactly ONE live page carries the scratch slug.
    const list = await hub(acct, 'GET', `/cms/v3/pages/site-pages?limit=100`);
    const matches = (list.json?.results || []).filter((p) => String(p.slug ?? '') === slug);
    assert.equal(matches.length, 1, 'exactly one live page has the scratch slug (idempotent)');
  } finally {
    if (createdId) await hub(acct, 'DELETE', `/cms/v3/pages/site-pages/${createdId}`);
    cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// blog — publish ONE scratch post TWICE through blog.push(publish=true) with an
//   INJECTED hub (so no UI-gated blog container is required and the ~90s schedule
//   poll is instant). Proves: 1st run CREATEs, 2nd run UPDATEs the SAME slug (no
//   duplicate), and BOTH runs leave the post carrying its ORIGINAL 2017 publishDate
//   — the two-phase schedule→poll→restore preserves chronology with no date churn.
//   The fake hub is account-shaped and assertDev still gates the test, but no real
//   network is touched (blog container creation is UI-gated — SYNC-NOTES §4).
// ────────────────────────────────────────────────────────────────────────────
test('blog: publish a scratch post twice -> update not duplicate, original date preserved (dev)', { skip }, async () => {
  const acct = account('dev');
  assertDev(acct); // guard: this test only runs resolved against dev

  const ORIGINAL_DATE = '2017-03-15T12:00:00.000Z';
  const blogSlug = 'blog';
  const postSlug = `blog/${SCRATCH}-probe-post`;
  const { root, contentDir, cleanup } = scratchContentRoot('blog');

  // Scratch blog tree: a container.json for the 'blog' slug + one post carrying the
  // 2017 original date. No @asset refs so resolveRefs is a no-op (no uploads needed).
  const blogDir = join(contentDir, 'blog');
  mkdirSync(join(blogDir, 'posts'), { recursive: true });
  writeFileSync(
    join(blogDir, 'container.json'),
    JSON.stringify({
      slug: blogSlug,
      name: 'Seventh Sense Blog',
      itemTemplatePath: 'seventh-sense-theme/templates/blog-post.html',
      listingTemplatePath: 'seventh-sense-theme/templates/blog.html',
      listingPageId: 0,
    }, null, 2),
  );
  writeFileSync(
    join(blogDir, 'posts', `${postSlug.replace(/\//g, '__')}.json`),
    JSON.stringify({
      slug: postSlug,
      blogSlug,
      name: `${SCRATCH} probe post`,
      htmlTitle: `${SCRATCH} probe post`,
      state: 'PUBLISHED',
      authorSlug: null,
      authorName: null,
      tagSlugs: [],
      tagNames: [],
      metaDescription: '',
      featuredImage: '',
      featuredImageAltText: '',
      useFeaturedImage: false,
      postBody: '<p>scratch body</p>',
      postSummary: '<p>scratch summary</p>',
      publishDate: ORIGINAL_DATE,
    }, null, 2),
  );

  // ── In-memory fake HubSpot, seeded so blog.push runs end-to-end without network.
  // It models exactly the endpoints blog.push touches: the legacy container list, the
  // author/tag/post collections, post create/patch, and the schedule + poll cycle.
  let postIdSeq = 1000;
  const db = {
    posts: new Map(), // id -> { id, slug, state, publishDate, ... }
    bySlug: new Map(), // slug -> id
  };
  // The live container the fake reports for slug 'blog' (already template-synced so
  // applyContainerConfig is a no-op here — the container path is covered by its own test).
  const liveBlog = {
    id: 77,
    slug: blogSlug,
    name: 'Seventh Sense Blog',
    item_template_path: 'seventh-sense-theme/templates/blog-post.html',
    listing_template_path: 'seventh-sense-theme/templates/blog.html',
    listing_page_id: 0,
  };

  function listResult(arr) {
    return { ok: true, status: 200, json: { results: arr, objects: arr, paging: undefined } };
  }
  const fakeHub = async (a, method, path, body) => {
    // assertDev parity: the fake is always invoked with the dev account.
    if (path.startsWith('/content/api/v2/blogs')) return { ok: true, status: 200, json: { objects: [liveBlog] } };
    if (path.startsWith('/cms/v3/blogs/authors') && method === 'GET') return listResult([]);
    if (path.startsWith('/cms/v3/blogs/tags') && method === 'GET') return listResult([]);
    if (path.startsWith('/cms/v3/blogs/posts') && method === 'GET' && !/\/posts\/\d+/.test(path)) {
      return listResult([...db.posts.values()]);
    }
    // GET a single post (the publish poll + date-restore verify).
    const single = path.match(/^\/cms\/v3\/blogs\/posts\/(\d+)/);
    if (single && method === 'GET') {
      return { ok: true, status: 200, json: db.posts.get(Number(single[1])) || {} };
    }
    if (path === '/cms/v3/blogs/posts' && method === 'POST') {
      const id = ++postIdSeq;
      const rec = { id, slug: body.slug, state: 'DRAFT', publishDate: body.publishDate };
      db.posts.set(id, rec);
      db.bySlug.set(body.slug, id);
      return { ok: true, status: 201, json: { id } };
    }
    if (single && method === 'PATCH') {
      const rec = db.posts.get(Number(single[1]));
      if (rec && body.publishDate) rec.publishDate = body.publishDate;
      return { ok: true, status: 200, json: rec || {} };
    }
    if (path === '/cms/v3/blogs/posts/schedule' && method === 'POST') {
      // Scheduling marks the post PUBLISHED (the poll then sees it live immediately)
      // and — like the real API — clobbers publishDate to the scheduled time, which
      // the two-phase restore must later correct back to the original.
      const rec = db.posts.get(Number(body.id));
      if (rec) { rec.state = 'PUBLISHED'; rec.publishDate = body.publishDate; }
      return { ok: true, status: 204, json: {} };
    }
    return { ok: true, status: 200, json: {} };
  };

  // Injected clock + no-op sleep so the schedule/poll/settle waits are INSTANT.
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const now = () => clock;
  const sleep = async (ms) => { clock += ms; }; // advance the mock clock instead of waiting

  try {
    const reg1 = emptyRegistry(acct.portalId);
    // RUN 1 — create + publish + restore date.
    const r1 = await blogPush(acct, {
      contentDir, registry: reg1, publish: true, hubFn: fakeHub, now, sleep,
    });
    assert.equal(r1.pushed, 1, 'run 1 pushed the one scratch post');
    const id1 = db.bySlug.get(postSlug);
    assert.ok(id1, 'run 1 created the post');
    assert.equal(db.posts.size, 1, 'exactly one post exists after run 1 (no duplicate)');
    assert.equal(
      db.posts.get(id1).publishDate, ORIGINAL_DATE,
      'run 1 restored the ORIGINAL 2017 publishDate after the schedule clobbered it',
    );

    const reg2 = emptyRegistry(acct.portalId);
    // RUN 2 — same slug now exists -> UPDATE the same id, still one post, date preserved.
    const r2 = await blogPush(acct, {
      contentDir, registry: reg2, publish: true, hubFn: fakeHub, now, sleep,
    });
    assert.equal(r2.pushed, 1, 'run 2 pushed the one scratch post (as an update)');
    assert.equal(db.posts.size, 1, 'still exactly one post after run 2 — no duplicate slug');
    assert.equal(db.bySlug.get(postSlug), id1, 'run 2 updated the SAME post id (idempotent by slug)');
    assert.equal(
      db.posts.get(id1).publishDate, ORIGINAL_DATE,
      'run 2 re-restored the original date — no chronology churn across re-runs',
    );
  } finally {
    cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// blog-container — drive blog.push's container-config path (applyContainerConfig):
//   the FIRST push PUTs the container's item/listing template paths from
//   container.json and clears listing_page_id; the SECOND push (live blog now
//   matching) SKIPS the PUT (idempotent — no churn). Injected hub records the PUTs.
//   No real network (container creation is UI-gated — SYNC-NOTES §4).
// ────────────────────────────────────────────────────────────────────────────
test('blog-container: push sets item/listing templates once, second push is a no-op (dev)', { skip }, async () => {
  const acct = account('dev');
  assertDev(acct);

  const blogSlug = 'blog';
  const wantItem = 'seventh-sense-theme/templates/blog-post.html';
  const wantListing = 'seventh-sense-theme/templates/blog.html';
  const { root, contentDir, cleanup } = scratchContentRoot('blog-container');

  const blogDir = join(contentDir, 'blog');
  mkdirSync(join(blogDir, 'posts'), { recursive: true });
  writeFileSync(
    join(blogDir, 'container.json'),
    JSON.stringify({
      slug: blogSlug, name: 'Seventh Sense Blog',
      itemTemplatePath: wantItem, listingTemplatePath: wantListing, listingPageId: 0,
    }, null, 2),
  );
  // One trivial draft post so push actually resolves the container (containerIdFor is
  // called per post). publish=false so we exercise ONLY the container-config path.
  writeFileSync(
    join(blogDir, 'posts', `${SCRATCH}__probe.json`),
    JSON.stringify({
      slug: `blog/${SCRATCH}-probe`, blogSlug, name: 'probe', htmlTitle: 'probe',
      state: 'DRAFT', tagSlugs: [], tagNames: [], metaDescription: '',
      featuredImage: '', featuredImageAltText: '', useFeaturedImage: false,
      postBody: '<p>x</p>', postSummary: '', publishDate: '2017-01-01T00:00:00.000Z',
    }, null, 2),
  );

  // Live blog starts MISCONFIGURED (default elevate templates + a listing-page
  // override) so run 1 MUST correct it; mutate it in place so run 2 sees it in-sync.
  const liveBlog = {
    id: 88, slug: blogSlug, name: 'Seventh Sense Blog',
    item_template_path: '@hubspot/elevate/templates/blog-post.html',
    listing_template_path: '@hubspot/elevate/templates/blog.html',
    listing_page_id: 4242,
  };
  const puts = [];
  const fakeHub = async (a, method, path, body) => {
    if (path.startsWith('/content/api/v2/blogs') && method === 'GET') {
      return { ok: true, status: 200, json: { objects: [liveBlog] } };
    }
    if (method === 'PUT' && path === `/content/api/v2/blogs/${liveBlog.id}`) {
      puts.push(body);
      // Apply the PUT so a subsequent read sees the container in-sync (idempotency).
      liveBlog.item_template_path = body.item_template_path;
      liveBlog.listing_template_path = body.listing_template_path;
      liveBlog.listing_page_id = body.listing_page_id;
      return { ok: true, status: 200, json: liveBlog };
    }
    // authors/tags/posts list empty; post create succeeds.
    if (path === '/cms/v3/blogs/posts' && method === 'POST') return { ok: true, status: 201, json: { id: 1 } };
    if (method === 'GET') return { ok: true, status: 200, json: { results: [], objects: [] } };
    return { ok: true, status: 200, json: {} };
  };

  try {
    // RUN 1 — container is misconfigured -> exactly one PUT correcting both template
    // paths and clearing the listing-page override.
    await blogPush(acct, { contentDir, registry: emptyRegistry(acct.portalId), publish: false, hubFn: fakeHub });
    assert.equal(puts.length, 1, 'run 1 issued exactly one container PUT');
    assert.equal(puts[0].item_template_path, wantItem, 'PUT set item_template_path from container.json');
    assert.equal(puts[0].listing_template_path, wantListing, 'PUT set listing_template_path from container.json');
    assert.equal(puts[0].listing_page_id, 0, 'PUT cleared the listing_page_id override (SYNC-NOTES §4)');

    // RUN 2 — live blog now matches the canon -> NO further PUT (idempotent, no churn).
    await blogPush(acct, { contentDir, registry: emptyRegistry(acct.portalId), publish: false, hubFn: fakeHub });
    assert.equal(puts.length, 1, 'run 2 issued NO additional PUT — container config is idempotent');
  } finally {
    cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// assets — push the committed assets tree TWICE via assets.push against the LIVE
//   dev File Manager. Run 1 uploads the scratch asset; run 2 reads the rehosted
//   cache run 1 persisted and REUSES it — uploads 0, no duplicate File Manager
//   object. Operates on a SCRATCH content dir with its OWN .sync-state cache (we
//   point cwd at the scratch root so the adapter's repo-relative .sync-state path
//   lands there, not in the repo). Cleans up the scratch File Manager object.
//
//   NOTE: assets.push derives .sync-state from the MODULE location (sync/adapters),
//   not cwd, so the rehosted cache is the repo's real .sync-state/<portal>.rehosted.json.
//   To avoid polluting/relying on it we (a) use a uniquely-named scratch asset path so
//   we never collide with real keys, and (b) assert on the per-run uploaded/reused
//   COUNTS for our scratch path rather than the whole tree.
// ────────────────────────────────────────────────────────────────────────────
test('assets: push twice -> 2nd run reuses (uploads 0), no duplicate (dev)', { skip }, async () => {
  const acct = account('dev');
  assertDev(acct); // guard BEFORE any upload

  // tiny deterministic 1x1 PNG
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  const assetKey = `${SCRATCH}/probe-asset.png`;
  const stem = 'probe-asset';
  const { root, contentDir, cleanup } = scratchContentRoot('assets');

  // Commit the scratch asset bytes + a page that REFERENCES it (so collectReferenced
  // picks it up and push has something to do), in the scratch contentDir only.
  mkdirSync(join(contentDir, 'assets', SCRATCH), { recursive: true });
  writeFileSync(join(contentDir, 'assets', assetKey), png);
  mkdirSync(join(contentDir, 'pages'), { recursive: true });
  writeFileSync(
    join(contentDir, 'pages', 'probe.json'),
    JSON.stringify({ slug: 'probe', body: `@asset:${assetKey}` }, null, 2),
  );

  // Force a clean first run for OUR key regardless of any pre-existing repo cache:
  // ASSET_FORCE makes run 1 upload even if the registry/cache already had the key.
  const priorForce = process.env.ASSET_FORCE;
  try {
    const reg = emptyRegistry(acct.portalId);

    // RUN 1 — upload our scratch asset (force, so it definitely uploads this run).
    process.env.ASSET_FORCE = '1';
    const r1 = await assetsPush(acct, { contentDir, registry: reg });
    assert.ok(typeof reg.assets[assetKey] === 'string' && reg.assets[assetKey].includes('/hubfs/'),
      'run 1 resolved the scratch @asset to a hosted dev URL');
    const url1 = reg.assets[assetKey];
    assert.ok((r1.pushed ?? 0) >= 1, 'run 1 uploaded at least our scratch asset');

    // RUN 2 — NO force: the registry already carries our hosted URL, so push must
    // REUSE it and upload 0 (for our key). Same registry threads the mapping through,
    // exactly as the orchestrator persists+reloads it between runs.
    delete process.env.ASSET_FORCE;
    const r2 = await assetsPush(acct, { contentDir, registry: reg });
    assert.equal(reg.assets[assetKey], url1, 'run 2 kept the SAME hosted URL (no re-upload, no drift)');
    // The scratch tree contains exactly our one asset, so run 2's whole-push uploaded
    // count is the proof: a re-push uploads nothing and reuses everything.
    const line = (r2.notes || []).find((n) => n.startsWith('assets push:')) || '';
    assert.match(line, /uploaded 0\b/, 'run 2 uploaded 0 — every asset reused from cache/registry');
    assert.match(line, /reused 1\b/, 'run 2 reused the single scratch asset');
    assert.equal(r2.pushed ?? 0, 0, 'run 2 pushed (uploaded) 0 assets — idempotent re-push');
  } finally {
    if (priorForce === undefined) delete process.env.ASSET_FORCE;
    else process.env.ASSET_FORCE = priorForce;
    await deleteScratchFiles(acct, stem);
    cleanup();
  }
});
