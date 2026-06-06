// Unit tests for sync/adapters/content.mjs — the page MODULE CONTENT (widgets)
// adapter. PURE + network-mocked: no real HubSpot API. Run: node --test test/unit
//
// Coverage:
//   1. The core invariant — widget canonicalize <-> resolve ROUND-TRIP using the real
//      content/pages/home.widgets.json bytes and a two-account registry. Proves the
//      embedded form GUID (home.widgets.json:743) survives pull (-> @form:key) and is
//      restored on push (-> target GUID) byte-for-byte.
//   2. pull(): walks the site-page list, fetches per-page detail, writes a canonical
//      <slug>.widgets.json with the GUID logical-ized and the registry populated.
//   3. push(): resolves logical refs to the target account, PATCHes the page draft
//      (replace-not-merge, carrier empties intact), schedules publish; HARD-FAILS
//      when a ref is unmapped; never targets a hardcoded portal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { pull, push, name, dependsOn } from '../../src/adapters/content.mjs';
import {
  emptyRegistry,
  loadRegistry,
  canonicalize,
  resolve,
  listLogicalTokens,
} from '../../src/lib/refs.mjs';
import { normalizeWidgets, stableStringify } from '../../src/lib/canonical.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', 'fixtures');

// Real corpus bytes: the committed homepage widgets file is CANONICAL (portable) —
// its form_id is the logical token `@form:demo`, not a raw GUID (the corpus invariant:
// the committed content tree carries logical tokens, never per-account ids). To exercise
// the pull-side canonicalize on *raw prod* bytes, we reconstitute the raw fixture by
// resolving that token back to the prod GUID via a registry that maps demo -> GUID.
const HOME_FORM_GUID = 'e6510401-3265-44d4-88d5-a3c5c4670311';
const HOME_WIDGETS_PATH = join(FIXTURES, 'content', 'pages', 'home.widgets.json');
const HOME_WIDGETS_RAW = JSON.parse(
  resolve(
    readFileSync(HOME_WIDGETS_PATH, 'utf8'),
    loadRegistry({ portalId: '529456', forms: { demo: HOME_FORM_GUID } }),
  ),
);
// A DIFFERENT GUID the "target" account uses for the same logical form.
const TARGET_FORM_GUID = 'aaaa1111-2222-3333-4444-555566667777';

// Two accounts that share the SAME logical key for the homepage lead form.
function srcRegistry() {
  return loadRegistry({ portalId: '529456', forms: { 'home-lead': HOME_FORM_GUID } });
}
function tgtRegistry() {
  return loadRegistry({ portalId: '246389711', forms: { 'home-lead': TARGET_FORM_GUID } });
}

const acct = (portalId) => ({ name: 't', portalId, key: 'pat-test' });

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'content-adapter-'));
}

// ---------------------------------------------------------------------------
// 1. CORE: canonicalize <-> resolve round-trip on the real home.widgets.json bytes.
// ---------------------------------------------------------------------------

test('adapter metadata: name + dependsOn (forms/assets are consumed at push)', () => {
  assert.equal(name, 'content');
  assert.deepEqual(dependsOn, ['forms', 'assets']);
});

test('canonicalize logical-izes the home.widgets form GUID and registers it', () => {
  const reg = emptyRegistry('529456');
  const bytes = stableStringify({ widgets: normalizeWidgets(HOME_WIDGETS_RAW.widgets) });
  assert.ok(bytes.includes(HOME_FORM_GUID), 'raw bytes carry the prod form GUID');

  const canon = canonicalize(bytes, reg);
  // GUID gone, logical token present, registry now maps the minted key -> GUID.
  assert.ok(!canon.includes(HOME_FORM_GUID), 'canonical bytes must not carry the raw GUID');
  const tokens = listLogicalTokens(canon).filter((t) => t.kind === 'form');
  assert.equal(tokens.length, 1, 'exactly one @form token');
  assert.equal(reg.forms[tokens[0].key], HOME_FORM_GUID);
  // It is still valid, parseable JSON with the carrier shape intact.
  const parsed = JSON.parse(canon);
  assert.equal(parsed.widgets.try_it_free.body.form_id, tokens[0].token);
});

