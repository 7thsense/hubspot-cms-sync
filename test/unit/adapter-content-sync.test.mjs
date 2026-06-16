// Integration tests for change-aware page-CONTENT (widgets) publishing: a re-push with
// unchanged source SKIPS the page (no PATCH/schedule), and a page whose live widgets were
// edited in the HubSpot UI (drift) is LEFT AS-IS without --force and OVERWRITTEN with it.
// This is the guard behind the home-page CTA-link divergence incident (a UI edit silently
// clobbered by the next release). Mirrors test/unit/adapter-blog-sync.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { push } from '../../src/adapters/content.mjs';
import { emptyRegistry } from '../../src/lib/refs.mjs';
import { stableStringify } from '../../src/lib/canonical.mjs';

// A tiny stateful HubSpot site-pages API: pages keyed by id holding the live widgets
// carrier. The LIST endpoint and the per-page draft GET both surface those widgets, so a
// re-read sees exactly what the last PATCH placed — unless a test mutates them directly
// (a "UI edit"). Records calls for assertions. Wraps globalThis.fetch (content.mjs uses
// hub()/getAll(), which go through fetch — there is no injectable hubFn here).
function makePages(initialPages) {
  const pages = new Map(initialPages.map((p) => [String(p.id), { ...p }]));
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push(`${method} ${u.replace(/^https?:\/\/[^/]+/, '').split('?')[0]}`);
    // LIST (paginated by getAll) — a single page of results carrying live widgets.
    if (method === 'GET' && u.includes('/cms/v3/pages/site-pages') && !/site-pages\/\d+/.test(u)) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: [...pages.values()] }) };
    }
    // Per-page draft GET — the freshest live carrier (what the snapshot records as remoteFp).
    const m = u.match(/site-pages\/(\d+)(\/draft)?/);
    if (m && method === 'GET') {
      return { ok: true, status: 200, text: async () => JSON.stringify(pages.get(m[1]) || {}) };
    }
    // Draft PATCH (replace-not-merge): overwrite the live widgets wholesale.
    if (m && method === 'PATCH') {
      const id = m[1];
      pages.set(id, { ...pages.get(id), widgets: body.widgets });
      return { ok: true, status: 200, text: async () => JSON.stringify({ id, widgets: body.widgets }) };
    }
    if (method === 'POST' && u.includes('/schedule')) {
      return { ok: true, status: 204, text: async () => '' };
    }
    return { ok: false, status: 404, text: async () => '{}' };
  };
  return { fetchFn, calls, pages };
}

// Write a canonical page file (content/pages/<stem>.json) with embedded widgets.
function writePage(dir, stem, fields) {
  const pagesDir = join(dir, 'pages');
  mkdirSync(pagesDir, { recursive: true });
  writeFileSync(join(pagesDir, `${stem}.json`), stableStringify(fields));
}

const acct = { name: 'dev', portalId: '246389711', key: 'k' };

// A minimal widget carrier (no logical refs, so no registry mapping is needed).
function widget(text) {
  return { hero: { name: 'hero', type: 'module', label: '', css: {}, child_css: {}, body: { text } } };
}

test('re-push with unchanged source SKIPS the page (no PATCH / schedule)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'content-sync-'));
  const orig = globalThis.fetch;
  try {
    writePage(dir, 'home', { slug: '', name: 'Home', widgets: widget('LIVE') });
    // First push populates the snapshot and the live carrier.
    const first = makePages([{ id: '700', slug: '', widgets: widget('OLD') }]);
    globalThis.fetch = first.fetchFn;
    await push(acct, { contentDir: dir, registry: emptyRegistry('246389711'), snapshotRoot: dir });
    assert.ok(first.calls.some((c) => c.startsWith('PATCH')), 'first push PATCHed the draft');

    // Second push: same source + the live remote still equals what we pushed -> unchanged.
    const second = makePages([...first.pages.values()]);
    globalThis.fetch = second.fetchFn;
    const res = await push(acct, { contentDir: dir, registry: emptyRegistry('246389711'), snapshotRoot: dir });
    const writes = second.calls.filter((c) => c.startsWith('PATCH') || c.endsWith('/schedule'));
    assert.deepEqual(writes, [], `second push wrote nothing, got: ${writes.join(', ')}`);
    assert.equal(res.pushed, 0);
    assert.match(res.notes.at(-1), /skipped 1/);
  } finally {
    globalThis.fetch = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a UI-edited (drift) page is LEFT AS-IS without --force and OVERWRITTEN with --force', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'content-sync-'));
  const orig = globalThis.fetch;
  try {
    writePage(dir, 'home', { slug: '', name: 'Home', widgets: widget('REPO') });
    // First push: places REPO widgets and snapshots them.
    const state = makePages([{ id: '700', slug: '', widgets: widget('OLD') }]);
    globalThis.fetch = state.fetchFn;
    await push(acct, { contentDir: dir, registry: emptyRegistry('246389711'), snapshotRoot: dir });
    assert.deepEqual(state.pages.get('700').widgets, widget('REPO'), 'first push placed the repo widgets');

    // A HubSpot UI edit changes the live widgets out from under us (the CTA-link incident).
    state.pages.set('700', { ...state.pages.get('700'), widgets: widget('UI-EDIT') });

    // Second push WITHOUT --force: source unchanged, live remote drifted -> reported, NOT clobbered.
    const drift = makePages([...state.pages.values()]);
    globalThis.fetch = drift.fetchFn;
    const res = await push(acct, { contentDir: dir, registry: emptyRegistry('246389711'), snapshotRoot: dir });
    assert.ok(!drift.calls.some((c) => c.startsWith('PATCH')), 'no PATCH — the UI edit is preserved');
    assert.equal(res.pushed, 0);
    assert.equal(drift.pages.get('700').widgets.hero.body.text, 'UI-EDIT', 'live UI edit left intact');
    assert.match(res.notes.find((n) => n.includes('drift')), /drift: .*changed on HubSpot.*--force to overwrite/);

    // Third push WITH --force: overwrite the drift with our repo source.
    const forced = makePages([...drift.pages.values()]);
    globalThis.fetch = forced.fetchFn;
    const res2 = await push(acct, { contentDir: dir, registry: emptyRegistry('246389711'), snapshotRoot: dir, force: true });
    assert.ok(forced.calls.some((c) => c.startsWith('PATCH')), '--force re-PATCHed the draft');
    assert.equal(res2.pushed, 1);
    assert.deepEqual(forced.pages.get('700').widgets, widget('REPO'), '--force restored the repo widgets');
  } finally {
    globalThis.fetch = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});
