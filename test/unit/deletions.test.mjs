// Unit tests for src/deletions.mjs — managed deletions (clean-slate support).
// Network-mocked; planDeletions is pure. Verifies dry-run-by-default, read-only
// guard, only-listed deletes, idempotent absent handling, hard-fail on bad surface.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDeletionsCsv, planDeletions, syncDeletions } from '../../src/deletions.mjs';

const acct = (name, portalId) => ({ name, portalId, key: 'k' });

test('parseDeletionsCsv: skips blanks/comments/header, parses surface,key,reason', () => {
  const specs = parseDeletionsCsv([
    '# clean-slate list',
    'surface,key,reason',
    'site-pages,team,old team page',
    '',
    'landing-pages,inbound25',
    '  blog-posts , blog/old ,  stale  ',
  ].join('\n'));
  assert.deepEqual(specs, [
    { surface: 'site-pages', key: 'team', reason: 'old team page' },
    { surface: 'landing-pages', key: 'inbound25', reason: '' },
    { surface: 'blog-posts', key: 'blog/old', reason: 'stale' },
  ]);
});

test('parseDeletionsCsv: malformed row (missing key) is a hard error', () => {
  assert.throws(() => parseDeletionsCsv('site-pages'), /malformed row/);
});

test('planDeletions: resolves key->id, marks unmatched as absent (idempotent)', () => {
  const inv = { 'site-pages': [
    { slug: 'team', id: '111', currentState: 'PUBLISHED' },
    { slug: 'keep', id: '222', currentState: 'PUBLISHED' },
  ] };
  const plan = planDeletions(
    [{ surface: 'site-pages', key: 'team', reason: '' }, { surface: 'site-pages', key: 'ghost', reason: '' }],
    inv,
  );
  assert.deepEqual(plan[0], { surface: 'site-pages', key: 'team', reason: '', id: '111', action: 'delete' });
  assert.equal(plan[1].action, 'absent', 'an unmatched key is absent, never a wildcard delete');
});

test('planDeletions: unknown surface is a hard error (typo must fail loudly)', () => {
  assert.throws(() => planDeletions([{ surface: 'site-pagez', key: 'x' }], {}), /unknown surface/);
});

test('syncDeletions: DRY-RUN by default issues NO DELETE calls', async () => {
  const calls = [];
  const getAll = async () => [{ slug: 'team', id: '111', currentState: 'PUBLISHED' }];
  const hub = async (a, method, path) => { calls.push({ method, path }); return { ok: true, status: 200, json: {} }; };
  const readSpecs = () => [{ surface: 'site-pages', key: 'team', reason: 'old' }];
  const res = await syncDeletions('dev', { config: { readOnlyPortalIds: ['529456'] } },
    { account: () => acct('dev', '246389711'), getAll, hub, readSpecs });
  assert.equal(res.apply, false);
  assert.equal(res.counts.delete, 1, 'plan shows 1 to delete');
  assert.ok(!calls.some((c) => c.method === 'DELETE'), 'dry-run issues NO DELETE');
});

test('syncDeletions --apply deletes ONLY listed items, idempotent on 404', async () => {
  const calls = [];
  const getAll = async () => [
    { slug: 'team', id: '111', currentState: 'PUBLISHED' },
    { slug: 'keep', id: '222', currentState: 'PUBLISHED' }, // NOT listed -> must survive
  ];
  const hub = async (a, method, path) => {
    calls.push({ method, path });
    if (method === 'DELETE' && path.endsWith('/111')) return { ok: true, status: 204, json: {} };
    return { ok: true, status: 200, json: {} };
  };
  const readSpecs = () => [{ surface: 'site-pages', key: 'team', reason: '' }];
  const res = await syncDeletions('dev', { apply: true, config: { readOnlyPortalIds: ['529456'] } },
    { account: () => acct('dev', '246389711'), getAll, hub, readSpecs });
  const deletes = calls.filter((c) => c.method === 'DELETE');
  assert.equal(deletes.length, 1, 'exactly one delete');
  assert.match(deletes[0].path, /\/cms\/v3\/pages\/site-pages\/111$/);
  assert.ok(!deletes.some((c) => c.path.endsWith('/222')), 'unlisted page 222 is never deleted');
  assert.equal(res.counts.delete, 1);
});

test('syncDeletions: flags a page deletion with NO redirect (404-at-cutover guard)', async () => {
  const getAll = async (acct, path) => {
    if (path.includes('site-pages')) return [
      { slug: 'team', id: '111', currentState: 'PUBLISHED' },
      { slug: 'how', id: '222', currentState: 'PUBLISHED' },
    ];
    if (path.includes('url-redirects')) return [{ routePrefix: 'http://www.x.com/team', destination: '/t' }]; // covers /team only
    return [];
  };
  const hub = async () => ({ ok: true, status: 200, json: {} });
  const readSpecs = () => [
    { surface: 'site-pages', key: 'team', reason: '' },
    { surface: 'site-pages', key: 'how', reason: '' },
  ];
  const res = await syncDeletions('dev', { config: { readOnlyPortalIds: ['529456'] } },
    { account: () => acct('dev', '246389711'), getAll, hub, readSpecs });
  const team = res.plan.find((p) => p.key === 'team');
  const how = res.plan.find((p) => p.key === 'how');
  assert.equal(team.redirectCovered, true, '/team has a redirect');
  assert.equal(how.redirectCovered, false, '/how has NO redirect -> would 404');
});

test('syncDeletions --apply REFUSES a read-only (prod) portal', async () => {
  const readSpecs = () => [{ surface: 'site-pages', key: 'team' }];
  await assert.rejects(
    () => syncDeletions('prod', { apply: true, config: { readOnlyPortalIds: ['529456'] } },
      { account: () => acct('prod', '529456'), getAll: async () => [], hub: async () => ({ ok: true }), readSpecs }),
    /read-only/,
  );
});
