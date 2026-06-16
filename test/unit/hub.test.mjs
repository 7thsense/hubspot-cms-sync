// Unit tests for sync/lib/hub.mjs — no network.
// Account resolution uses a temp key dir via $HUBSPOT_KEY_DIR; paging is tested
// by stubbing global fetch; slug matching is tested as pure functions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  loadAccounts,
  account,
  getAll,
  hub,
  matchPageSlug,
  matchBlogSlug,
  resolvePageBySlug,
} from '../../src/lib/hub.mjs';

// ---------- helpers ----------

const __dirname = dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_PATH = join(__dirname, '..', 'fixtures', 'config', 'accounts.json');

function fixtureConfig(dir) {
  return {
    accountsPath: ACCOUNTS_PATH,
    keyDir: dir || join(tmpdir(), 'missing-hubspot-keys'),
  };
}

function withKeyDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hubkeys-'));
  const prev = process.env.HUBSPOT_KEY_DIR;
  process.env.HUBSPOT_KEY_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.HUBSPOT_KEY_DIR;
    else process.env.HUBSPOT_KEY_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

// Build a fetch stub that returns successive JSON page payloads, asserting the
// requested URLs as it goes.
function stubFetch(pages, seenUrls) {
  let i = 0;
  return async (url) => {
    seenUrls.push(url);
    const payload = pages[i++] ?? { results: [] };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    };
  };
}

// ---------- loadAccounts ----------

test('loadAccounts parses the registry and includes dev/prod', () => {
  const accts = loadAccounts(fixtureConfig());
  assert.equal(accts.dev.portalId, '246389711');
  assert.equal(accts.prod.portalId, '529456');
});

// ---------- account ----------

test('account resolves name -> { name, portalId, key } from key dir', () => {
  withKeyDir((dir) => {
    writeFileSync(join(dir, '246389711.key'), '  pat-naX-secret\n');
    const a = account('dev', fixtureConfig(dir));
    assert.equal(a.name, 'dev');
    assert.equal(a.portalId, '246389711');
    assert.equal(a.key, 'pat-naX-secret'); // trimmed
  });
});

test('account throws a clear error when the key file is missing', () => {
  withKeyDir(() => {
    assert.throws(() => account('dev', fixtureConfig()), /No key for account "dev".*246389711\.key/s);
  });
});

test('account throws for an unknown account name', () => {
  withKeyDir(() => {
    assert.throws(() => account('nope', fixtureConfig()), /Unknown account "nope"/);
  });
});

test('account throws when key file is empty', () => {
  withKeyDir((dir) => {
    writeFileSync(join(dir, '246389711.key'), '   \n');
    assert.throws(() => account('dev', fixtureConfig(dir)), /is empty/);
  });
});

// ---------- getAll paging accumulation (stubbed fetch) ----------

test('getAll accumulates across paging.next.after and stops cleanly', async () => {
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = stubFetch(
    [
      { results: [{ id: 1 }, { id: 2 }], paging: { next: { after: 'A2' } } },
      { results: [{ id: 3 }], paging: { next: { after: 'A3' } } },
      { results: [{ id: 4 }] }, // no paging -> stop
    ],
    seen
  );
  try {
    const acct = { name: 'dev', portalId: '246389711', key: 'k' };
    const all = await getAll(acct, '/cms/v3/pages/site-pages');
    assert.deepEqual(all.map((r) => r.id), [1, 2, 3, 4]);
    assert.equal(seen.length, 3);
    // first page has no after; subsequent pages carry the cursor
    assert.match(seen[0], /limit=100/);
    assert.ok(!seen[0].includes('after='));
    assert.match(seen[1], /after=A2/);
    assert.match(seen[2], /after=A3/);
  } finally {
    globalThis.fetch = orig;
  }
});

test('getAll uses & as separator when the path already has a query string', async () => {
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = stubFetch([{ results: [] }], seen);
  try {
    const acct = { name: 'dev', portalId: '246389711', key: 'k' };
    await getAll(acct, '/marketing/v3/forms?archived=false');
    assert.match(seen[0], /\?archived=false&limit=100/);
  } finally {
    globalThis.fetch = orig;
  }
});

