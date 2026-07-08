#!/usr/bin/env node
// src/email-inventory.mjs — read-only marketing email inventory + spike snapshots.
//
//   hcms emails inventory <account> [--out <dir>] [--include-archived]
//
// Fetches all marketing emails, writes raw JSON snapshots to
// .sync-state/email-spike/<account>/, and prints a histogram report.
// Never writes to HubSpot.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { account as resolveAccount, hub, getAll } from './lib/hub.mjs';
import { stableStringify } from './lib/canonical.mjs';
import { loadConfig } from './config.mjs';
import { syncStateDir } from './lib/sync-state.mjs';
import {
  emailKeyForName,
  templateMappingKeyForPath,
  canonicalEmail,
} from './lib/email-canonical.mjs';
import { emptyRegistry } from './lib/refs.mjs';
import { ctaGuidsInText } from './cta-inventory.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function bump(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function analyze(emails) {
  const states = {};
  const types = {};
  const modes = {};
  const templatePaths = {};
  const subscriptions = {};
  let withAssets = 0;
  let withCtas = 0;

  for (const e of emails) {
    bump(states, e.state || 'unknown');
    bump(types, e.type || 'unknown');
    bump(modes, e.emailTemplateMode || 'unknown');
    const tp = e.content?.templatePath || '(none)';
    bump(templatePaths, tp);
    const sub = e.subscriptionDetails?.subscriptionName || '(none)';
    bump(subscriptions, sub);
    const blob = JSON.stringify(e.content || {});
    if (/hubfs|hubspotusercontent|cdn\d*\.hubspot/i.test(blob)) withAssets += 1;
    if (ctaGuidsInText(blob).length > 0) withCtas += 1;
  }

  return { states, types, modes, templatePaths, subscriptions, withAssets, withCtas };
}

export async function runEmailInventory(accountName, opts = {}) {
  const config = opts.config ?? (await loadConfig({ root: opts.root ?? process.cwd() }));
  const acct = resolveAccount(accountName, config);
  const includeArchived = !!opts.includeArchived;

  let emails = await getAll(acct, '/marketing/v3/emails');
  if (includeArchived) {
    const archived = await getAll(acct, '/marketing/v3/emails?archived=true');
    const seen = new Set(emails.map((e) => String(e.id)));
    for (const e of archived) {
      if (!seen.has(String(e.id))) emails.push(e);
    }
  }

  const outRoot = opts.outDir
    ?? join(syncStateDir(config), 'email-spike', acct.name);
  mkdirSync(outRoot, { recursive: true });

  const registry = emptyRegistry(acct.portalId);
  const analysis = analyze(emails);

  for (const e of emails) {
    const id = String(e.id);
    writeFileSync(join(outRoot, `${id}.json`), stableStringify(e));
  }
  writeFileSync(join(outRoot, '_index.json'), stableStringify({
    account: acct.name,
    portalId: acct.portalId,
    total: emails.length,
    analysis,
  }));

  // Sample canonical projections (first 10 by stable key sort)
  const samples = [...emails]
    .sort((a, b) => emailKeyForName(a.name).localeCompare(emailKeyForName(b.name)))
    .slice(0, 10);
  const sampleDir = join(outRoot, 'canonical-samples');
  mkdirSync(sampleDir, { recursive: true });
  for (const raw of samples) {
    const { canon } = canonicalEmail(raw, { registry });
    writeFileSync(
      join(sampleDir, `${canon.key}.json`),
      stableStringify(canon),
    );
  }

  const templateCandidates = {};
  for (const [path, count] of Object.entries(analysis.templatePaths).sort((a, b) => b[1] - a[1])) {
    const key = templateMappingKeyForPath(path);
    if (key) {
      templateCandidates[key] = { sourcePath: path, count };
    }
  }
  writeFileSync(join(outRoot, 'template-path-candidates.json'), stableStringify(templateCandidates));

  return { acct, emails, analysis, outRoot, templateCandidates };
}

export function renderInventoryReport(result) {
  const { acct, emails, analysis, outRoot } = result;
  const lines = [
    `email inventory: account "${acct.name}" (portal ${acct.portalId})`,
    `total: ${emails.length}`,
    `snapshots: ${outRoot}`,
    '',
    'states:',
    ...Object.entries(analysis.states).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k}: ${v}`),
    '',
    'types:',
    ...Object.entries(analysis.types).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k}: ${v}`),
    '',
    'template modes:',
    ...Object.entries(analysis.modes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k}: ${v}`),
    '',
    `with hosted assets in body: ${analysis.withAssets}`,
    `with CTA embeds: ${analysis.withCtas}`,
    '',
    'top template paths:',
    ...Object.entries(analysis.templatePaths)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([k, v]) => `  ${v}x ${k}`),
  ];
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2), opts = {}) {
  const account = argv[0];
  if (!account || account === '--help' || account === '-h') {
    console.log('usage: hcms emails inventory <account> [--include-archived]');
    return 0;
  }
  const includeArchived = argv.includes('--include-archived');
  const outIdx = argv.indexOf('--out');
  const outDir = outIdx >= 0 ? argv[outIdx + 1] : undefined;

  const result = await runEmailInventory(account, { ...opts, includeArchived, outDir });
  console.log(renderInventoryReport(result));
  return 0;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((e) => {
    console.error(`email inventory failed: ${e.message}`);
    process.exit(1);
  });
}