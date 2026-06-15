// src/migrate.mjs — one-shot "migrate OFF HubSpot" workflow.
//
//   hcms migrate <hubspot-account> --to cloudflare
//
// Given a HubSpot credential, it: (1) MIRRORS all content into the repo (pull, all
// adapters), (2) BUILDS the static site, (3) DEPLOYS it to a pluggable backend. The
// machinery already exists (pull/buildStatic/wrangler); this wires it into one command
// and abstracts the deploy target so Cloudflare / Vercel / AWS / Azure are interchangeable.
//
// TESTABILITY: every side effect is injected — pullFn, buildFn, and a `run(cmd,args,opts)`
// child-process runner. Backends are PURE command-builders + a thin deploy() over `run`,
// so the orchestration and each backend's command construction unit-test with a fake run.

import { resolve } from 'node:path';

import { pull as realPull } from './pull.mjs';
import { buildStatic as realBuildStatic } from './build-static.mjs';

// ── deploy backends ──────────────────────────────────────────────────────────
// Each backend: { name, requiredEnv:[], commands({dir,project,env})->[[cmd,args]],
//                 parseUrl(stdout)->string|null }
// AWS needs a bucket (+ optional CloudFront id); the others take a project name.

const cloudflare = {
  name: 'cloudflare',
  requiredEnv: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
  commands: ({ dir, project }) => [
    ['npx', ['wrangler', 'pages', 'deploy', dir, '--project-name', project]],
  ],
  parseUrl: (out) => (out.match(/https:\/\/[^\s]+\.pages\.dev[^\s]*/) || [])[0] || null,
};

const vercel = {
  name: 'vercel',
  requiredEnv: ['VERCEL_TOKEN'],
  commands: ({ dir, env }) => [
    ['npx', ['vercel', 'deploy', dir, '--prod', '--yes', '--token', env.VERCEL_TOKEN]],
  ],
  parseUrl: (out) => (out.match(/https:\/\/[^\s]+\.vercel\.app[^\s]*/) || [])[0] || null,
};

const aws = {
  name: 'aws',
  // S3 bucket (required) + optional CloudFront distribution to invalidate.
  requiredEnv: ['AWS_S3_BUCKET'],
  commands: ({ dir, env }) => {
    const cmds = [['aws', ['s3', 'sync', dir, `s3://${env.AWS_S3_BUCKET}`, '--delete']]];
    if (env.AWS_CLOUDFRONT_ID) {
      cmds.push(['aws', ['cloudfront', 'create-invalidation', '--distribution-id', env.AWS_CLOUDFRONT_ID, '--paths', '/*']]);
    }
    return cmds;
  },
  parseUrl: (out, env) => (env.AWS_SITE_URL || (env.AWS_S3_BUCKET ? `https://${env.AWS_S3_BUCKET}.s3-website` : null)),
};

const azure = {
  name: 'azure',
  requiredEnv: ['AZURE_STATIC_WEB_APPS_API_TOKEN'],
  commands: ({ dir, env }) => [
    ['npx', ['@azure/static-web-apps-cli', 'deploy', dir, '--env', 'production', '--deployment-token', env.AZURE_STATIC_WEB_APPS_API_TOKEN]],
  ],
  parseUrl: (out) => (out.match(/https:\/\/[^\s]+\.azurestaticapps\.net[^\s]*/) || [])[0] || null,
};

export const BACKENDS = { cloudflare, vercel, aws, azure };

// deployStatic(backendName, { dir, project, env, run }) -> { backend, url, ran }
export async function deployStatic(backendName, { dir, project = 'site', env = process.env, run }) {
  const backend = BACKENDS[backendName];
  if (!backend) {
    throw new Error(`migrate: unknown deploy backend "${backendName}" (known: ${Object.keys(BACKENDS).join(', ')})`);
  }
  const missing = backend.requiredEnv.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`migrate: ${backend.name} deploy needs env ${missing.join(', ')} (not set)`);
  }
  const ran = [];
  let lastOut = '';
  for (const [cmd, args] of backend.commands({ dir, project, env })) {
    const res = await run(cmd, args, { env });
    ran.push(`${cmd} ${args.join(' ')}`);
    if (res.code !== 0) {
      throw new Error(`migrate: ${backend.name} deploy step failed (${cmd} -> exit ${res.code}): ${(res.stderr || res.stdout || '').slice(0, 300)}`);
    }
    lastOut += `\n${res.stdout || ''}`;
  }
  return { backend: backend.name, url: backend.parseUrl(lastOut, env) || null, ran };
}

// ── orchestration ────────────────────────────────────────────────────────────
/**
 * migrate(account, opts, deps) -> { mirrored, built, deployed }
 *
 * opts: { to, project, outDir, baseUrl, deploy=true, config }
 * deps (injectable for tests): pull, build, run, env
 */
export async function migrate(account, opts = {}, deps = {}) {
  const {
    to = 'cloudflare',
    project = 'site',
    outDir = 'dist',
    baseUrl = '',
    deploy = true,
    config,
  } = opts;
  const {
    pull = realPull,
    build = realBuildStatic,
    run = defaultRun,
    env = process.env,
    log = (m) => console.log(m),
  } = deps;

  const siteDir = config?.root || process.cwd();
  const absOut = resolve(siteDir, outDir);

  log(`migrate: 1/3 mirroring HubSpot account "${account}" -> ${siteDir} (read-only pull)`);
  const mirrored = await pull(account, { config });

  log(`migrate: 2/3 building static site -> ${absOut}`);
  const built = await build({ siteDir, outDir: absOut, baseUrl });

  let deployed = null;
  if (deploy) {
    log(`migrate: 3/3 deploying ${absOut} -> ${to}`);
    deployed = await deployStatic(to, { dir: absOut, project, env, run });
    log(`migrate: deployed${deployed.url ? ` -> ${deployed.url}` : ''}`);
  } else {
    log('migrate: 3/3 deploy skipped (--no-deploy)');
  }

  return { account, mirrored, built, deployed };
}

// Default child-process runner (inherit stdio so deploy logs stream to the user).
async function defaultRun(cmd, args, { env } = {}) {
  const { spawn } = await import('node:child_process');
  return new Promise((res) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['inherit', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { stderr += d; process.stderr.write(d); });
    child.on('close', (code) => res({ code: code ?? 1, stdout, stderr }));
    child.on('error', (e) => res({ code: 1, stdout, stderr: String(e.message) }));
  });
}

export async function main(account, opts = {}) {
  const result = await migrate(account, opts);
  return result;
}
