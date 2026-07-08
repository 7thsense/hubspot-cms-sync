#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { Command } from 'commander';

import { loadConfig } from '../src/config.mjs';
import { pull } from '../src/pull.mjs';
import { push, preflightRefs, pushScopeFromOnly } from '../src/push.mjs';
import { main as preflightMain } from '../src/preflight.mjs';
import { main as republishMain } from '../src/republish.mjs';
import { main as manifestMain } from '../src/manifest.mjs';
import { renderRedirectReport, syncRedirects } from '../src/redirects.mjs';
import { buildStatic } from '../src/build-static.mjs';
import { main as reconcileMain } from '../src/reconcile.mjs';
import { main as deleteMain } from '../src/deletions.mjs';
import { main as migrateMain, BACKENDS } from '../src/migrate.mjs';
import { main as emailInventoryMain } from '../src/email-inventory.mjs';
import { main as emailImportMain } from '../src/email-import.mjs';
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
    .option('--forms-portal <id>', 'HubSpot portal id whose registry resolves embedded @form/@portal/@cta (which account forms POST to)')
    .option('--blog-page-size <n>', 'posts per blog listing page (match the HubSpot blog setting)', '10')
    .action(async (options) => {
      const config = await withConfig(program.opts());
      const summary = await buildStatic({
        siteDir: config.root,
        outDir: resolvePath(config.root, options.out),
        baseUrl: options.baseUrl,
        trackingPortalId: options.trackingPortal,
        formsPortal: options.formsPortal,
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
    .option('--force', 'overwrite items that drifted on HubSpot (UI edits) since the last sync')
    .option('--dry-run', 'run local push preflight only')
    .option('--only <adapters>', 'comma-separated adapter subset (deps included), e.g. emails,email-templates')
    .option(
      '--allow-template-fallback',
      'when a committed DnD shell is missing on the portal, use HubSpot Start_from_scratch instead of failing',
    )
    .action(async (account, options) => {
      const config = await withConfig(program.opts());
      const only = options.only
        ? options.only.split(',').map((s) => s.trim()).filter(Boolean)
        : null;
      if (options.dryRun) {
        const scope = pushScopeFromOnly(only);
        preflightRefs(config.contentDirPath, { config, scope });
        console.log(`dry-run push preflight passed for ${account} (scope: ${scope})`);
        return;
      }
      await push(account, {
        publish: !!options.publish,
        force: !!options.force,
        only,
        allowTemplateFallback: !!options.allowTemplateFallback,
        config,
      });
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
    .option('--reconcile', 'path-normalized cutover: replace shadowing/reverse legacy redirects for managed routes (continue-on-error)')
    .action(async (account, options) => {
      const config = await withConfig(program.opts());
      try {
        const result = await syncRedirects(account, {
          file: options.file,
          apply: !!options.apply,
          reconcile: !!options.reconcile,
          config,
        });
        console.log(renderRedirectReport(result));
      } catch (e) {
        if (e.result) console.log(renderRedirectReport(e.result));
        throw e;
      }
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

  const emails = program.command('emails').description('marketing email utilities');

  const importCmd = emails.command('import').description('import external email designs into canonical layout');

  importCmd
    .command('beefree')
    .description('import Beefree Simple Schema JSON → campaign + email-templates shell')
    .argument('<schema>', 'path to Beefree simple schema JSON')
    .requiredOption('--key <key>', 'campaign logical key')
    .option('--template <key>', 'email template shell key (defaults to --key)')
    .option('--theme <name>', 'theme name prefix for templatePath')
    .option('--name <name>', 'email display name')
    .option('--subject <subject>', 'email subject line')
    .option('--write', 'write files to repo (default dry-run)')
    .action(async (schema, options) => {
      const config = await withConfig(program.opts());
      const argv = [
        schema,
        '--key', options.key,
        ...(options.template ? ['--template', options.template] : []),
        ...(options.theme ? ['--theme', options.theme] : []),
        ...(options.name ? ['--name', options.name] : []),
        ...(options.subject ? ['--subject', options.subject] : []),
        ...(options.write ? ['--write'] : []),
      ];
      const code = await emailImportMain(argv, config);
      if (code) process.exitCode = code;
    });

  importCmd
    .command('beefree-zip')
    .description('import Beefree HTML+images zip export → DnD campaign + content/assets')
    .argument('<export>', 'path to .zip export or extracted directory (index.html + images/)')
    .requiredOption('--key <key>', 'campaign logical key')
    .option('--name <name>', 'email display name')
    .option('--subject <subject>', 'email subject line')
    .option('--preview-text <text>', 'inbox preview text')
    .option('--template-path <path>', 'HubSpot DnD shell (default Start_from_scratch)')
    .option('--content-spec <path>', 'override content.spec.json path')
    .option('--no-content-spec', 'skip imports/beefree/<key>/content.spec.json if present')
    .option('--write', 'write files to repo (default dry-run)')
    .action(async (exportPath, options) => {
      const config = await withConfig(program.opts());
      const argv = [
        'beefree-zip',
        exportPath,
        '--key', options.key,
        ...(options.name ? ['--name', options.name] : []),
        ...(options.subject ? ['--subject', options.subject] : []),
        ...(options.previewText ? ['--preview-text', options.previewText] : []),
        ...(options.templatePath ? ['--template-path', options.templatePath] : []),
        ...(options.contentSpec ? ['--content-spec', options.contentSpec] : []),
        ...(options.noContentSpec ? ['--no-content-spec'] : []),
        ...(options.write ? ['--write'] : []),
      ];
      const code = await emailImportMain(argv, config);
      if (code) process.exitCode = code;
    });

  importCmd
    .command('beefree-apply-content')
    .description('re-apply imports/beefree/<key>/content.spec.json to campaign JSON')
    .requiredOption('--key <key>', 'campaign logical key')
    .argument('[spec]', 'optional path to content.spec.json')
    .option('--name <name>', 'email display name')
    .option('--subject <subject>', 'email subject line')
    .option('--preview-text <text>', 'inbox preview text')
    .option('--write', 'write updated campaign + customized.index.html')
    .action(async (spec, options) => {
      const config = await withConfig(program.opts());
      const argv = [
        'beefree-apply-content',
        ...(spec ? [spec] : []),
        '--key', options.key,
        ...(options.name ? ['--name', options.name] : []),
        ...(options.subject ? ['--subject', options.subject] : []),
        ...(options.previewText ? ['--preview-text', options.previewText] : []),
        ...(options.write ? ['--write'] : []),
      ];
      const code = await emailImportMain(argv, config);
      if (code) process.exitCode = code;
    });

  emails
    .command('inventory')
    .description('read-only email inventory + spike snapshots to .sync-state/email-spike/')
    .argument('<account>')
    .option('--include-archived', 'also fetch archived=true emails')
    .option('--out <dir>', 'override output directory')
    .action(async (account, options) => {
      const config = await withConfig(program.opts());
      const argv = [account];
      if (options.includeArchived) argv.push('--include-archived');
      if (options.out) argv.push('--out', options.out);
      const code = await emailInventoryMain(argv, { config, root: config.root });
      if (code) process.exitCode = code;
    });

  program
    .command('reconcile')
    .description('read-only cross-account orphan/missing report (git vs HubSpot)')
    .argument('<accounts...>', 'one or more account names (e.g. prod dev)')
    .option('--emit-deletions <file>', 'write orphans as a deletions.csv clean-slate list (one account; read-only)')
    .option('--surfaces <list>', 'comma-separated surfaces for --emit-deletions (default site-pages,landing-pages,menus)')
    .action(async (accounts, options) => {
      const config = await withConfig(program.opts());
      await reconcileMain(accounts, { config, emitDeletionsFile: options.emitDeletions, surfaces: options.surfaces });
    });

  program
    .command('delete')
    .description('delete content listed in sync/deletions.csv (dry-run unless --apply)')
    .argument('<account>')
    .option('--apply', 'actually delete (default: dry-run plan only)')
    .option('--file <path>', 'deletions list path (default sync/deletions.csv)')
    .action(async (account, options) => {
      const config = await withConfig(program.opts());
      await deleteMain(account, { apply: !!options.apply, file: options.file, config });
    });

  program
    .command('migrate')
    .description('one-shot migrate OFF HubSpot: mirror -> build -> deploy to a static host')
    .argument('<account>', 'source HubSpot account (credential)')
    .option('--to <backend>', `deploy backend: ${Object.keys(BACKENDS).join('|')}`, 'cloudflare')
    .option('--project <name>', 'deploy project/site name', 'site')
    .option('--out <dir>', 'static build output dir', 'dist')
    .option('--base-url <url>', 'absolute base URL for canonical/og links', '')
    .option('--no-deploy', 'mirror + build only (skip the deploy step)')
    .action(async (account, options) => {
      const config = await withConfig(program.opts());
      await migrateMain(account, {
        to: options.to, project: options.project, outDir: options.out,
        baseUrl: options.baseUrl, deploy: options.deploy !== false, config,
      });
    });

  await program.parseAsync(argv);
}

main().catch((e) => {
  console.error(`hcms failed: ${e.message}`);
  process.exitCode = 1;
});
