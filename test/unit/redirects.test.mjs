import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeRedirect,
  normalizeRedirectPath,
  isInRedirectScope,
  parseRedirectCsv,
  planRedirects,
  planRedirectsReconcile,
  renderRedirectReport,
  syncRedirects,
} from '../../src/redirects.mjs';

test('parseRedirectCsv reads required fields and defaults managed redirects to 301 override behavior', () => {
  const specs = parseRedirectCsv(
    'routePrefix,destination,redirectStyle,notes\n' +
      '/old,/new,,ignored\n' +
      '"/quoted,old","/quoted,new",302,ignored\n',
  );
  assert.deepEqual(specs, [
    {
      routePrefix: '/old',
      destination: '/new',
      redirectStyle: 301,
      isOnlyAfterNotFound: false,
    },
    {
      routePrefix: '/quoted,old',
      destination: '/quoted,new',
      redirectStyle: 302,
      isOnlyAfterNotFound: false,
    },
  ]);
});

test('normalizeRedirect validates booleans and integers', () => {
  assert.deepEqual(
    normalizeRedirect({
      routePrefix: '/a',
      destination: '/b',
      redirectStyle: '301',
      isOnlyAfterNotFound: 'true',
      isTrailingSlashOptional: 'false',
      precedence: '2',
    }),
    {
      routePrefix: '/a',
      destination: '/b',
      redirectStyle: 301,
      isOnlyAfterNotFound: true,
      isTrailingSlashOptional: false,
      precedence: 2,
    },
  );
  assert.throws(() => normalizeRedirect({ routePrefix: '/a' }), /destination is required/);
  assert.throws(
    () => normalizeRedirect({ routePrefix: '/a', destination: '/b', redirectStyle: 'nope' }),
    /redirectStyle must be an integer/,
  );
});

test('planRedirects creates, updates, and leaves matching redirects unchanged', () => {
  const specs = [
    normalizeRedirect({ routePrefix: '/create', destination: '/new' }),
    normalizeRedirect({ routePrefix: '/update', destination: '/better' }),
    normalizeRedirect({ routePrefix: '/same', destination: '/target' }),
  ];
  const plan = planRedirects(specs, [
    { id: '10', routePrefix: '/update', destination: '/old', redirectStyle: 301, isOnlyAfterNotFound: true },
    { id: '11', routePrefix: '/same', destination: '/target', redirectStyle: 301, isOnlyAfterNotFound: false },
  ]);
  assert.equal(plan[0].action, 'create');
  assert.deepEqual(plan[0].body, {
    routePrefix: '/create',
    destination: '/new',
    redirectStyle: 301,
    isOnlyAfterNotFound: false,
  });
  assert.equal(plan[1].action, 'update');
  assert.equal(plan[1].id, '10');
  assert.deepEqual(plan[1].changedFields.sort(), ['destination', 'isOnlyAfterNotFound'].sort());
  assert.equal(plan[2].action, 'unchanged');
});

test('planRedirects fails closed on ambiguous route ownership', () => {
  const specs = [normalizeRedirect({ routePrefix: '/a', destination: '/b' })];
  assert.throws(() => planRedirects([...specs, ...specs], []), /duplicate managed redirect/);
  assert.throws(
    () => planRedirects(specs, [{ id: '1', routePrefix: '/a' }, { id: '2', routePrefix: '/a' }]),
    /multiple existing HubSpot redirects/,
  );
});

test('syncRedirects dry-run reads state and does not write', async () => {
  const calls = [];
  const result = await syncRedirects(
    'dev',
    { file: 'redirects.csv', apply: false, config: { root: '/repo', readOnlyPortalIds: ['529456'] } },
    {
      account: () => ({ name: 'dev', portalId: '246389711', key: 'k' }),
      readSpecs: () => [normalizeRedirect({ routePrefix: '/old', destination: '/new' })],
      getAll: async () => [],
      hub: async (...args) => {
        calls.push(args);
        return { ok: true, status: 200, json: { id: '1' } };
      },
    },
  );
  assert.equal(result.counts.create, 1);
  assert.deepEqual(calls, []);
});

test('syncRedirects apply writes creates and updates', async () => {
  const calls = [];
  const result = await syncRedirects(
    'dev',
    { file: 'redirects.csv', apply: true, config: { root: '/repo', readOnlyPortalIds: ['529456'] } },
    {
      account: () => ({ name: 'dev', portalId: '246389711', key: 'k' }),
      readSpecs: () => [
        normalizeRedirect({ routePrefix: '/create', destination: '/new' }),
        normalizeRedirect({ routePrefix: '/update', destination: '/better' }),
      ],
      getAll: async () => [
        { id: '22', routePrefix: '/update', destination: '/old', redirectStyle: 301, isOnlyAfterNotFound: true },
      ],
      hub: async (acct, method, path, body) => {
        calls.push({ method, path, body });
        return { ok: true, status: 200, json: { id: '33' } };
      },
    },
  );
  assert.equal(result.counts.create, 1);
  assert.equal(result.counts.update, 1);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    'POST /cms/v3/url-redirects',
    'PATCH /cms/v3/url-redirects/22',
  ]);
});

test('syncRedirects refuses apply to configured read-only portals', async () => {
  await assert.rejects(
    () => syncRedirects(
      'prod',
      { file: 'redirects.csv', apply: true, config: { root: '/repo', readOnlyPortalIds: ['529456'] } },
      {
        account: () => ({ name: 'prod', portalId: '529456', key: 'k' }),
        readSpecs: () => [],
        getAll: async () => [],
      },
    ),
    /read-only/,
  );
});