test('getAll throws with status + message on a non-ok page', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    text: async () => JSON.stringify({ message: 'forbidden scope' }),
  });
  try {
    const acct = { name: 'dev', portalId: '246389711', key: 'k' };
    await assert.rejects(() => getAll(acct, '/cms/v3/pages/site-pages'), /403.*forbidden scope/);
  } finally {
    globalThis.fetch = orig;
  }
});

// ---------- hub() transient-retry ----------

const noHeaders = { get: () => null };

test('hub retries a transient 502 then succeeds', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) return { ok: false, status: 502, headers: noHeaders, text: async () => '<html>gateway</html>' };
    return { ok: true, status: 200, headers: noHeaders, text: async () => JSON.stringify({ id: 'ok' }) };
  };
  try {
    const acct = { name: 'dev', portalId: '529456', key: 'k' };
    const r = await hub(acct, 'PATCH', '/cms/v3/blogs/posts/1', { x: 1 }, { sleep: async () => {} });
    assert.equal(r.ok, true);
    assert.equal(r.json.id, 'ok');
    assert.equal(calls, 3); // 2 failures + 1 success
  } finally {
    globalThis.fetch = orig;
  }
});

test('hub does NOT retry a 4xx (real error returned immediately)', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: false, status: 400, headers: noHeaders, text: async () => JSON.stringify({ message: 'bad' }) };
  };
  try {
    const acct = { name: 'dev', portalId: '529456', key: 'k' };
    const r = await hub(acct, 'POST', '/x', {}, { sleep: async () => {} });
    assert.equal(r.status, 400);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = orig;
  }
});

test('hub gives up after maxAttempts on a persistent 503', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: false, status: 503, headers: noHeaders, text: async () => 'down' };
  };
  try {
    const acct = { name: 'dev', portalId: '529456', key: 'k' };
    const r = await hub(acct, 'GET', '/x', undefined, { maxAttempts: 3, sleep: async () => {} });
    assert.equal(r.ok, false);
    assert.equal(r.status, 503);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = orig;
  }
});

test('hub retries a network throw then succeeds', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 2) throw new Error('ECONNRESET');
    return { ok: true, status: 200, headers: noHeaders, text: async () => '{}' };
  };
  try {
    const acct = { name: 'dev', portalId: '529456', key: 'k' };
    const r = await hub(acct, 'GET', '/x', undefined, { sleep: async () => {} });
    assert.equal(r.ok, true);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = orig;
  }
});

// ---------- pure slug matchers ----------

test('matchPageSlug matches homepage via empty string and returns string id', () => {
  const pages = [
    { id: 100, slug: 'about' },
    { id: 200, slug: '' },
    { id: 300, slug: 'contact' },
  ];
  assert.equal(matchPageSlug(pages, ''), '200');
  assert.equal(matchPageSlug(pages, 'contact'), '300');
  assert.equal(matchPageSlug(pages, 'missing'), null);
});

test('matchBlogSlug matches by slug, not objects[0] (stale "Old" blog must lose)', () => {
  const blogs = [
    { id: 11, slug: 'old', name: 'Old Blog' },
    { id: 22, slug: 'blog', name: 'The Seventh Sense' },
  ];
  assert.equal(matchBlogSlug(blogs, 'blog'), '22');
  assert.equal(matchBlogSlug(blogs, 'old'), '11');
  assert.equal(matchBlogSlug(blogs, 'nope'), null);
});

// ---------- resolvePageBySlug wired through stubbed fetch ----------

test('resolvePageBySlug resolves through getAll + matchPageSlug', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ results: [{ id: 42, slug: 'about' }] }),
  });
  try {
    const acct = { name: 'dev', portalId: '246389711', key: 'k' };
    assert.equal(await resolvePageBySlug(acct, 'about'), '42');
    assert.equal(await resolvePageBySlug(acct, 'nope'), null);
  } finally {
    globalThis.fetch = orig;
  }
});
