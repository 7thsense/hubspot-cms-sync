#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { Command } from 'commander';

import { loadConfig } from '../src/config.mjs';
import { pull } from '../src/pull.mjs';
import { push, preflightRefs } from '../src/push.mjs';
import { main as preflightMain } from '../src/preflight.mjs';
import { main as republishMain } from '../src/republish.mjs';
import { main as manifestMain } from '../src/manifest.mjs';
import { renderRedirectReport, syncRedirects } from '../src/redirects.mjs';
import { buildStatic } from '../src/build-static.mjs';
import { resolve as resolvePath } from 'node:path';

function runNodeScript(script, args, { cwd }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function withConfig(opts) {
  return loadConfig({ root: opts.root });
}

async function main(argv = process.argv) {
  const program = new Command();

  program
    .name('hcms')
    .description('Git-backed HubSpot CMS sync')
    .option('--root <path>', 'repo root', process.cwd())
    .showHelpAfterError();

  program
    .command('doctor')
    .description('print resolved configuration')
    .action(async () => {
      const config = await withConfig(program.opts());
      console.log(`root: ${config.root}`);
      console.log(`accounts: ${config.accountsPath}`);
      console.log(`content: ${config.contentDirPath}`);
      console.log(`manifest: ${config.manifestFilePath}`);
      console.log(`redirects: ${config.redirectsFilePath || '(none)'}`);
      console.log(`sync state: ${config.syncStateDirPath}`);
      console.log(`theme: ${config.theme.name}`);
    });

  program
    .command('build')
    .description('render the canonical site to a static directory (static target)')
    .option('--out <dir>', 'output directory', 'dist')
    .option('--base-url <url>', 'absolute base URL for canonical/og links', '')
    .option('--tracking-portal <id>', 'HubSpot tracking-script portal id (keeps forms de-anonymizing)')
    .option('--blog-page-size <n>', 'posts per blog listing page (match the HubSpot blog setting)', '10')
    .action(async (options) => {
      const config = await withConfig(program.opts());
      const summary = await buildStatic({
        siteDir: config.root,
        outDir: resolvePath(config.root, options.out),
        baseUrl: options.baseUrl,
        trackingPortalId: options.trackingPortal,
        blogPageSize: Number(options.blogPageSize),
      });
      console.log(`built static site -> ${options.out}`);
      console.log(
        `  pages: ${summary.pages} | posts: ${summary.posts} | tag pages: ${summary.tags} | `
        + `html files: ${summary.files} | redirects: ${summary.redirects}`,
      );
    });

  program
    .command('pull')
    .description('pull HubSpot content into the repo')
    .argument('<account>')
    .action(async (account) => {
      const config = await withConfig(program.opts());
      await pull(account, { config });
    });

  program
    .command('push')
    .description('push repo content to HubSpot')
    .argument('<account>')
    .option('--publish', 'publish/schedule pushed content')
    .option('--dry-run', 'run local push preflight only')
    .action(async (account, options) => {
      const config = await withConfig(program.opts());
      if (options.dryRun) {
        preflightRefs(config.contentDirPath);
        console.log(`dry-run push preflight passed for ${account}`);
        return;
      }
      await push(account, { publish: !!options.publish, config });
    });

  program
    .command('preflight')
    .description('check account readiness before a push')
    .argument('<account>')
    .option('--allow-repairable', 'allow source-repairable portal drift before the push')
    .action(async (account, options) => {
      const config = await withConfig(program.opts());
      const args = [account];
      if (options.allowRepairable) args.push('--allow-repairable');
      const code = await preflightMain(args, { config });
      if (code) process.exitCode = code;
    });

  program
    .command('redirects')
    .description('plan or apply managed URL redirects')
    .argument('<account>')
    .option('--file <path>', 'redirect spec CSV or JSON; defaults to config.redirectsFile')
    .option('--apply', 'write creates/updates to HubSpot')
    .action(async (account, options) => {
      const config = await withConfig(program.opts());
      const result = await syncRedirects(account, {
        file: options.file,
        apply: !!options.apply,
        config,
      });
      console.log(renderRedirectReport(result));
    });

  program
    .command('republish')
    .description('republish live pages and/or blog posts')
    .allowUnknownOption()
    .allowExcessArguments()
    .argument('[args...]')
    .action(async (args) => {
      const config = await withConfig(program.opts());
      const code = await republishMain(args, { config });
      if (code) process.exitCode = code;
    });

  program
    .command('corpus')
    .description('scan repo content for unsafe refs and HubSpot artifacts')
    .allowUnknownOption()
    .argument('[paths...]')
    .action(async (paths) => {
      const config = await withConfig(program.opts());
      const script = new URL('../src/corpus-scan.mjs', import.meta.url).pathname;
      const code = await runNodeScript(script, paths, { cwd: config.root });
      if (code) process.exitCode = code;
    });

  program
    .command('manifest')
    .description('manifest utilities')
    .allowUnknownOption()
    .allowExcessArguments()
    .argument('[args...]')
    .action(async (args) => {
      const config = await withConfig(program.opts());
      const code = await manifestMain(args, { config });
      if (code) process.exitCode = code;
    });

  await program.parseAsync(argv);
}

main().catch((e) => {
  console.error(`hcms failed: ${e.message}`);
  process.exitCode = 1;
});