test('round-trip: canonicalize(src) then resolve(tgt) restores carrier bytes with the TARGET GUID', () => {
  const src = srcRegistry();
  const bytes = stableStringify({ widgets: normalizeWidgets(HOME_WIDGETS_RAW.widgets) });

  // PULL side: logical-ize against source account.
  const canon = canonicalize(bytes, src);
  assert.ok(!canon.includes(HOME_FORM_GUID));
  // Logical key in canon must be the human key we registered (reverse-index hit).
  assert.ok(canon.includes('@form:home-lead'), 'canon uses the registered logical key');

  // PUSH side: resolve against a DIFFERENT account holding the same logical key.
  const resolved = resolve(canon, tgtRegistry());
  assert.ok(resolved.includes(TARGET_FORM_GUID), 'resolved bytes carry the target GUID');
  assert.ok(!resolved.includes('@form:'), 'no logical tokens survive resolve');

  // And resolving back into the SAME source account reproduces the original bytes.
  const roundtrip = resolve(canon, src);
  assert.equal(roundtrip, bytes, 'canonicalize->resolve into the same account is byte-identical');
});

test('resolve HARD-FAILS when the target has no mapping for a referenced form', () => {
  const canon = canonicalize(
    stableStringify({ widgets: normalizeWidgets(HOME_WIDGETS_RAW.widgets) }),
    srcRegistry(),
  );
  // Target account knows nothing about this form.
  assert.throws(() => resolve(canon, loadRegistry({ portalId: '999' })), /no mapping|home-lead/);
});

test('carrier empties are KEPT (replace-not-merge): css/child_css/label survive canonicalize', () => {
  const canon = canonicalize(
    stableStringify({ widgets: normalizeWidgets(HOME_WIDGETS_RAW.widgets) }),
    srcRegistry(),
  );
  const w = JSON.parse(canon).widgets.pricing;
  assert.deepEqual(w.css, {});
  assert.deepEqual(w.child_css, {});
  assert.ok('label' in w);
  // Empty-string body field (section_id) on the hero must survive verbatim.
  assert.equal(JSON.parse(canon).widgets.hero.body.section_id, '');
});

// ---------------------------------------------------------------------------
// 2. pull() with a mocked fetch.
// ---------------------------------------------------------------------------

// Route a fake HubSpot by method+path. Records calls for assertions.
function makeFetch({ pages, detail }, calls) {
  return async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ method, url, body: opts.body });
    const u = String(url);
    if (method === 'GET' && u.includes('/cms/v3/pages/site-pages') && !/site-pages\/\d+/.test(u)) {
      // list endpoint (paginated by getAll) — single page of results.
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: pages }) };
    }
    const m = u.match(/site-pages\/(\d+)(\/draft)?/);
    if (m && method === 'GET') {
      return { ok: true, status: 200, text: async () => JSON.stringify(detail[m[1]] || {}) };
    }
    if (m && method === 'PATCH') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: m[1], widgets: {} }) };
    }
    if (method === 'POST' && u.includes('/schedule')) {
      return { ok: true, status: 204, text: async () => '' };
    }
    return { ok: false, status: 404, text: async () => '{}' };
  };
}

