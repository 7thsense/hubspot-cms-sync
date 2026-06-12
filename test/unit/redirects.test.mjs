import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeRedirect,
  parseRedirectCsv,
  planRedirects,
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
