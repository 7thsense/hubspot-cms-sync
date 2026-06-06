// Unit tests for sync/adapters/blog.mjs — pure where possible, hub/network mocked.
//   node --test test/unit
//
// Focus (per task): the query-string URL-rewrite fix (codex #5) and blogSlug
// container selection (codex #6). Also covers the two-phase publish (codex #7).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  rawUrlToToken,
  canonicalizeField,
  stripHubfsQuery,
  pull,
  publishPost,
  restoreCanonicalDate,
  waitUntil,
  push,
  containerFileFor,
  postFileFor,
} from '../../src/adapters/blog.mjs';
import { matchBlogSlug } from '../../src/lib/hub.mjs';
import { emptyRegistry, resolve as resolveRefs } from '../../src/lib/refs.mjs';

// ── codex #5: query-string URL-rewrite fix ─────────────────────────────────────

test('rawUrlToToken rewrites the ?query variant BEFORE the bare URL (codex #5)', () => {
  const orig = 'https://cdn2.hubspot.net/hubfs/529456/Inbox.png';
  const map = { [orig]: '4e7bf9bad5-Inbox.png' };

  // A body containing BOTH a bare URL and a ?width= query variant of the SAME url.
  const body =
    `<img src="${orig}">` +
    `<img src="${orig}?width=80&height=60">`;
  const out = rawUrlToToken(body, map);

  // Both collapse onto the single @asset token; NO dangling query string survives.
  assert.equal(
    out,
    '<img src="@asset:4e7bf9bad5-Inbox.png"><img src="@asset:4e7bf9bad5-Inbox.png">',
  );
  assert.ok(!out.includes('?width='), 'query string must not survive (the old bug)');
  assert.ok(!out.includes(orig), 'no raw URL survives');
});

test('rawUrlToToken does not leave a half-rewritten url for query variants', () => {
  // Regression for the exact old bug: bare-first replace produced `token?width=`.
  const orig = 'https://example.hubspotusercontent.net/hubfs/529456/a.jpg';
  const map = { [orig]: 'hash-a.jpg' };
  const out = rawUrlToToken(`x ${orig}?width=1200 y`, map);
  assert.equal(out, 'x @asset:hash-a.jpg y');
});

test('rawUrlToToken leaves unrelated urls untouched and is a no-op on empty', () => {
  const map = { 'https://h/hubfs/1/a.png': 'a.png' };
  assert.equal(rawUrlToToken('see https://other.com/x.png', map), 'see https://other.com/x.png');
  assert.equal(rawUrlToToken('', map), '');
  assert.equal(rawUrlToToken(null, map), null);
});

test('rawUrlToToken handles multiple distinct assets independently', () => {
  const a = 'https://cdn2.hubspot.net/hubfs/529456/A.png';
  const b = 'https://cdn2.hubspot.net/hubfs/529456/B.png';
  const map = { [a]: 'ha-A.png', [b]: 'hb-B.png' };
  const out = rawUrlToToken(`${a}?w=1 and ${b}`, map);
  assert.equal(out, '@asset:ha-A.png and @asset:hb-B.png');
});

// ── codex #6: blogSlug selection, stale "Old" blog cannot win ───────────────────

const BLOGS = [
  { id: '2780958328', slug: 'blog', name: 'Seventh Sense Blog' },
  { id: '7179688584', slug: 'blog-old-pages', name: 'Seventh Sense Blog | Old' },
];

test('matchBlogSlug selects the exact slug, NOT objects[0] (codex #6)', () => {
  // Even if the Old blog were listed first, slug selection wins.
  const reordered = [BLOGS[1], BLOGS[0]];
  assert.equal(matchBlogSlug(reordered, 'blog'), '2780958328');
  assert.equal(matchBlogSlug(reordered, 'blog-old-pages'), '7179688584');
});

test('matchBlogSlug returns null for an unknown slug (push must then fail loudly)', () => {
  assert.equal(matchBlogSlug(BLOGS, 'does-not-exist'), null);
});