test('pull writes <slug>.widgets.json with the GUID logical-ized; skips AB + widgetless pages', async () => {
  const dir = tmpDir();
  const registry = emptyRegistry('529456');
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = makeFetch(
    {
      pages: [
        { id: '111', slug: '' }, // homepage, has widgets
        { id: '222', slug: 'about' }, // no widgets -> skipped
        { id: '333', slug: 'loser', abTestId: 'ab-9' }, // AB variant -> never fetched
      ],
      detail: {
        111: HOME_WIDGETS_RAW, // full page detail carrying widgets
        222: { id: '222', slug: 'about', widgets: {} },
      },
    },
    calls,
  );
  try {
    const res = await pull(acct('529456'), { contentDir: dir, registry });
    assert.equal(res.pulled, 1);

    const out = readFileSync(join(dir, 'pages', 'home.widgets.json'), 'utf8');
    assert.ok(!out.includes(HOME_FORM_GUID), 'pulled file must not carry the raw GUID');
    assert.ok(out.includes('@form:'), 'pulled file carries a logical form token');
    assert.equal(Object.keys(registry.forms).length, 1, 'registry populated on pull');

    // AB variant id 333 was never fetched in detail.
    assert.ok(!calls.some((c) => c.url.includes('site-pages/333')), 'AB variant not fetched');
  } finally {
    globalThis.fetch = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. push() with a mocked fetch — resolves to TARGET account, PATCHes draft + schedules.
// ---------------------------------------------------------------------------

function writeCanonicalHome(dir) {
  const pagesDir = join(dir, 'pages');
  mkdirSync(pagesDir, { recursive: true });
  const canon = canonicalize(
    stableStringify({ widgets: normalizeWidgets(HOME_WIDGETS_RAW.widgets) }),
    srcRegistry(),
  );
  writeFileSync(join(pagesDir, 'home.widgets.json'), canon);
}

test('push resolves logical refs to the target portal, PATCHes draft, and schedules', async () => {
  const dir = tmpDir();
  writeCanonicalHome(dir);
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = makeFetch(
    { pages: [{ id: '700', slug: '' }], detail: {} },
    calls,
  );
  try {
    const res = await push(acct('246389711'), { contentDir: dir, registry: tgtRegistry() });
    assert.equal(res.pushed, 1);

    const patch = calls.find((c) => c.method === 'PATCH');
    assert.ok(patch, 'a draft PATCH was issued');
    assert.ok(patch.url.includes('site-pages/700/draft'), 'PATCH targets the slug-resolved page draft');
    // Body carries the TARGET account GUID, not the source one nor a logical token.
    assert.ok(patch.body.includes(TARGET_FORM_GUID), 'PATCH body resolved to target GUID');
    assert.ok(!patch.body.includes('@form:'), 'no logical token leaks into the PATCH body');
    assert.ok(!patch.body.includes(HOME_FORM_GUID), 'source GUID must not appear in target push');

    // Carrier empties preserved in the pushed payload (replace-not-merge).
    const sent = JSON.parse(patch.body);
    assert.deepEqual(sent.widgets.pricing.css, {});

    // A schedule POST followed with a future .000Z publishDate.
    const sch = calls.find((c) => c.method === 'POST' && c.url.includes('/schedule'));
    assert.ok(sch, 'a publish was scheduled');
    const body = JSON.parse(sch.body);
    assert.equal(body.id, '700');
    assert.match(body.publishDate, /\.000Z$/);
    assert.ok(new Date(body.publishDate).getTime() > Date.now(), 'publishDate is in the future');
  } finally {
    globalThis.fetch = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('push HARD-FAILS (no network write) when a referenced form is unmapped in the target', async () => {
  const dir = tmpDir();
  writeCanonicalHome(dir);
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = makeFetch({ pages: [{ id: '700', slug: '' }], detail: {} }, calls);
  try {
    await assert.rejects(
      () => push(acct('999'), { contentDir: dir, registry: loadRegistry({ portalId: '999' }) }),
      /no mapping|home-lead/,
    );
    assert.ok(!calls.some((c) => c.method === 'PATCH'), 'no draft PATCH on unresolved refs');
  } finally {
    globalThis.fetch = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('push skips a widgets file whose slug has no page in the target account', async () => {
  const dir = tmpDir();
  writeCanonicalHome(dir);
  const orig = globalThis.fetch;
  const calls = [];
  // No page with slug '' exists -> resolvePageBySlug returns null.
  globalThis.fetch = makeFetch({ pages: [{ id: '700', slug: 'other' }], detail: {} }, calls);
  try {
    const res = await push(acct('246389711'), { contentDir: dir, registry: tgtRegistry() });
    assert.equal(res.pushed, 0);
    assert.ok(!calls.some((c) => c.method === 'PATCH'), 'no PATCH when slug is unresolved');
    assert.ok(res.notes.some((n) => /no page/.test(n)));
  } finally {
    globalThis.fetch = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. DATA-LOSS guards (codex #8 + replace-not-merge): the push must never emit a
//    payload that blanks live content, and carrier empties must survive end-to-end.
// ---------------------------------------------------------------------------

// Write an arbitrary widgets object to <slug>.widgets.json (canonical bytes).
function writeWidgetsFile(dir, slug, widgetsObj) {
  const pagesDir = join(dir, 'pages');
  mkdirSync(pagesDir, { recursive: true });
  const stem = slug === '' ? 'home' : slug.replace(/\//g, '__');
  writeFileSync(join(pagesDir, `${stem}.widgets.json`), stableStringify({ widgets: widgetsObj }));
}

test('push REFUSES to blank a live page: an empty widgets map is skipped, never PATCHed', async () => {
  // A file that contains {"widgets":{}} would, under replace-not-merge, PATCH the
  // draft with an empty carrier and wipe every widget on the live page. The adapter
  // must treat this exactly like "no widgets to own" and skip it.
  const dir = tmpDir();
  writeWidgetsFile(dir, '', {}); // empty carrier
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = makeFetch({ pages: [{ id: '700', slug: '' }], detail: {} }, calls);
  try {
    const res = await push(acct('246389711'), { contentDir: dir, registry: tgtRegistry() });
    assert.equal(res.pushed, 0, 'nothing pushed for an empty carrier');
    assert.ok(!calls.some((c) => c.method === 'PATCH'), 'NO draft PATCH — must not blank the page');
    assert.ok(!calls.some((c) => c.method === 'POST' && c.url.includes('/schedule')), 'no publish scheduled');
    assert.ok(res.notes.some((n) => /empty|blank/i.test(n)), 'note explains the skip');
  } finally {
    globalThis.fetch = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('push preserves carrier EMPTIES end-to-end: empty-string body fields + css/child_css survive into the PATCH (replace-not-merge)', async () => {
  // codex #8: dropping a body field RESETS it on the live page. A widget whose body
  // carries deliberately-empty fields (section_id:'') and whose css/child_css/label
  // are empty must be sent VERBATIM — a thinner payload would blank rendered styling.
  const dir = tmpDir();
  writeWidgetsFile(dir, '', {
    hero: {
      name: 'hero',
      type: 'module',
      label: '',
      css: {},
      child_css: {},
      body: { headline: 'Hi', section_id: '', subhead: '' },
    },
  });
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = makeFetch({ pages: [{ id: '700', slug: '' }], detail: {} }, calls);
  try {
    const res = await push(acct('246389711'), { contentDir: dir, registry: tgtRegistry() });
    assert.equal(res.pushed, 1);
    const patch = calls.find((c) => c.method === 'PATCH');
    assert.ok(patch, 'a draft PATCH was issued');
    const sent = JSON.parse(patch.body).widgets.hero;
    // Empty-string body fields must be present (not omitted) so they don't reset.
    assert.equal(sent.body.section_id, '', 'empty-string body field survives the push');
    assert.equal(sent.body.subhead, '', 'second empty body field survives the push');
    assert.equal(sent.body.headline, 'Hi', 'populated body field intact alongside empties');
    // Empty carrier-level fields kept verbatim (load-bearing under replace-not-merge).
    assert.deepEqual(sent.css, {}, 'empty css kept');
    assert.deepEqual(sent.child_css, {}, 'empty child_css kept');
    assert.ok('label' in sent, 'empty label key kept');
    assert.equal(sent.label, '');
  } finally {
    globalThis.fetch = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('push ABORTS before ANY network write when the FIRST file has an unmapped ref (multi-file, no partial blanking)', async () => {
  // The hard-fail must happen during ref-resolve, BEFORE the page lookup and PATCH.
  // With a target registry missing the home-lead form, resolve() throws on the very
  // first file and NO write (GET/PATCH/schedule) for any file may occur.
  const dir = tmpDir();
  writeCanonicalHome(dir);
  // A second, fully-resolvable file — it must NOT get pushed because the throw aborts
  // the whole run before reaching it.
  writeWidgetsFile(dir, 'extra', {
    cta: { name: 'cta', type: 'module', label: '', css: {}, child_css: {}, body: { text: 'x' } },
  });
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = makeFetch({ pages: [{ id: '700', slug: '' }], detail: {} }, calls);
  try {
    await assert.rejects(
      () => push(acct('999'), { contentDir: dir, registry: loadRegistry({ portalId: '999' }) }),
      /no mapping|home-lead/,
    );
    assert.ok(!calls.some((c) => c.method === 'PATCH'), 'no draft PATCH anywhere on unresolved refs');
    assert.ok(!calls.some((c) => c.method === 'POST' && c.url.includes('/schedule')), 'no publish scheduled');
  } finally {
    globalThis.fetch = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('push is IDEMPOTENT: running twice issues the same PATCH+schedule and never grows/blanks the carrier', async () => {
  // Replace-not-merge means a second identical run must reproduce the SAME draft
  // payload (stable slug->id identity), not a thinner or different one.
  const dir = tmpDir();
  writeCanonicalHome(dir);
  const orig = globalThis.fetch;
  const run = async () => {
    const calls = [];
    globalThis.fetch = makeFetch({ pages: [{ id: '700', slug: '' }], detail: {} }, calls);
    const res = await push(acct('246389711'), { contentDir: dir, registry: tgtRegistry() });
    return { res, calls };
  };
  try {
    const a = await run();
    const b = await run();
    assert.equal(a.res.pushed, 1);
    assert.equal(b.res.pushed, 1, 'second run still pushes the same single file');
    const pa = a.calls.find((c) => c.method === 'PATCH');
    const pb = b.calls.find((c) => c.method === 'PATCH');
    // Same draft target and byte-identical widgets payload across runs.
    assert.equal(pa.url, pb.url, 'same draft endpoint');
    assert.deepEqual(JSON.parse(pa.body).widgets, JSON.parse(pb.body).widgets, 'identical carrier on re-push');
  } finally {
    globalThis.fetch = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Per-item scheduling + throw on schedule failure (codex #11): a schedule
//    failure leaves a draft/live DIVERGENCE (draft PATCHed, page not live), so
//    push must THROW — never a soft note — and each item's publishDate must be
//    computed FRESH (in the future) at its own schedule call.
// ---------------------------------------------------------------------------

// A fetch mock that resolves any slug to a page id and lets the caller control
// the schedule response. `scheduleResult(i)` returns { ok, status } for the i-th
// schedule POST so a test can fail one. Page id is derived from the URL's slug
// lookup; here every page is found (id from a per-slug map).
function makeSchedulableFetch({ idForSlug, scheduleResult }, calls) {
  let schedIdx = 0;
  return async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ method, url, body: opts.body });
    const u = String(url);
    // resolvePageBySlug lists site-pages; return every requested page so each
    // slug resolves to its mapped id.
    if (method === 'GET' && u.includes('/cms/v3/pages/site-pages') && !/site-pages\/\d+/.test(u)) {
      const results = Object.entries(idForSlug).map(([slug, id]) => ({ id, slug }));
      return { ok: true, status: 200, text: async () => JSON.stringify({ results }) };
    }
    if (method === 'PATCH' && /site-pages\/\d+\/draft/.test(u)) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ widgets: {} }) };
    }
    if (method === 'POST' && u.includes('/schedule')) {
      const r = scheduleResult ? scheduleResult(schedIdx) : { ok: true, status: 204, body: '' };
      schedIdx += 1;
      return { ok: r.ok, status: r.status, text: async () => r.body ?? '' };
    }
    return { ok: false, status: 404, text: async () => '{}' };
  };
}

// Write a minimal non-empty widgets file for a slug (canonical bytes, no refs).
function writeSimpleWidgets(dir, slug) {
  const pagesDir = join(dir, 'pages');
  mkdirSync(pagesDir, { recursive: true });
  const stem = slug === '' ? 'home' : slug.replace(/\//g, '__');
  writeFileSync(
    join(pagesDir, `${stem}.widgets.json`),
    stableStringify({ widgets: { hero: { name: 'hero', type: 'module', label: '', css: {}, child_css: {}, body: { text: slug } } } }),
  );
}

test('push computes a FRESH future publishDate per item (each schedule date is distinct and in the future)', async () => {
  const dir = tmpDir();
  writeSimpleWidgets(dir, 'a');
  writeSimpleWidgets(dir, 'b');
  writeSimpleWidgets(dir, 'c');
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = makeSchedulableFetch({ idForSlug: { a: '1', b: '2', c: '3' } }, calls);
  try {
    const before = Date.now();
    const res = await push(acct('246389711'), { contentDir: dir, registry: tgtRegistry() });
    assert.equal(res.pushed, 3);
    const scheds = calls.filter((c) => c.method === 'POST' && c.url.includes('/schedule'));
    assert.equal(scheds.length, 3, 'all three files scheduled');
    const dates = scheds.map((c) => new Date(JSON.parse(c.body).publishDate).getTime());
    // Each publishDate is strictly in the future relative to push start (fresh,
    // not a stale shared timestamp from before the loop).
    for (const d of dates) assert.ok(d > before, 'each publishDate is in the future');
    // Computed per item (Date.now() read inside the loop) → non-decreasing.
    assert.ok(dates[0] <= dates[1] && dates[1] <= dates[2], 'per-item dates are monotonic with the clock');
  } finally {
    globalThis.fetch = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('push THROWS on a schedule failure (no silent draft/live divergence)', async () => {
  // The draft PATCH succeeds, then the schedule POST returns 400. The old code
  // logged a soft note and counted the push as done, hiding a draft/live split.
  // The adapter must now THROW.
  const dir = tmpDir();
  writeSimpleWidgets(dir, 'a');
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = makeSchedulableFetch(
    {
      idForSlug: { a: '1' },
      scheduleResult: () => ({ ok: false, status: 400, body: JSON.stringify({ message: 'PUBLISH_DATE_IN_PAST' }) }),
    },
    calls,
  );
  try {
    await assert.rejects(
      () => push(acct('246389711'), { contentDir: dir, registry: tgtRegistry() }),
      /schedule .*failed|PUBLISH_DATE_IN_PAST|NOT live/,
    );
    // The draft PATCH did happen (proving the throw is AFTER the PATCH — the exact
    // divergence window the throw exists to surface).
    assert.ok(calls.some((c) => c.method === 'PATCH'), 'draft PATCH happened before the failed schedule');
  } finally {
    globalThis.fetch = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('push schedule failure on the SECOND item throws and stops (does not silently continue)', async () => {
  const dir = tmpDir();
  writeSimpleWidgets(dir, 'a');
  writeSimpleWidgets(dir, 'b');
  writeSimpleWidgets(dir, 'c');
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = makeSchedulableFetch(
    {
      idForSlug: { a: '1', b: '2', c: '3' },
      scheduleResult: (i) => (i === 1 ? { ok: false, status: 502, body: '{}' } : { ok: true, status: 204, body: '' }),
    },
    calls,
  );
  try {
    await assert.rejects(
      () => push(acct('246389711'), { contentDir: dir, registry: tgtRegistry() }),
      /schedule .*failed|502/,
    );
    const scheds = calls.filter((c) => c.method === 'POST' && c.url.includes('/schedule'));
    // One success then the failing one threw — the third item is never scheduled.
    assert.equal(scheds.length, 2, 'push stops at the failed schedule; no further schedule calls');
  } finally {
    globalThis.fetch = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pull KEEPS carrier empties (no empty-omit): pulled file retains css:{} and empty-string body fields', async () => {
  // The pull pipeline must not run a generic empty-omit over the carrier (codex #8).
  // Verify the written file still carries an empty css {} and an empty-string body
  // field, so a later push won't send a thinner, page-blanking payload.
  const dir = tmpDir();
  const registry = emptyRegistry('529456');
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = makeFetch(
    {
      pages: [{ id: '111', slug: '' }],
      detail: {
        111: {
          id: '111',
          slug: '',
          widgets: {
            hero: { name: 'hero', type: 'module', label: '', css: {}, child_css: {}, body: { headline: 'Hi', section_id: '' } },
          },
        },
      },
    },
    calls,
  );
  try {
    const res = await pull(acct('529456'), { contentDir: dir, registry });
    assert.equal(res.pulled, 1);
    const out = JSON.parse(readFileSync(join(dir, 'pages', 'home.widgets.json'), 'utf8'));
    assert.deepEqual(out.widgets.hero.css, {}, 'empty css preserved on pull (not omitted)');
    assert.deepEqual(out.widgets.hero.child_css, {}, 'empty child_css preserved on pull');
    assert.equal(out.widgets.hero.body.section_id, '', 'empty-string body field preserved on pull');
    assert.ok('label' in out.widgets.hero, 'empty label key preserved on pull');
  } finally {
    globalThis.fetch = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});
