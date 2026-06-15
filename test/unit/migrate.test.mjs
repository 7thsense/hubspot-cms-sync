// Unit tests for src/migrate.mjs — the one-shot migrate-off-HubSpot orchestration and
// the deploy-backend registry. Every side effect is injected (pull/build/run), so no
// network, no child processes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { migrate, deployStatic, BACKENDS } from '../../src/migrate.mjs';

test('backend registry exposes cloudflare/vercel/aws/azure with required env', () => {
  assert.deepEqual(Object.keys(BACKENDS).sort(), ['aws', 'azure', 'cloudflare', 'vercel']);
  assert.ok(BACKENDS.cloudflare.requiredEnv.includes('CLOUDFLARE_API_TOKEN'));
});

test('deployStatic(cloudflare): builds the wrangler command, parses the pages.dev url', async () => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    return { code: 0, stdout: 'Deployed to https://my-site.pages.dev' };
  };
  const res = await deployStatic('cloudflare', {
    dir: '/out', project: 'my-site', run,
    env: { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a' },
  });
  assert.match(calls[0], /wrangler pages deploy \/out --project-name my-site/);
  assert.equal(res.url, 'https://my-site.pages.dev');
});

test('deployStatic(aws): s3 sync + cloudfront invalidation when a distribution is set', async () => {
  const calls = [];
  const run = async (cmd, args) => { calls.push(`${cmd} ${args.join(' ')}`); return { code: 0, stdout: '' }; };
  await deployStatic('aws', {
    dir: '/out', run,
    env: { AWS_S3_BUCKET: 'my-bucket', AWS_CLOUDFRONT_ID: 'DIST1' },
  });
  assert.match(calls[0], /s3 sync \/out s3:\/\/my-bucket --delete/);
  assert.match(calls[1], /cloudfront create-invalidation --distribution-id DIST1 --paths \/\*/);
});

test('deployStatic: missing required env is a hard error before any run', async () => {
  let ran = false;
  await assert.rejects(
    () => deployStatic('cloudflare', { dir: '/out', run: async () => { ran = true; return { code: 0 }; }, env: {} }),
    /needs env CLOUDFLARE_API_TOKEN/,
  );
  assert.equal(ran, false, 'no command runs when env is missing');
});

test('deployStatic: unknown backend is a hard error', async () => {
  await assert.rejects(() => deployStatic('netlify', { dir: '/o', run: async () => ({ code: 0 }) }), /unknown deploy backend/);
});

test('deployStatic: a failing deploy step throws with the backend + exit code', async () => {
  const run = async () => ({ code: 1, stderr: 'auth failed' });
  await assert.rejects(
    () => deployStatic('vercel', { dir: '/o', run, env: { VERCEL_TOKEN: 't' } }),
    /vercel deploy step failed.*auth failed/,
  );
});

test('migrate: orchestrates mirror -> build -> deploy in order', async () => {
  const order = [];
  const pull = async (acct, ctx) => { order.push(`pull:${acct}`); return { pulled: 7 }; };
  const build = async ({ siteDir, outDir, baseUrl }) => { order.push(`build:${outDir}:${baseUrl}`); return { pages: 3 }; };
  const run = async (cmd, args) => { order.push(`run:${cmd}`); return { code: 0, stdout: 'https://x.pages.dev' }; };

  const res = await migrate('prod', { to: 'cloudflare', project: 'p', outDir: 'dist', baseUrl: 'https://x', config: { root: '/repo' } },
    { pull, build, run, env: { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a' }, log: () => {} });

  assert.deepEqual(order, ['pull:prod', 'build:/repo/dist:https://x', 'run:npx']);
  assert.equal(res.mirrored.pulled, 7);
  assert.equal(res.deployed.url, 'https://x.pages.dev');
});

test('migrate --no-deploy: mirror + build only, no deploy backend invoked', async () => {
  let ran = false;
  const res = await migrate('prod', { deploy: false, config: { root: '/repo' } }, {
    pull: async () => ({ pulled: 1 }),
    build: async () => ({ pages: 1 }),
    run: async () => { ran = true; return { code: 0 }; },
    log: () => {},
  });
  assert.equal(ran, false, 'deploy backend not invoked');
  assert.equal(res.deployed, null);
});