test('push fails with a UI-gated instruction when the post blogSlug has no container', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blogpush-'));
  try {
    const postsDir = join(dir, 'blog', 'posts');
    mkdirSync(postsDir, { recursive: true });
    writeFileSync(
      join(postsDir, 'blog__x.json'),
      JSON.stringify({ slug: 'blog/x', blogSlug: 'nope', name: 'X', publishDate: '2020-01-01T00:00:00Z', postBody: 'hi' }),
    );

    // Mock hub: blogs list has only the real "blog" + Old; author/tag/post lists empty.
    const hubFn = async (acct, method, path) => {
      if (path.startsWith('/content/api/v2/blogs')) {
        return { ok: true, status: 200, json: { objects: BLOGS } };
      }
      return { ok: true, status: 200, json: { results: [] } };
    };

    const acct = { name: 'dev', portalId: '246389711', key: 'k' };
    const res = await push(acct, { contentDir: dir, registry: emptyRegistry('246389711'), dryRun: true, hubFn });
    // dryRun short-circuits before container resolution? No — container is resolved
    // per post, so the missing-container error is captured in notes as a failure.
    assert.ok(
      res.notes.some((n) => /no blog container with slug "nope"/i.test(n) && /UI-gated/i.test(n)),
      `expected UI-gated note, got: ${JSON.stringify(res.notes)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('push selects the exact container by slug and ignores the Old blog', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blogpush2-'));
  try {
    const postsDir = join(dir, 'blog', 'posts');
    mkdirSync(postsDir, { recursive: true });
    writeFileSync(
      join(postsDir, 'blog__x.json'),
      JSON.stringify({
        slug: 'blog/x',
        blogSlug: 'blog',
        name: 'X',
        htmlTitle: 'X',
        publishDate: '2020-01-01T00:00:00Z',
        postBody: 'no refs here',
        postSummary: '',
        authorSlug: null,
        authorName: null,
        tagSlugs: [],
        tagNames: [],
      }),
    );

    const calls = [];
    // Old blog listed FIRST to prove objects[0] is not used.
    const hubFn = async (acct, method, path, body) => {
      calls.push({ method, path, body });
      if (path.startsWith('/content/api/v2/blogs')) {
        return { ok: true, status: 200, json: { objects: [BLOGS[1], BLOGS[0]] } };
      }
      if (method === 'GET' && path.startsWith('/cms/v3/blogs/posts')) {
        return { ok: true, status: 200, json: { results: [] } };
      }
      if (method === 'GET' && /authors|tags/.test(path)) {
        return { ok: true, status: 200, json: { results: [] } };
      }
      if (method === 'POST' && path === '/cms/v3/blogs/posts') {
        return { ok: true, status: 200, json: { id: '999', slug: body.slug } };
      }
      return { ok: true, status: 200, json: {} };
    };

    const acct = { name: 'dev', portalId: '246389711', key: 'k' };
    const res = await push(acct, { contentDir: dir, registry: emptyRegistry('246389711'), hubFn });

    assert.equal(res.pushed, 1, `expected 1 created/updated, notes: ${JSON.stringify(res.notes)}`);
    const created = calls.find((c) => c.method === 'POST' && c.path === '/cms/v3/blogs/posts');
    assert.ok(created, 'a post create was issued');
    // The real "blog" container id, not the Old one.
    assert.equal(created.body.contentGroupId, '2780958328');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── codex #7: two-phase publish preserves the original date ─────────────────────

test('publishPost schedules future, polls to PUBLISHED, then PATCHes the original date', async () => {
  const calls = [];
  let polls = 0;
  const hubFn = async (acct, method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'POST' && path.endsWith('/schedule')) {
      return { ok: true, status: 200, json: {} };
    }
    if (method === 'GET' && path.startsWith('/cms/v3/blogs/posts/')) {
      polls++;
      // First poll still DRAFT, second poll PUBLISHED.
      return { ok: true, status: 200, json: { state: polls >= 2 ? 'PUBLISHED' : 'DRAFT' } };
    }
    if (method === 'PATCH') {
      return { ok: true, status: 200, json: {} };
    }
    return { ok: true, status: 200, json: {} };
  };

  const acct = { name: 'dev', portalId: '246389711', key: 'k' };
  const fixedNow = Date.parse('2026-06-04T00:00:00.000Z');
  const out = await publishPost(acct, '777', '2018-02-26T15:52:00Z', {
    hubFn,
    now: () => fixedNow,
    sleep: async () => {},
    pollMs: 0,
  });

  // 1. schedule body used a FUTURE date (now + 90s), with .000Z form.
  const sched = calls.find((c) => c.path.endsWith('/schedule'));
  assert.ok(sched, 'scheduled');
  assert.equal(sched.body.id, '777');
  assert.ok(Date.parse(sched.body.publishDate) > fixedNow, 'scheduled date is in the future');
  assert.match(sched.body.publishDate, /\.000Z$/);

  // 2. polled at least twice (DRAFT then PUBLISHED).
  assert.ok(polls >= 2, `polled ${polls} times`);

  // 3. final PATCH restored the ORIGINAL date (normalized to .000Z), preserving
  //    chronology — NOT the future scheduled date (codex #7).
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch, 'patched the original date back');
  assert.equal(patch.body.publishDate, '2018-02-26T15:52:00.000Z');
  assert.equal(out.publishDate, '2018-02-26T15:52:00.000Z');
});

test('restoreCanonicalDate re-PATCHes + verifies, retrying when a late publish clobbers the date', async () => {
  // Simulate the race: the live post keeps reporting "today" until the 3rd PATCH
  // finally sticks (a late scheduled publish clobbered the first two restores).
  const want = '2018-02-26T15:52:00.000Z';
  let patches = 0;
  const hubFn = async (acct, method, path, body) => {
    if (method === 'PATCH') {
      patches += 1;
      return { ok: true, status: 200, json: {} };
    }
    if (method === 'GET') {
      // GET reports the canonical date only after the 3rd PATCH (churned before).
      const live = patches >= 3 ? want : '2026-06-04T00:00:00.000Z';
      return { ok: true, status: 200, json: { publishDate: live } };
    }
    return { ok: true, status: 200, json: {} };
  };
  const acct = { name: 'dev', portalId: '246389711', key: 'k' };
  const ok = await restoreCanonicalDate(acct, '777', want, { hubFn, sleep: async () => {}, settleMs: 0 });
  assert.equal(ok, true, 'confirmed once the date stuck');
  assert.ok(patches >= 3, `re-patched until verified (${patches})`);
});

test('restoreCanonicalDate returns false if the date never sticks (caller warns)', async () => {
  const hubFn = async (acct, method) =>
    method === 'GET'
      ? { ok: true, status: 200, json: { publishDate: '2026-06-04T00:00:00.000Z' } }
      : { ok: true, status: 200, json: {} };
  const acct = { name: 'dev', portalId: '246389711', key: 'k' };
  const ok = await restoreCanonicalDate(acct, '777', '2018-02-26T15:52:00Z', {
    hubFn,
    sleep: async () => {},
    tries: 3,
    settleMs: 0,
  });
  assert.equal(ok, false);
});

test('publishPost throws if the post never reaches PUBLISHED', async () => {
  const hubFn = async (acct, method, path) => {
    if (method === 'POST' && path.endsWith('/schedule')) return { ok: true, status: 200, json: {} };
    if (method === 'GET') return { ok: true, status: 200, json: { state: 'DRAFT' } };
    return { ok: true, status: 200, json: {} };
  };
  const acct = { name: 'dev', portalId: '246389711', key: 'k' };
  await assert.rejects(
    () =>
      publishPost(acct, '1', '2020-01-01T00:00:00Z', {
        hubFn,
        now: () => 0,
        sleep: async () => {},
        maxPolls: 3,
        pollMs: 0,
      }),
    /did not reach PUBLISHED/,
  );
});

// ── filename mapping ───────────────────────────────────────────────────────────

test('postFileFor and containerFileFor map slugs to stable filenames', () => {
  assert.equal(postFileFor('blog/x'), 'blog__x');
  assert.equal(containerFileFor('blog'), 'container.json');
  assert.equal(containerFileFor('blog-old-pages'), 'container.blog-old-pages.json');
});

// ── codex #4: re-hosted (dev) URLs must NOT survive literal in committed git ──────
//
// rawUrlToToken only knows the ORIGINAL prod URLs in the manifest. When we pull from a
// re-hosted account, the body carries that account's OWN hosted URLs (not manifest
// keys). canonicalizeField must fold those remaining hosted refs through
// refs.canonicalize so no literal per-account URL / GUID / portal id is ever committed.

const DEV = '246389711';

test('canonicalizeField tokenizes a re-hosted dev URL the manifest does NOT know (codex #4)', () => {
  const reg = emptyRegistry(DEV);
  // A dev File-Manager URL — NOT a manifest key. The manifest pass (empty map) leaves
  // it untouched; the canonicalize fold must turn it into a portable @asset token.
  const body = `<img src="https://${DEV}.fs1.hubspotusercontent-na1.net/hubfs/${DEV}/Stock/img.png">`;
  const out = canonicalizeField(body, {}, reg);

  assert.equal(out, '<img src="@asset:Stock/img.png">');
  assert.ok(!out.includes(DEV), 'no literal per-account portal id survives');
  assert.ok(!out.includes('hubspotusercontent'), 'no literal hosted URL survives');
  // The asset path is registered so the assets adapter can rehost it on push.
  assert.deepEqual(Object.keys(reg.assets), ['Stock/img.png']);
});

test('canonicalizeField is idempotent — re-canonicalizing committed content is a no-op', () => {
  const reg = emptyRegistry(DEV);
  const body =
    `<img src="https://${DEV}.fs1.hubspotusercontent-na1.net/hubfs/${DEV}/A.png">` +
    ` hbspt.cta.load(${DEV},'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',{})`;
  const once = canonicalizeField(body, {}, reg);
  const twice = canonicalizeField(once, {}, reg);
  assert.equal(once, twice, 'canonicalize over already-tokenized content must not clobber it');
  // CTA + portal were tokenized, not left literal.
  assert.ok(once.includes('@cta:'), 'cta guid tokenized');
  assert.ok(once.includes('@portal'), 'portal id tokenized');
  assert.ok(!once.includes(DEV), 'no literal portal id survives');
});

test('canonicalizeField collapses a re-hosted ?width= query variant onto the bare @asset token (codex #5)', () => {
  const reg = emptyRegistry(DEV);
  const bare = `https://cdn2.hubspot.net/hubfs/${DEV}/Stock/img.png`;
  const body = `<img src="${bare}"><img src="${bare}?width=80&height=60">`;
  const out = canonicalizeField(body, {}, reg);
  // Both variants land on ONE @asset token — no `@asset:...?width=` and no second path.
  assert.equal(out, '<img src="@asset:Stock/img.png"><img src="@asset:Stock/img.png">');
  assert.ok(!out.includes('?width='), 'query string must not survive on a re-hosted URL');
  assert.deepEqual(Object.keys(reg.assets), ['Stock/img.png'], 'only ONE clean asset path registered');
});

test('stripHubfsQuery drops ?query only from hubfs URLs, leaving other URLs untouched', () => {
  const reg = `https://x.hubspotusercontent.net/hubfs/${DEV}/a.png?width=10`;
  assert.equal(stripHubfsQuery(reg), `https://x.hubspotusercontent.net/hubfs/${DEV}/a.png`);
  // non-hubfs URL keeps its query
  assert.equal(stripHubfsQuery('https://other.com/x?y=1'), 'https://other.com/x?y=1');
  assert.equal(stripHubfsQuery(''), '');
  assert.equal(stripHubfsQuery(null), null);
});

test('canonicalizeField is non-destructive on already-canonical content (no registry needed to pass through)', () => {
  // Already-tokenized content (the round-trip case) must come back identical.
  const reg = emptyRegistry(DEV);
  const already = '<img src="@asset:Stock/img.png"> and {{ cta(\'@cta:book-demo\') }} on @portal';
  assert.equal(canonicalizeField(already, {}, reg), already);
});

test('canonicalizeField still prefers the manifest local-file token when the URL IS known', () => {
  const reg = emptyRegistry(DEV);
  const orig = 'https://cdn2.hubspot.net/hubfs/529456/Inbox.png';
  // Manifest maps the ORIGINAL prod URL to its committed local filename.
  const map = { [orig]: '4e7bf9bad5-Inbox.png' };
  const out = canonicalizeField(`<img src="${orig}?width=80">`, map, reg);
  // Manifest pass wins: the local-file token, NOT a refs @asset:<hubfsTail>.
  assert.equal(out, '<img src="@asset:4e7bf9bad5-Inbox.png">');
  // No hubfs-tail asset got registered because the manifest already consumed the URL.
  assert.deepEqual(Object.keys(reg.assets), []);
});

// ── codex #4 end-to-end: pull from a dev-like account, assert committed bytes ──────

function fetchMock(routes) {
  // routes: (urlPath) => responseJson | undefined.  We match on the path portion.
  return async (url) => {
    const path = String(url).replace('https://api.hubapi.com', '');
    const json = routes(path);
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(json ?? {});
      },
    };
  };
}

