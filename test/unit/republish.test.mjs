// Unit tests for src/republish.mjs — HubSpot is mocked by replacing global fetch.
//   node --test test/unit/republish.test.mjs
//
// The blog path regressed silently: it rescheduled each live post at its ORIGINAL
// publishDate via /cms/v3/blogs/posts/schedule, which HubSpot rejects with 400 for any
// past date, so every post failed. These tests pin the request the blog path sends.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { republish } from '../../src/republish.mjs';
import { HUB_MAX_ATTEMPTS } from '../../src/lib/hub.mjs';

const PORTAL = '999001';
let keyDir;
let calls;
let realFetch;
let realLog;
let realError;

// routes: [{ method, match: RegExp, status, json, headers, throws }] — first match wins.
// `status`/`throws` may be getters so a route can answer differently per call.
function installFetch(routes) {
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const path = String(url).replace('https://api.hubapi.com', '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body, auth: init.headers?.Authorization });
    const route = routes.find((r) => r.method === method && r.match.test(path));
    if (!route) throw new Error(`unexpected request ${method} ${path}`);
    if (route.throws) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const status = route.status ?? 200;
    const headers = route.headers || {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h) => headers[h.toLowerCase()] ?? null },
      text: async () => (route.json === undefined ? '' : JSON.stringify(route.json)),
    };
  };
}

// Records backoff waits instead of sleeping, so retry tests run instantly.
let sleeps;
const sleep = async (ms) => { sleeps.push(ms); };

const POSTS = [
  { id: '11', slug: 'blog/old-post', state: 'PUBLISHED', publishDate: '2017-03-01T12:00:00Z' },
  { id: '12', slug: 'blog/newer-post', state: 'PUBLISHED', publishDate: '2025-09-30T12:00:00Z' },
  { id: '13', slug: 'blog/unpublished', state: 'DRAFT', publishDate: '2024-01-01T00:00:00Z' },
  { id: '14', slug: 'blog/temporary-slug-abc', state: 'PUBLISHED', publishDate: '2024-01-01T00:00:00Z' },
];

function routes({ pushLiveStatus = () => 204 } = {}) {
  return [
    { method: 'GET', match: /^\/cms\/v3\/pages\/site-pages\?/, json: { results: [] } },
    { method: 'GET', match: /^\/cms\/v3\/blogs\/posts\?/, json: { results: POSTS } },
    {
      method: 'POST',
      match: /^\/cms\/v3\/blogs\/posts\/\d+\/draft\/push-live$/,
      get status() { return pushLiveStatus(calls.at(-1).path); },
    },
    // The old, broken request. Present so a regression fails on assertions, not on
    // "unexpected request".
    { method: 'POST', match: /^\/cms\/v3\/blogs\/posts\/schedule$/, status: 400, json: { message: 'publishDate must be in the future' } },
  ];
}

beforeEach(() => {
  keyDir = mkdtempSync(join(tmpdir(), 'hcms-republish-'));
  writeFileSync(join(keyDir, `${PORTAL}.key`), 'test-key\n');
  calls = [];
  sleeps = [];
  realFetch = globalThis.fetch;
  realLog = console.log;
  realError = console.error;
  console.log = () => {};
  console.error = () => {};
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.error = realError;
  rmSync(keyDir, { recursive: true, force: true });
});

test('--blog pushes each live post live without touching its publishDate', async () => {
  installFetch(routes());
  const code = await republish(['--portal', PORTAL, '--blog'], { config: { keyDir }, sleep });

  assert.equal(code, 0);
  const writes = calls.filter((c) => c.method !== 'GET');
  assert.deepEqual(
    writes.map((c) => `${c.method} ${c.path}`),
    ['POST /cms/v3/blogs/posts/11/draft/push-live', 'POST /cms/v3/blogs/posts/12/draft/push-live'],
  );
  for (const w of writes) {
    assert.deepEqual(w.body, {}, 'push-live must not send a publishDate');
    assert.equal(w.auth, 'Bearer test-key');
  }
  assert.ok(!calls.some((c) => c.path.startsWith('/cms/v3/blogs/posts/schedule')), 'must not use the schedule endpoint for posts');
});

test('--blog skips drafts and temporary-slug posts', async () => {
  installFetch(routes());
  await republish(['--portal', PORTAL, '--blog'], { config: { keyDir }, sleep });
  const touched = calls.filter((c) => c.method === 'POST').map((c) => c.path);
  assert.ok(!touched.some((p) => p.includes('/13/')), 'draft post must not be pushed live');
  assert.ok(!touched.some((p) => p.includes('/14/')), 'temporary-slug post must not be pushed live');
});

