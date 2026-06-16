// Integration tests for change-aware blog publishing: already-live posts use the
// date-preserving push-live path (NO schedule dance), and a re-push with unchanged
// source SKIPS every post.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { push } from '../../src/adapters/blog.mjs';
import { emptyRegistry } from '../../src/lib/refs.mjs';

const THEME_CONTAINER = { slug: 'blog', item_template_path: 'seventh-sense-theme/templates/blog-post.html', listing_template_path: 'seventh-sense-theme/templates/blog.html', listing_page_id: 0 };

// A tiny stateful HubSpot blog: posts keyed by id, with the fields push reads back.
function makeBlog(initialPosts) {
  const posts = new Map(initialPosts.map((p) => [String(p.id), { ...p }]));
  const calls = [];
  const liveBlog = { id: '7', slug: 'blog', item_template_path: THEME_CONTAINER.item_template_path, listing_template_path: THEME_CONTAINER.listing_template_path, listing_page_id: 0 };
  let nextId = 900;
  const hubFn = async (acct, method, path, body) => {
    calls.push(`${method} ${path.split('?')[0]}`);
    if (method === 'GET' && path.startsWith('/content/api/v2/blogs')) return { ok: true, status: 200, json: { objects: [liveBlog] } };
    if (method === 'GET' && /\/cms\/v3\/blogs\/(authors|tags)/.test(path)) return { ok: true, status: 200, json: { results: [] } };
    if (method === 'GET' && /\/cms\/v3\/blogs\/posts(\?|$)/.test(path)) return { ok: true, status: 200, json: { results: [...posts.values()] } };
    if (method === 'POST' && path === '/cms/v3/blogs/posts') { const id = String(nextId++); posts.set(id, { id, ...body, state: 'DRAFT' }); return { ok: true, status: 200, json: { id, slug: body.slug } }; }
    if (method === 'PATCH' && /\/cms\/v3\/blogs\/posts\/\d+$/.test(path)) { const id = path.split('/').pop(); posts.set(id, { ...posts.get(id), ...body }); return { ok: true, status: 200, json: {} }; }
    if (method === 'POST' && /\/draft\/push-live$/.test(path)) { const id = path.split('/')[5]; posts.set(id, { ...posts.get(id), state: 'PUBLISHED' }); return { ok: true, status: 204, json: {} }; }
    if (method === 'POST' && path.endsWith('/schedule')) { const id = String(body.id); posts.set(id, { ...posts.get(id), state: 'PUBLISHED' }); return { ok: true, status: 200, json: {} }; }
    if (method === 'GET' && /\/cms\/v3\/blogs\/posts\/\d+$/.test(path)) { const id = path.split('/').pop(); return { ok: true, status: 200, json: posts.get(id) || {} }; }
    return { ok: true, status: 200, json: {} };
  };
  return { hubFn, calls, posts };
}

function writePost(dir, base, fields) {
  const postsDir = join(dir, 'blog', 'posts');
  mkdirSync(postsDir, { recursive: true });
  writeFileSync(join(dir, 'blog', 'container.json'), JSON.stringify(THEME_CONTAINER));
  writeFileSync(join(postsDir, `blog__${base}.json`), JSON.stringify(fields));
}

const acct = { name: 'dev', portalId: '246389711', key: 'k' };

test('an already-PUBLISHED post updates via push-live (date preserved, NO schedule dance)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-'));
  try {
    writePost(dir, 'a', { slug: 'blog/a', blogSlug: 'blog', name: 'A', htmlTitle: 'A', publishDate: '2017-03-04T10:00:00Z', postBody: 'NEW BODY' });
    // The post already exists and is PUBLISHED with an OLD body.
    const { hubFn, calls, posts } = makeBlog([{ id: '100', slug: 'blog/a', name: 'A', htmlTitle: 'A', state: 'PUBLISHED', publishDate: '2017-03-04T10:00:00Z', postBody: 'OLD BODY' }]);
    await push(acct, { contentDir: dir, registry: emptyRegistry('246389711'), publish: true, hubFn, snapshotRoot: dir, now: () => 0, sleep: async () => {} });
    assert.ok(calls.includes('POST /cms/v3/blogs/posts/100/draft/push-live'), 'used push-live');
    assert.ok(!calls.some((c) => c.endsWith('/schedule')), 'did NOT use the schedule dance');
    assert.equal(posts.get('100').publishDate, '2017-03-04T10:00:00Z', 'date preserved');
    assert.equal(posts.get('100').postBody, 'NEW BODY', 'content updated');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('re-push with unchanged source SKIPS every post (no PATCH / push-live / schedule)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-'));
  try {
    writePost(dir, 'a', { slug: 'blog/a', blogSlug: 'blog', name: 'A', htmlTitle: 'A', publishDate: '2017-03-04T10:00:00Z', postBody: 'BODY' });
    const state = makeBlog([{ id: '100', slug: 'blog/a', name: 'A', htmlTitle: 'A', state: 'PUBLISHED', publishDate: '2017-03-04T10:00:00Z', postBody: 'BODY' }]);
    // First push populates the snapshot.
    await push(acct, { contentDir: dir, registry: emptyRegistry('246389711'), publish: true, hubFn: state.hubFn, snapshotRoot: dir, now: () => 0, sleep: async () => {} });
    // Second push: same source + same remote -> everything is unchanged.
    const second = makeBlog([...state.posts.values()]);
    const res = await push(acct, { contentDir: dir, registry: emptyRegistry('246389711'), publish: true, hubFn: second.hubFn, snapshotRoot: dir, now: () => 0, sleep: async () => {} });
    const writes = second.calls.filter((c) => c.startsWith('PATCH') || c.endsWith('/push-live') || c.endsWith('/schedule') || c === 'POST /cms/v3/blogs/posts');
    assert.deepEqual(writes, [], `second push wrote nothing, got: ${writes.join(', ')}`);
    assert.match(res.notes.at(-1), /skipped 1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