test('renderRedirectReport summarizes the plan', () => {
  const report = renderRedirectReport({
    account: 'dev',
    portalId: '246389711',
    file: 'redirects.csv',
    apply: false,
    counts: { create: 1, update: 0, unchanged: 0 },
    plan: [{ action: 'create', spec: normalizeRedirect({ routePrefix: '/old', destination: '/new' }) }],
  });
  assert.match(report, /redirects dry-run/);
  assert.match(report, /1 create/);
  assert.match(report, /\[create\] \/old -> \/new/);
});

// ---------------- reconcile mode (prod cutover) ----------------

test('normalizeRedirectPath strips scheme+host, keeps path incl. trailing slash', () => {
  assert.equal(normalizeRedirectPath('http://www.theseventhsense.com/agency-partner-program'), '/agency-partner-program');
  assert.equal(normalizeRedirectPath('https://get.theseventhsense.com/x/'), '/x/');
  assert.equal(normalizeRedirectPath('/already/a/path'), '/already/a/path');
  assert.equal(normalizeRedirectPath('no-leading-slash'), '/no-leading-slash');
  assert.equal(normalizeRedirectPath('http://host.com'), '/');
});

test('isInRedirectScope: path-form and primary host only', () => {
  assert.equal(isInRedirectScope('/team'), true);
  assert.equal(isInRedirectScope('http://www.theseventhsense.com/team'), true);
  assert.equal(isInRedirectScope('http://mktg.theseventhsense.com/team'), false);
  assert.equal(isInRedirectScope('http://get.theseventhsense.com/x'), false);
});

test('reconcile: deletes the reverse mapping that would loop, updates the same-source legacy mapping', () => {
  const specs = [normalizeRedirect({ routePrefix: '/agency-partner-program', destination: '/for-agencies' })];
  const existing = [
    { id: '1', routePrefix: 'http://www.theseventhsense.com/agency-partner-program', destination: '/agency-partner-program-old', redirectStyle: 301 },
    { id: '2', routePrefix: 'http://www.theseventhsense.com/for-agencies', destination: '/agency-partner-program', redirectStyle: 301 }, // reverse loop
    { id: '3', routePrefix: 'http://mktg.theseventhsense.com/for-agencies', destination: '/x', redirectStyle: 301 }, // out of scope, untouched
  ];
  const plan = planRedirectsReconcile(specs, existing);
  const del = plan.filter((p) => p.action === 'delete').map((p) => p.id);
  assert.deepEqual(del, ['2']); // reverse loop removed; mktg (#3) left alone
  const up = plan.find((p) => p.action === 'update');
  assert.equal(up.id, '1');
  assert.deepEqual(up.body, { destination: '/for-agencies', redirectStyle: 301 });
});

test('reconcile: keeps the correct path-form mapping, deletes the higher-precedence shadow', () => {
  const specs = [normalizeRedirect({ routePrefix: '/team', destination: '/about' })];
  const existing = [
    { id: '10', routePrefix: '/team', destination: '/about', redirectStyle: 301 }, // already correct (path-form)
    { id: '11', routePrefix: 'http://www.theseventhsense.com/team', destination: '/team-old-page', redirectStyle: 301 }, // shadow
    { id: '12', routePrefix: 'http://mktg.theseventhsense.com/team', destination: '/team/', redirectStyle: 301 }, // out of scope
  ];
  const plan = planRedirectsReconcile(specs, existing);
  assert.deepEqual(plan.filter((p) => p.action === 'delete').map((p) => p.id), ['11']);
  assert.equal(plan.find((p) => p.action === 'unchanged').id, '10');
});

test('reconcile: creates when no in-scope mapping exists; never blind-deletes root redirects', () => {
  const specs = [
    normalizeRedirect({ routePrefix: '/for-hubspot', destination: '/' }),
  ];
  const existing = [
    { id: '20', routePrefix: 'http://www.theseventhsense.com/', destination: '/somewhere', redirectStyle: 301 }, // root: excluded from Rule A
  ];
  const plan = planRedirectsReconcile(specs, existing);
  assert.equal(plan.filter((p) => p.action === 'delete').length, 0);
  assert.equal(plan.find((p) => p.action === 'create').spec.routePrefix, '/for-hubspot');
});

test('reconcile apply: a failed legacy delete does NOT fail the run; a failed managed create does', async () => {
  const acct = { name: 'dev', portalId: '246389711', key: 'k' };
  const specs = [normalizeRedirect({ routePrefix: '/s', destination: '/d' })];
  const existing = [
    { id: 'D', routePrefix: 'http://www.theseventhsense.com/d', destination: '/s', redirectStyle: 301 }, // reverse -> delete (will 500)
  ];
  const hub = async (a, method) => {
    if (method === 'DELETE') return { ok: false, status: 500, json: { message: 'boom' } };
    if (method === 'POST') return { ok: true, status: 201, json: { id: 'NEW' } };
    return { ok: true, status: 200, json: {} };
  };
  const res = await syncRedirects('dev', { apply: true, reconcile: true, file: 'x.csv' }, {
    account: () => acct,
    getAll: async () => existing,
    hub,
    readSpecs: () => specs,
    config: { root: '/tmp', readOnlyPortalIds: [] },
  });
  assert.equal(res.failures.length, 1); // the delete failed
  assert.equal(res.failures[0].item.action, 'delete');
  assert.equal(res.counts.create, 1); // managed source still created -> run succeeds
});