test('--blog returns non-zero when a push-live fails persistently', async () => {
  installFetch(routes({ pushLiveStatus: (path) => (path.includes('/12/') ? 500 : 204) }));
  const code = await republish(['--portal', PORTAL, '--blog'], { config: { keyDir }, sleep });
  assert.equal(code, 1);
  // Non-zero for the right reason: post 11 went through once; post 12 was retried to
  // the attempt bound and only then counted as failed. (The old schedule path also
  // exited 1, by failing every post.)
  assert.deepEqual(
    calls.filter((c) => c.method === 'POST').map((c) => c.path),
    [
      '/cms/v3/blogs/posts/11/draft/push-live',
      ...Array(HUB_MAX_ATTEMPTS).fill('/cms/v3/blogs/posts/12/draft/push-live'),
    ],
  );
  assert.equal(sleeps.length, HUB_MAX_ATTEMPTS - 1);
});

// ---------- per-request retry (PR #16 run 38855144603: one push-live 500 of 90) ----------

test('--blog: a one-off push-live 500 is retried and the run succeeds', async () => {
  let post12 = 0;
  installFetch(routes({
    pushLiveStatus: (path) => (path.includes('/12/') && ++post12 === 1 ? 500 : 204),
  }));
  const code = await republish(['--portal', PORTAL, '--blog'], { config: { keyDir }, sleep });
  assert.equal(code, 0);
  assert.deepEqual(
    calls.filter((c) => c.method === 'POST').map((c) => c.path),
    [
      '/cms/v3/blogs/posts/11/draft/push-live',
      '/cms/v3/blogs/posts/12/draft/push-live',
      '/cms/v3/blogs/posts/12/draft/push-live',
    ],
  );
  assert.deepEqual(sleeps, [500]);
});

test('--all: a 429 on schedule waits for Retry-After, then succeeds', async () => {
  let n = 0;
  installFetch([
    { method: 'GET', match: /^\/cms\/v3\/pages\/site-pages\?/, json: { results: [{ id: '7', slug: 'about', state: 'PUBLISHED' }] } },
    {
      method: 'POST',
      match: /^\/cms\/v3\/pages\/site-pages\/schedule$/,
      get status() { return ++n === 1 ? 429 : 204; },
      get headers() { return n === 1 ? { 'retry-after': '3' } : {}; },
    },
  ]);
  const code = await republish(['--portal', PORTAL, '--all'], { config: { keyDir }, sleep });
  assert.equal(code, 0);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 2);
  assert.deepEqual(sleeps, [3000], 'must wait exactly the Retry-After interval');
});

test('--blog: a push-live network error that never clears fails that post, not the run', async () => {
  installFetch([
    { method: 'GET', match: /^\/cms\/v3\/pages\/site-pages\?/, json: { results: [] } },
    { method: 'GET', match: /^\/cms\/v3\/blogs\/posts\?/, json: { results: POSTS } },
    { method: 'POST', match: /\/posts\/11\/draft\/push-live$/, throws: true },
    { method: 'POST', match: /\/posts\/12\/draft\/push-live$/, status: 204 },
  ]);
  const code = await republish(['--portal', PORTAL, '--blog'], { config: { keyDir }, sleep });
  assert.equal(code, 1);
  const posts = calls.filter((c) => c.method === 'POST').map((c) => c.path.split('/')[5]);
  assert.deepEqual(posts, [...Array(HUB_MAX_ATTEMPTS).fill('11'), '12'], 'post 12 must still be attempted');
});

test('a listing that keeps failing throws instead of republishing a short list', async () => {
  installFetch([
    { method: 'GET', match: /^\/cms\/v3\/pages\/site-pages\?/, status: 503, json: { message: 'down' } },
  ]);
  await assert.rejects(
    republish(['--portal', PORTAL, '--all'], { config: { keyDir }, sleep }),
    /site-pages.*-> 503/,
  );
  assert.equal(calls.length, HUB_MAX_ATTEMPTS);
  assert.ok(!calls.some((c) => c.method === 'POST'), 'nothing may be scheduled off a failed listing');
});

test('without --blog, no blog post is touched', async () => {
  installFetch(routes());
  const code = await republish(['--portal', PORTAL, '--all'], { config: { keyDir }, sleep });
  assert.equal(code, 0);
  assert.ok(!calls.some((c) => c.path.startsWith('/cms/v3/blogs/')), 'blog API must not be called');
});
