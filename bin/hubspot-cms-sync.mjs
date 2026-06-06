#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';
import { pull } from '../src/pull.mjs';
import { push } from '../src/push.mjs';
import { main as preflightMain } from '../src/preflight.mjs';
import { main as republishMain } from '../src/republish.mjs';
import { main as manifestMain } from '../src/manifest.mjs';

function usage() {
  console.log(`usage: hcms [--root <path>] <command> [args]

commands:
  pull <account>
  push <account> [--publish] [--dry-run]
  preflight <account>
  republish <account|portalId> [--all] [--blog] [slugs...]
  corpus [paths...]
  manifest [args...]
  doctor
`);
}

function parseGlobal(argv) {
  const out = { root: process.cwd(), args: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--root') {
      out.root = argv[++i];
    } else {
      out.args.push(a);
    }
  }
  return out;
}

function runNodeScript(script, args, { cwd }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function main(argv = process.argv.slice(2)) {
  const { root, args } = parseGlobal(argv);
  const [cmd, ...rest] = args;
  if (!cmd || cmd === '-h' || cmd === '--help') {
    usage();
    return cmd ? 0 : 2;
  }

  const config = await loadConfig({ root });

  if (cmd === 'doctor') {
    console.log(`root: ${config.root}`);
    console.log(`accounts: ${config.accountsPath}`);
    console.log(`content: ${config.contentDirPath}`);
    console.log(`manifest: ${config.manifestFilePath}`);
    console.log(`sync state: ${config.syncStateDirPath}`);
    console.log(`theme: ${config.theme.name}`);
    return 0;
  }

  if (cmd === 'pull') {
    const account = rest[0];
    if (!account) throw new Error('pull requires <account>');
    await pull(account, { config });
    return 0;
  }

  if (cmd === 'push') {
    const publish = rest.includes('--publish');
    const dryRun = rest.includes('--dry-run');
    const account = rest.find((a) => !a.startsWith('--'));
    if (!account) throw new Error('push requires <account>');
    if (dryRun) {
      // Current engine preflight is the no-write plan surface. A future plan command
      // can add per-adapter write summaries.
      const { preflightRefs } = await import('../src/push.mjs');
      preflightRefs(config.contentDirPath);
      console.log(`dry-run push preflight passed for ${account}`);
      return 0;
    }
    await push(account, { publish, config });
    return 0;
  }

  if (cmd === 'preflight') {
    return preflightMain(rest, { config });
  }

  if (cmd === 'republish') {
    return republishMain(rest, { config });
  }

  if (cmd === 'manifest') {
    return manifestMain(rest, { config });
  }

  if (cmd === 'corpus') {
    const script = new URL('../src/corpus-scan.mjs', import.meta.url).pathname;
    return runNodeScript(script, rest, { cwd: config.root });
  }

  usage();
  return 2;
}

main().then((code) => {
  process.exitCode = code;
}).catch((e) => {
  console.error(`hcms failed: ${e.message}`);
  process.exitCode = 1;
});
