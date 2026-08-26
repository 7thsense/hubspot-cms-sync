#!/usr/bin/env node
// sync/pull.mjs — PULL orchestrator: HubSpot account -> canonical git tree.
//
//   node sync/pull.mjs <account>
//
// Loads every sync/adapters/*.mjs, topo-sorts by dependsOn, and runs each adapter's
// pull() in dependency order against the SOURCE account. Pull is read-only on the
// HubSpot side; each adapter GETs its resource, canonicalizes it (shape via canonical.mjs,
// identity via refs.mjs), AUTO-REGISTERS any per-account refs into the registry, and
// writes the portable result under content/ + the theme paths.
//
// The per-account registry (logical key <-> source id/url) is loaded/initialized from
// .sync-state/<portalId>.registry.json (gitignored), shared across adapters in topo
// order so a producer (forms/assets) registers source ids before a consumer pulls,
// and PERSISTED at the end so a same-account pull -> push round-trips to identical ids.
//
// PRODUCTION (portal 529456) is the canonical SOURCE — pulling FROM prod is allowed and
// expected. The read-only guard lives in push.mjs (never write to prod).

import { join } from 'node:path';

import { account as realAccount } from './lib/hub.mjs';
import { scan as realCorpusScan, DEFAULT_DIRS } from './corpus-scan.mjs';
import { loadAdapters as realLoadAdapters, topoSort } from './lib/orchestrate.mjs';
import {
  contentDir,
  loadAccountRegistry as realLoadAccountRegistry,
  persistAccountRegistry as realPersistAccountRegistry,
} from './lib/sync-state.mjs';

// `deps` is a hidden test seam: production callers pass nothing and get the real
// hub/orchestrate/sync-state functions. Unit tests inject fakes so pull() can be
// exercised with no network and no real .sync-state writes. It does NOT change the
// public signature — pull(name) is unchanged for the CLI and every caller.
export async function pull(name, deps = {}) {
  const {
    account = realAccount,
    loadAdapters = realLoadAdapters,
    loadAccountRegistry = realLoadAccountRegistry,
    persistAccountRegistry = realPersistAccountRegistry,
    corpusScan = realCorpusScan,
    config,
  } = deps;

  const acct = account(name, config);
  const registry = loadAccountRegistry(acct.portalId, config);

  const adapters = await loadAdapters();
  // PULL runs in the REVERSE of push (topo) order. On pull the producers
  // (theme/pages/content/blog) must tokenize their `@asset`/ref content BEFORE the
  // asset-COLLECTOR (`assets`) scans the tree to download bytes — otherwise assets
  // finds zero refs and downloads nothing (the pull-ordering bug). On push the
  // forward topo order is correct: `assets`/`forms` run first to register target
  // ids/URLs before consumers resolve() them.
  const order = topoSort(adapters).reverse();

  const ctx = { contentDir: contentDir(config), registry, config };

  console.log(`pull <- account "${acct.name}" (portal ${acct.portalId})`);
  console.log(`order: ${order.join(' -> ')}\n`);

  const summary = [];
  for (const adapterName of order) {
    const adapter = adapters[adapterName];
    if (typeof adapter.pull !== 'function') {
      console.log(`- ${adapterName}: no pull() — skipped`);
      summary.push({ adapter: adapterName, skipped: true });
      continue;
    }
    process.stdout.write(`- ${adapterName}: pulling… `);
    const result = (await adapter.pull(acct, ctx)) || {};
    // Persist after each adapter so a producer's registered refs survive even if a
    // later adapter throws.
    persistAccountRegistry(acct.portalId, registry, config);
    const count = result.pulled ?? result.written ?? 0;
    console.log(`done (${count})`);
    for (const note of result.notes ?? []) console.log(`    ${note}`);
    summary.push({ adapter: adapterName, ...result });
  }

  console.log('\nPull complete. Per-adapter summary:');
  for (const s of summary) {
    if (s.skipped) { console.log(`  ${s.adapter}: skipped`); continue; }
    console.log(`  ${s.adapter}: ${s.pulled ?? s.written ?? 0}`);
  }
  console.log(`Registry persisted to .sync-state/${acct.portalId}.registry.json`);

  // PORTABILITY GATE. Adapters that use assertPortableCanonical() refuse to write a
  // non-portable file in the first place; this is the catch-all behind them, covering
  // every adapter and every file shape (markdown posts, HubL templates, JS) in one
  // place. It runs AFTER the writes, so it is a detector, not a preventer: it exists
  // so a leak is discovered by the person who just pulled, in the pull that caused it,
  // instead of days later at a release gate against an immutable tag.
  const root = config?.root || process.cwd();
  const { findings, scanned } = corpusScan(DEFAULT_DIRS.map((d) => join(root, d)));
  if (findings.length > 0) {
    const byRule = new Map();
    for (const f of findings) byRule.set(f.rule, (byRule.get(f.rule) || 0) + 1);
    const files = [...new Set(findings.map((f) => f.file))];
    console.error(
      `\n✖ corpus: ${findings.length} non-portable value(s) in ${files.length} file(s) ` +
        `(${scanned} scanned) — the pulled tree is NOT safe to commit.`,
    );
    for (const f of findings.slice(0, 20)) console.error(`    ${f.file}:${f.line}  ${f.rule}: ${f.match}`);
    if (findings.length > 20) console.error(`    …and ${findings.length - 20} more`);
    console.error('  by rule: ' + [...byRule].map(([r, n]) => `${r}=${n}`).join(', '));
    console.error('  Run `hcms corpus` for the full report. Set HCMS_ALLOW_NONPORTABLE_PULL=1 to');
    console.error('  downgrade this to a warning (migrations only — do not commit the result).\n');
    if (process.env.HCMS_ALLOW_NONPORTABLE_PULL !== '1') {
      throw new Error(`pull wrote ${findings.length} non-portable value(s) into the canonical tree`);
    }
  } else {
    console.log(`corpus: clean — ${scanned} file(s) scanned, 0 non-portable values`);
  }

  return { account: acct.name, portalId: acct.portalId, order, summary, corpus: { findings, scanned } };
}

// CLI entry.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const name = process.argv[2];
  if (!name) {
    console.error('usage: node sync/pull.mjs <account>');
    process.exit(2);
  }
  pull(name).catch((e) => {
    console.error(`\npull failed: ${e.message}`);
    process.exit(1);
  });
}