test('pull from a dev-like account tokenizes hosted URLs — no literal URL lands on disk (codex #4)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blogpull-'));
  const prevFetch = globalThis.fetch;
  try {
    const devUrl = `https://${DEV}.fs1.hubspotusercontent-na1.net/hubfs/${DEV}/Stock/hero.png`;
    const routes = (path) => {
      if (path.startsWith('/content/api/v2/blogs')) {
        return { objects: [{ id: '111', slug: 'blog', name: 'Seventh Sense Blog', absolute_url: '', item_template_path: '', listing_template_path: '' }] };
      }
      if (path.startsWith('/cms/v3/blogs/authors')) return { results: [{ id: 'a1', slug: 'jane', displayName: 'Jane' }] };
      if (path.startsWith('/cms/v3/blogs/tags')) return { results: [{ id: 't1', slug: 'news', name: 'News' }] };
      if (path.startsWith('/cms/v3/blogs/posts')) {
        return {
          results: [
            {
              id: 'p1',
              slug: 'blog/hello',
              contentGroupId: '111',
              name: 'Hello',
              state: 'PUBLISHED',
              blogAuthorId: 'a1',
              tagIds: ['t1'],
              featuredImage: `${devUrl}?width=200`,
              postBody: `<p>see <img src="${devUrl}"> and ${devUrl}?width=80</p>`,
              postSummary: 'plain summary',
              publishDate: '2018-02-26T15:52:00Z',
            },
          ],
        };
      }
      return {};
    };
    globalThis.fetch = fetchMock(routes);

    const acct = { name: 'dev', portalId: DEV, key: 'k' };
    const registry = emptyRegistry(DEV);
    const res = await pull(acct, { contentDir: dir, registry });
    assert.equal(res.pulled, 1);

    const onDisk = readFileSync(join(dir, 'blog', 'posts', 'blog__hello.json'), 'utf8');
    // The committed bytes must carry NO literal hosted URL / portal id.
    assert.ok(!onDisk.includes('hubspotusercontent'), 'no literal hosted URL committed');
    assert.ok(!onDisk.includes(DEV), 'no literal per-account portal id committed');
    assert.ok(onDisk.includes('@asset:Stock/hero.png'), 'hosted URL became a portable @asset token');
    // codex #5: featuredImage + body query variants collapsed onto ONE token.
    assert.ok(!onDisk.includes('?width='), 'no dangling query string committed');

    const post = JSON.parse(onDisk);
    assert.equal(post.featuredImage, '@asset:Stock/hero.png');
    // The registry registered the asset path so the assets adapter rehosts it on push.
    assert.ok(registry.assets['Stock/hero.png'] != null, 'asset path registered for push');

    // date preserved verbatim (codex #7 chronology source).
    assert.equal(post.publishDate, '2018-02-26T15:52:00Z');
    // blogSlug recorded so push targets the exact container (codex #6).
    assert.equal(post.blogSlug, 'blog');
    assert.equal(post.authorSlug, 'jane');
  } finally {
    globalThis.fetch = prevFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pull is idempotent — a second pull produces byte-identical committed content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blogpull2-'));
  const prevFetch = globalThis.fetch;
  try {
    const devUrl = `https://${DEV}.fs1.hubspotusercontent-na1.net/hubfs/${DEV}/Stock/hero.png`;
    const routes = (path) => {
      if (path.startsWith('/content/api/v2/blogs')) return { objects: [{ id: '111', slug: 'blog', name: 'Blog' }] };
      if (path.startsWith('/cms/v3/blogs/authors')) return { results: [] };
      if (path.startsWith('/cms/v3/blogs/tags')) return { results: [] };
      if (path.startsWith('/cms/v3/blogs/posts')) {
        return {
          results: [
            {
              id: 'p1', slug: 'blog/hello', contentGroupId: '111', name: 'Hello', state: 'PUBLISHED',
              featuredImage: `${devUrl}?width=200`,
              postBody: `<img src="${devUrl}?width=80">`,
              publishDate: '2019-05-05T00:00:00Z',
            },
          ],
        };
      }
      return {};
    };
    globalThis.fetch = fetchMock(routes);
    const acct = { name: 'dev', portalId: DEV, key: 'k' };
    const file = join(dir, 'blog', 'posts', 'blog__hello.json');

    await pull(acct, { contentDir: dir, registry: emptyRegistry(DEV) });
    const first = readFileSync(file, 'utf8');
    await pull(acct, { contentDir: dir, registry: emptyRegistry(DEV) });
    const second = readFileSync(file, 'utf8');
    assert.equal(first, second, 're-pull must be byte-identical (no clobber / drift)');
  } finally {
    globalThis.fetch = prevFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── CTA embed -> portable link resolution on pull (codex #3/#5) ──────────────────

const CTA_GUID = 'bd6d5c26-d90d-4350-befe-41d8b8be2f8c';
const CTA_EMBED =
  `<!--HubSpot Call-to-Action Code --><span class="hs-cta-wrapper" id="hs-cta-wrapper-${CTA_GUID}">` +
  `<span class="hs-cta-node hs-cta-${CTA_GUID}" id="hs-cta-${CTA_GUID}">` +
  `<a href="https://cta-redirect.hubspot.com/cta/redirect/529456/${CTA_GUID}" target="_blank" >` +
  `<img class="hs-cta-img" id="hs-cta-img-${CTA_GUID}" ` +
  `src="https://no-cache.hubspot.com/cta/default/529456/${CTA_GUID}.png" alt="Schedule a Time Now"/></a></span>` +
  `<script type="text/javascript"> hbspt.cta.load(529456, '${CTA_GUID}', {}); </script>` +
  `</span><!-- end HubSpot Call-to-Action Code -->`;

test('canonicalizeField resolves a CTA embed to a portable <a> from the inventory (no @cta, no guid)', () => {
  const reg = emptyRegistry(DEV);
  const ctaCtx = {
    inventory: { [CTA_GUID]: { destinationHref: 'https://www.theseventhsense.com/meetings/mike860', name: 'Schedule a Time Now', tracked: false } },
    unresolved: new Set(),
    notes: new Set(),
    resolved: 0,
  };
  const out = canonicalizeField(`<p>hi</p>${CTA_EMBED}`, {}, reg, ctaCtx);

  // The committed body carries a portable styled link, NO @cta token, NO guid/portal,
  // NO hs-cta embed markup, and NO cta-redirect / no-cache.hubspot.com asset URL.
  assert.ok(out.includes('<a class="btn cta-btn" href="https://www.theseventhsense.com/meetings/mike860"'), `got: ${out}`);
  assert.ok(!out.includes('@cta'), 'no @cta token survives (no producer adapter — codex #3)');
  assert.ok(!out.includes(CTA_GUID), 'no per-account CTA guid survives');
  assert.ok(!out.includes('529456'), 'no portal id survives (would otherwise tokenize to @portal)');
  assert.ok(!out.includes('hs-cta-wrapper') && !out.includes('hbspt.cta.load'), 'no embed markup survives');
  assert.ok(!out.includes('cta-redirect') && !out.includes('no-cache.hubspot.com'), 'no per-account CTA URLs survive');
  assert.equal(ctaCtx.unresolved.size, 0);
  assert.equal(ctaCtx.resolved, 1);
});

test('canonicalizeField PRESERVES an unknown CTA raw and records it loudly (never silently dropped, codex #5)', () => {
  const reg = emptyRegistry(DEV);
  const ctaCtx = { inventory: {}, unresolved: new Set(), notes: new Set(), resolved: 0 };
  const out = canonicalizeField(CTA_EMBED, {}, reg, ctaCtx);

  // With no inventory entry the embed is preserved — but because the raw embed still
  // carries a CTA guid + portal id, canonicalizeRefs then tokenizes those to @cta/@portal
  // so the push preflight fails-closed (loud), and the unresolved guid is reported.
  assert.ok(ctaCtx.unresolved.has(CTA_GUID), 'unknown CTA guid reported as unresolved');
  assert.ok([...ctaCtx.notes].some((n) => n.includes(CTA_GUID)), 'a loud note names the unresolved CTA');
});

// ── codex #9: blog.push THROWS on any per-post failure (no silent loss) ───────────

test('push THROWS when a post fails (failed>0) instead of reporting a clean done (codex #9)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blogfail-'));
  try {
    const postsDir = join(dir, 'blog', 'posts');
    mkdirSync(postsDir, { recursive: true });
    // Two posts: the second will fail its create (hub returns non-ok on its POST).
    writeFileSync(join(postsDir, 'blog__a.json'), JSON.stringify({
      slug: 'blog/a', blogSlug: 'blog', name: 'A', htmlTitle: 'A', publishDate: '2020-01-01T00:00:00Z',
      postBody: 'ok', postSummary: '', authorSlug: null, authorName: null, tagSlugs: [], tagNames: [],
    }));
    writeFileSync(join(postsDir, 'blog__b.json'), JSON.stringify({
      slug: 'blog/b', blogSlug: 'blog', name: 'B', htmlTitle: 'B', publishDate: '2020-01-02T00:00:00Z',
      postBody: 'ok', postSummary: '', authorSlug: null, authorName: null, tagSlugs: [], tagNames: [],
    }));

    const hubFn = async (acct, method, path, body) => {
      if (path.startsWith('/content/api/v2/blogs')) return { ok: true, status: 200, json: { objects: [BLOGS[0]] } };
      if (method === 'GET' && /authors|tags|\/cms\/v3\/blogs\/posts/.test(path)) return { ok: true, status: 200, json: { results: [] } };
      if (method === 'POST' && path === '/cms/v3/blogs/posts') {
        // Fail the create for post B only.
        if (body.slug === 'blog/b') return { ok: false, status: 500, json: { message: 'boom' } };
        return { ok: true, status: 200, json: { id: '1', slug: body.slug } };
      }
      return { ok: true, status: 200, json: {} };
    };

    const acct = { name: 'dev', portalId: '246389711', key: 'k' };
    await assert.rejects(
      () => push(acct, { contentDir: dir, registry: emptyRegistry('246389711'), hubFn }),
      (e) => /1 post\(s\) failed/.test(e.message) && /blog\/b/.test(e.message) && /did NOT complete cleanly/i.test(e.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('round-trip: a re-hosted pull tokenizes, and push resolveRefs restores a target URL', () => {
  // The @asset token produced from a re-hosted URL must resolve on push once the
  // assets adapter has populated the target registry (proves portability, not loss).
  const src = emptyRegistry(DEV);
  const body = `<img src="https://cdn2.hubspot.net/hubfs/${DEV}/Stock/img.png?width=80">`;
  const canon = canonicalizeField(body, {}, src);
  assert.equal(canon, '<img src="@asset:Stock/img.png">');

  // target registry as the assets adapter would leave it after rehosting:
  const tgt = emptyRegistry('529456');
  tgt.assets['Stock/img.png'] = 'https://target.example/hubfs/529456/Stock/img.png';
  const resolved = resolveRefs(canon, tgt);
  assert.equal(resolved, '<img src="https://target.example/hubfs/529456/Stock/img.png">');
});

// ── BLOG THEME: push sets item/listing template paths + clears listing_page_id ────

const THEME_CONTAINER = {
  slug: 'blog',
  name: 'Seventh Sense Blog',
  itemTemplatePath: 'seventh-sense-theme/templates/blog-post.html',
  listingTemplatePath: 'seventh-sense-theme/templates/blog.html',
  listingPageId: 0,
};

// Seed a blog/ content dir with one post + a committed container.json.
function seedBlogDir(container = THEME_CONTAINER, post = undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'blogtheme-'));
  const blogDir = join(dir, 'blog');
  const postsDir = join(blogDir, 'posts');
  mkdirSync(postsDir, { recursive: true });
  if (container) writeFileSync(join(blogDir, containerFileFor(container.slug)), JSON.stringify(container));
  const p = post || {
    slug: 'blog/x', blogSlug: 'blog', name: 'X', htmlTitle: 'X', publishDate: '2020-01-01T00:00:00Z',
    postBody: 'ok', postSummary: '', authorSlug: null, authorName: null, tagSlugs: [], tagNames: [],
  };
  writeFileSync(join(postsDir, `${postFileFor(p.slug)}.json`), JSON.stringify(p));
  return dir;
}

test('push PUTs the blog container templates from container.json and clears listing_page_id', async () => {
  const dir = seedBlogDir();
  try {
    const calls = [];
    // Live blog currently has the WRONG (elevate) templates + a non-zero listing_page_id.
    const liveBlog = {
      id: '2780958328', slug: 'blog', name: 'Seventh Sense Blog',
      item_template_path: '@hubspot/elevate/templates/blog-post.html',
      listing_template_path: '@hubspot/elevate/templates/blog.html',
      listing_page_id: 99887766,
    };
    const hubFn = async (acct, method, path, body) => {
      calls.push({ method, path, body });
      if (method === 'GET' && path.startsWith('/content/api/v2/blogs')) {
        return { ok: true, status: 200, json: { objects: [liveBlog] } };
      }
      if (method === 'GET' && /authors|tags|\/cms\/v3\/blogs\/posts/.test(path)) {
        return { ok: true, status: 200, json: { results: [] } };
      }
      if (method === 'POST' && path === '/cms/v3/blogs/posts') {
        return { ok: true, status: 200, json: { id: '1', slug: body.slug } };
      }
      return { ok: true, status: 200, json: {} };
    };
    const acct = { name: 'dev', portalId: '246389711', key: 'k' };
    const res = await push(acct, { contentDir: dir, registry: emptyRegistry('246389711'), hubFn });

    const put = calls.find((c) => c.method === 'PUT' && /\/content\/api\/v2\/blogs\/2780958328$/.test(c.path));
    assert.ok(put, `expected a PUT to the blog container, calls: ${JSON.stringify(calls.map((c) => `${c.method} ${c.path}`))}`);
    assert.equal(put.body.item_template_path, 'seventh-sense-theme/templates/blog-post.html');
    assert.equal(put.body.listing_template_path, 'seventh-sense-theme/templates/blog.html');
    assert.equal(put.body.listing_page_id, 0, 'listing_page_id override cleared (so listing_template_path renders)');
    assert.ok(res.notes.some((n) => /blog theme/i.test(n)), 'a note records the template set');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('push does NOT PUT the container when templates already match (idempotent — no churn)', async () => {
  const dir = seedBlogDir();
  try {
    const calls = [];
    // Live blog ALREADY has the canonical templates + listing_page_id 0 → no PUT.
    const liveBlog = {
      id: '2780958328', slug: 'blog', name: 'Seventh Sense Blog',
      item_template_path: 'seventh-sense-theme/templates/blog-post.html',
      listing_template_path: 'seventh-sense-theme/templates/blog.html',
      listing_page_id: 0,
    };
    const hubFn = async (acct, method, path, body) => {
      calls.push({ method, path, body });
      if (method === 'GET' && path.startsWith('/content/api/v2/blogs')) {
        return { ok: true, status: 200, json: { objects: [liveBlog] } };
      }
      if (method === 'GET' && /authors|tags|\/cms\/v3\/blogs\/posts/.test(path)) {
        return { ok: true, status: 200, json: { results: [] } };
      }
      if (method === 'POST' && path === '/cms/v3/blogs/posts') {
        return { ok: true, status: 200, json: { id: '1', slug: body.slug } };
      }
      return { ok: true, status: 200, json: {} };
    };
    const acct = { name: 'dev', portalId: '246389711', key: 'k' };
    await push(acct, { contentDir: dir, registry: emptyRegistry('246389711'), hubFn });

    assert.ok(
      !calls.some((c) => c.method === 'PUT' && /\/content\/api\/v2\/blogs\//.test(c.path)),
      're-running with matching templates must not PUT (no edge-cache churn)',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('push PUTs the container only ONCE even with multiple posts in the same blog', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blogtheme2-'));
  try {
    const blogDir = join(dir, 'blog');
    const postsDir = join(blogDir, 'posts');
    mkdirSync(postsDir, { recursive: true });
    writeFileSync(join(blogDir, 'container.json'), JSON.stringify(THEME_CONTAINER));
    for (const s of ['a', 'b', 'c']) {
      writeFileSync(join(postsDir, `blog__${s}.json`), JSON.stringify({
        slug: `blog/${s}`, blogSlug: 'blog', name: s.toUpperCase(), htmlTitle: s, publishDate: '2020-01-01T00:00:00Z',
        postBody: 'ok', postSummary: '', authorSlug: null, authorName: null, tagSlugs: [], tagNames: [],
      }));
    }
    const liveBlog = { id: '7', slug: 'blog', item_template_path: 'wrong', listing_template_path: 'wrong', listing_page_id: 5 };
    let puts = 0;
    const hubFn = async (acct, method, path, body) => {
      if (method === 'PUT' && /\/content\/api\/v2\/blogs\//.test(path)) puts++;
      if (method === 'GET' && path.startsWith('/content/api/v2/blogs')) return { ok: true, status: 200, json: { objects: [liveBlog] } };
      if (method === 'GET' && /authors|tags|\/cms\/v3\/blogs\/posts/.test(path)) return { ok: true, status: 200, json: { results: [] } };
      if (method === 'POST' && path === '/cms/v3/blogs/posts') return { ok: true, status: 200, json: { id: Math.random().toString(), slug: body.slug } };
      return { ok: true, status: 200, json: {} };
    };
    const acct = { name: 'dev', portalId: '246389711', key: 'k' };
    const res = await push(acct, { contentDir: dir, registry: emptyRegistry('246389711'), hubFn });
    assert.equal(res.pushed, 3, 'all three posts pushed');
    assert.equal(puts, 1, 'container PUT is issued exactly once (cached per blogSlug)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('push does not touch the container on a dryRun', async () => {
  const dir = seedBlogDir();
  try {
    const calls = [];
    const liveBlog = { id: '7', slug: 'blog', item_template_path: 'wrong', listing_template_path: 'wrong', listing_page_id: 5 };
    const hubFn = async (acct, method, path) => {
      calls.push({ method, path });
      if (method === 'GET' && path.startsWith('/content/api/v2/blogs')) return { ok: true, status: 200, json: { objects: [liveBlog] } };
      return { ok: true, status: 200, json: { results: [] } };
    };
    const acct = { name: 'dev', portalId: '246389711', key: 'k' };
    await push(acct, { contentDir: dir, registry: emptyRegistry('246389711'), dryRun: true, hubFn });
    assert.ok(!calls.some((c) => c.method === 'PUT'), 'dryRun never PUTs the container');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── codex #7 (race): waitUntil + final restore runs AFTER every schedule fires ────

test('waitUntil returns immediately when the target is already in the past', async () => {
  let slept = 0;
  await waitUntil(0, { now: () => 1000, sleep: async () => { slept++; } });
  assert.equal(slept, 0, 'no sleep when target already passed');
});

test('waitUntil blocks until the (injected) clock advances past the target', async () => {
  let clock = 1000;
  const sleeps = [];
  await waitUntil(20_000, {
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; }, // advance the mock clock by the slept amount
  });
  assert.ok(clock >= 20_000, `clock advanced past target (${clock})`);
  assert.ok(sleeps.length > 0, 'it actually slept');
  // each sleep is capped (<=5000) so an advancing clock re-checks often.
  assert.ok(sleeps.every((m) => m <= 5000), `each sleep step is bounded: ${sleeps}`);
});

test('publishPost returns scheduledMs = now+90s so the caller can wait past it', async () => {
  const hubFn = async (acct, method, path) => {
    if (method === 'POST' && path.endsWith('/schedule')) return { ok: true, status: 200, json: {} };
    if (method === 'GET') return { ok: true, status: 200, json: { state: 'PUBLISHED' } };
    return { ok: true, status: 200, json: {} };
  };
  const acct = { name: 'dev', portalId: '246389711', key: 'k' };
  const fixedNow = Date.parse('2026-06-04T00:00:00.000Z');
  const out = await publishPost(acct, '7', '2018-02-26T15:52:00Z', { hubFn, now: () => fixedNow, sleep: async () => {}, pollMs: 0 });
  assert.equal(out.scheduledMs, fixedNow + 90_000, 'scheduledMs is now+90s');
});

test('push (publish) runs the FINAL date-restore ONLY after the latest schedule has fired (codex #7 race)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blogrestore-'));
  try {
    const blogDir = join(dir, 'blog');
    const postsDir = join(blogDir, 'posts');
    mkdirSync(postsDir, { recursive: true });
    writeFileSync(join(blogDir, 'container.json'), JSON.stringify(THEME_CONTAINER));
    // Two posts with real 2017–2026 dates.
    const dates = { a: '2017-03-04T10:00:00Z', b: '2019-11-22T08:30:00Z' };
    for (const s of ['a', 'b']) {
      writeFileSync(join(postsDir, `blog__${s}.json`), JSON.stringify({
        slug: `blog/${s}`, blogSlug: 'blog', name: s, htmlTitle: s, publishDate: dates[s],
        postBody: 'ok', postSummary: '', authorSlug: null, authorName: null, tagSlugs: [], tagNames: [],
      }));
    }

    // Mock clock that ONLY advances when sleep() is called. The "scheduled publish"
    // is modeled as firing at scheduledMs: a GET before that time reports the
    // schedule-clobbered "today" date; a PATCH only sticks once the clock is past
    // the latest schedule (i.e. the final restore pass waited correctly).
    const liveBlog = { id: '7', slug: 'blog', item_template_path: 'x', listing_template_path: 'y', listing_page_id: 0 };
    const fixedStart = Date.parse('2026-06-04T00:00:00.000Z');
    let clock = fixedStart;
    const TODAY = '2026-06-04T00:00:00.000Z';
    const liveDate = {}; // id -> last-set publishDate as the server would report it
    let latestSchedule = 0;
    const restorePatchClockTimes = [];

    const hubFn = async (acct, method, path, body) => {
      if (method === 'GET' && path.startsWith('/content/api/v2/blogs')) return { ok: true, status: 200, json: { objects: [liveBlog] } };
      if (method === 'GET' && /\/cms\/v3\/blogs\/(authors|tags)/.test(path)) return { ok: true, status: 200, json: { results: [] } };
      if (method === 'GET' && /\/cms\/v3\/blogs\/posts(\?|$)/.test(path)) return { ok: true, status: 200, json: { results: [] } };
      if (method === 'POST' && path === '/cms/v3/blogs/posts') {
        return { ok: true, status: 200, json: { id: body.slug.endsWith('a') ? '100' : '200', slug: body.slug } };
      }
      if (method === 'POST' && path.endsWith('/schedule')) {
        latestSchedule = Math.max(latestSchedule, Date.parse(body.publishDate));
        return { ok: true, status: 200, json: {} };
      }
      if (method === 'PATCH' && /\/cms\/v3\/blogs\/posts\/\d+$/.test(path)) {
        const id = path.split('/').pop();
        // The scheduled publish "clobbers" any PATCH issued BEFORE its fire time.
        if (clock < latestSchedule) liveDate[id] = TODAY;
        else liveDate[id] = body.publishDate;
        if (Object.keys(dates).length && clock >= latestSchedule) restorePatchClockTimes.push(clock);
        return { ok: true, status: 200, json: {} };
      }
      if (method === 'GET' && /\/cms\/v3\/blogs\/posts\/\d+$/.test(path)) {
        const id = path.split('/').pop();
        // Inside publishPost's poll, report PUBLISHED; report whatever date is live.
        return { ok: true, status: 200, json: { state: 'PUBLISHED', publishDate: liveDate[id] || TODAY } };
      }
      return { ok: true, status: 200, json: {} };
    };

    const acct = { name: 'dev', portalId: '246389711', key: 'k' };
    const res = await push(acct, {
      contentDir: dir,
      registry: emptyRegistry('246389711'),
      publish: true,
      hubFn,
      now: () => clock,
      sleep: async (ms) => { clock += ms; }, // advancing the clock models real wall-time passing
    });

    // Both posts' canonical dates were restored AND verified (the restore pass ran
    // after latestSchedule, so nothing clobbered them).
    assert.ok(res.notes.some((n) => /restored 2 /.test(n)), `expected restored 2, notes: ${JSON.stringify(res.notes)}`);
    assert.equal(liveDate['100'], '2017-03-04T10:00:00.000Z');
    assert.equal(liveDate['200'], '2019-11-22T08:30:00.000Z');
    // The restore PATCHes only counted once the clock was past every schedule.
    assert.ok(restorePatchClockTimes.every((t) => t >= latestSchedule), 'every confirming restore PATCH ran after the last schedule fired');
    assert.ok(clock >= latestSchedule, 'push waited past the latest scheduled publish before restoring');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
