#!/usr/bin/env node
// sync/push.mjs — PUSH orchestrator: canonical git tree -> HubSpot account.
//
//   node sync/push.mjs <account> [--publish]
//
// Loads every sync/adapters/*.mjs, topo-sorts by dependsOn, and runs each adapter's
// push() in dependency order against the TARGET account. The order is load-bearing:
// the ROOT adapters `forms` and `assets` POPULATE the per-account registry (logical
// key -> target GUID / hosted url); downstream adapters (theme, pages, content, blog)
// RESOLVE those tokens via refs.resolve and HARD-FAIL on any unmapped ref. Running a
// consumer before its producer therefore aborts the push — exactly the contract topo
// order enforces.
//
// We PERSIST the registry after every adapter so the freshly-populated target mappings
// are durable for later adapters (and a re-run), and so a resolve() hard-fail aborts
// the whole push BEFORE more writes land.
//
// ⚠️ PRODUCTION (portal 529456) IS READ-ONLY. The first thing push() does — before
// loading a single adapter or touching the network — is HARD-GUARD: if the resolved
// account maps to portal 529456 it throws, regardless of CLI flags. There is no
// override.

import * as realFs from 'node:fs';
import { join, dirname } from 'node:path';

import { account as realAccount } from './lib/hub.mjs';
import { loadAdapters as realLoadAdapters, topoSort } from './lib/orchestrate.mjs';
import { listLogicalTokens } from './lib/refs.mjs';
import { resolveAssetBytesPath } from './adapters/assets.mjs';
import {
  contentDir,
  loadAccountRegistry as realLoadAccountRegistry,
  persistAccountRegistry as realPersistAccountRegistry,
} from './lib/sync-state.mjs';

// The one portal we must never write to. Hard-coded by policy, not configurable.
export const READ_ONLY_PORTAL = '529456';

// ---------------------------------------------------------------------------
// PUSH PREFLIGHT — account-independent producer-source check (fail-closed).
//
// THE HAZARD this exists to close: push() runs adapters in topo order and writes
// to the network as it goes. A consumer adapter (theme/pages/content/blog) calls
// refs.resolve() and HARD-FAILS on any @logical token with no TARGET mapping —
// but that throw lands MID-LOOP, after earlier producers (forms/assets) have
// already written to the account. The account is left half-updated.
//
// The preflight runs BEFORE the adapter loop (before ANY network write) and is
// ACCOUNT-INDEPENDENT: it does not look at any target registry. It only asks
// "does every @logical ref in the to-be-pushed canonical content have a backing
// PRODUCER SOURCE ON DISK?" — i.e. is the ref even SATISFIABLE in principle. If a
// ref can never be satisfied (e.g. @cta — no producer adapter exists yet), or its
// producer source is missing (e.g. a referenced @asset with no committed bytes),
// the push fails CLOSED here, before the account is touched.
//
// Satisfiability rules (the producer contracts, per refs.mjs + the adapters):
//   @portal       -> ALWAYS satisfiable (every account has a portal id).
//   @form:<k>     -> content/forms/<k>.json exists, OR <k> is a key in
//                    content/forms/guids.json (the on-disk @form producer source).
//   @asset:<p>    -> committed bytes exist for the asset key, under EITHER the
//                    unified assets tree (content/assets/<p>) OR the blog adapter's
//                    own manifest tree (content/blog/assets/<p>). Both are legitimate
//                    @asset producer sources: the assets adapter uploads
//                    content/assets/<p>, and blog.rehostAssets uploads its manifest
//                    files committed under content/blog/assets/<p>. The preflight
//                    accepts either so a blog-manifest @asset is satisfiable. (codex
//                    #6 asset-scheme unification.)
//   @cta:<k>      -> UNSATISFIABLE: no adapter produces @cta yet (known gap).
//   @menu:<k>     -> UNSATISFIABLE: no adapter produces @menu yet (known gap).
//
// Sources scanned — EVERY canonical content file that can carry a @logical token,
// found by RECURSIVELY walking each ref-bearing tree (so a new file dropped into a
// scanned tree is covered automatically — no hand-maintained file list to drift):
//   content/pages/**.json    (incl. *.widgets.json)
//   content/blog/**.json      EXCEPT the byte tree content/blog/assets/** — that
//                             carrier-EXEMPT tree holds the blog adapter's committed
//                             IMAGE BYTES (a @asset PRODUCER source), not tokens. This
//                             is the bug the broadened scan closes: the first full push
//                             never scanned content/blog/authors.json (an avatar @asset
//                             with no committed bytes) and only the assets adapter — a
//                             mid-loop, post-network-write throw — caught it. Scanning
//                             authors.json / tags.json / blogs.json / container.json /
//                             posts/** here fails that case CLOSED at preflight.
//   content/forms/**.json     EXCEPT properties.json + guids.json (producer sources,
//                             not token carriers; guids.json is the @form producer).
//   theme ref-bearers at the repo root: js/hs-forms.js,
//     modules/*/fields.json, modules/*/module.html
//
// EXEMPT (a @logical PRODUCER source / raw bytes, never a token carrier — scanning it
// is wrong, not merely redundant): content/assets/** and content/blog/assets/** hold
// binary image bytes; content/forms/{guids,properties}.json are form producer state.
//
// Pure + fs-injectable so it unit-tests with a fake fs and no network.
// ---------------------------------------------------------------------------

// Recursively list the *.json files under `dir`. Returns absolute paths. A missing
// dir yields []. `exclude(absPath)` is consulted for EVERY entry (file or dir): a
// dir for which it returns true is not descended (its whole subtree is skipped — e.g.
// the content/blog/assets byte tree), and a file for which it returns true is omitted
// (e.g. content/forms/guids.json, a producer source not a token carrier). `fs` is
// injected for testing. readdirSync uses withFileTypes so the fake fs in tests must
// supply Dirent-like entries — but to keep the fake fs minimal we detect directories
// via existsSync on the child rather than relying on Dirent. (See walk below.)
function listJsonFilesRecursive(fs, dir, exclude = () => false) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    let names;
    try {
      names = fs.readdirSync(d);
    } catch {
      return; // not a directory / unreadable
    }
    for (const name of names) {
      const full = join(d, name);
      if (exclude(full)) continue;
      // A child that itself lists children is a directory; recurse. Otherwise, if it
      // ends in .json, it's a ref-carrier file we must scan. (Probing via readdirSync
      // keeps the fake test fs free of Dirent types.)
      if (isDir(fs, full)) walk(full);
      else if (name.endsWith('.json')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

// True if `p` is a directory under the injected fs. The fake test fs models dirs as
// "readdirSync succeeds"; the real fs has statSync, so prefer it when present.
function isDir(fs, p) {
  if (typeof fs.statSync === 'function') {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  }
  try {
    fs.readdirSync(p);
    return true;
  } catch {
    return false;
  }
}

// The repo-root theme files that carry @logical tokens. `contentDir` is
// `<root>/content`, so the theme tree is its sibling at `<root>`.
function themeRefFiles(fs, root) {
  const files = [join(root, 'js', 'hs-forms.js')];
  const modulesDir = join(root, 'modules');
  if (fs.existsSync(modulesDir)) {
    for (const ent of fs.readdirSync(modulesDir)) {
      files.push(join(modulesDir, ent, 'fields.json'));
      files.push(join(modulesDir, ent, 'module.html'));
    }
  }
  return files.filter((f) => fs.existsSync(f));
}

// Build the set of @form keys that HAVE a producer source on disk, from both the
// per-form files (content/forms/<k>.json) and the keyed content/forms/guids.json.
function knownFormKeys(fs, formsDir) {
  const keys = new Set();
  if (fs.existsSync(formsDir)) {
    for (const n of fs.readdirSync(formsDir)) {
      if (!n.endsWith('.json')) continue;
      if (n === 'properties.json' || n === 'guids.json') continue;
      keys.add(n.slice(0, -'.json'.length));
    }
  }
  const guidsFile = join(formsDir, 'guids.json');
  if (fs.existsSync(guidsFile)) {
    try {
      const obj = JSON.parse(fs.readFileSync(guidsFile, 'utf8'));
      if (obj && typeof obj === 'object') for (const k of Object.keys(obj)) keys.add(k);
    } catch {
      /* a malformed guids.json contributes no keys (the offending @form refs then fail) */
    }
  }
  return keys;
}

/**
 * preflightRefs(contentDir, deps) — account-independent satisfiability check.
 * Scans the canonical content + theme ref-bearing files for @logical tokens and
 * verifies each has a backing producer SOURCE on disk. THROWS an aggregated error
 * naming EVERY unsatisfiable ref (with the file it appears in) if any is found;
 * returns the list of scanned files on success. Pure aside from the injected fs.
 *
 * @param {string} contentDirPath absolute path to the canonical content/ tree
 * @param {{ fs?: typeof import('node:fs') }} [deps] fs seam for tests
 * @returns {{ scanned: string[] }}
 */
export function preflightRefs(contentDirPath, deps = {}) {
  const fs = deps.fs || realFs;
  const root = dirname(contentDirPath); // <root>/content -> <root>
  const formsDir = join(contentDirPath, 'forms');
  const formKeys = knownFormKeys(fs, formsDir);

  // Carrier-EXEMPT paths: PRODUCER sources / raw bytes that are NOT token carriers, so
  // they must be skipped by the recursive walk (the assets trees hold binary bytes;
  // the forms producer files hold @form-source state, not refs).
  const blogAssetsDir = join(contentDirPath, 'blog', 'assets'); // blog byte tree
  const formsGuids = join(formsDir, 'guids.json'); // @form producer source
  const formsProps = join(formsDir, 'properties.json'); // form field producer source
  const excludeBlog = (p) => p === blogAssetsDir; // skip the whole blog byte subtree
  const excludeForms = (p) => p === formsGuids || p === formsProps;

  // Every file we must scan for tokens: RECURSIVELY across each ref-bearing canonical
  // tree (pages, blog-minus-bytes, forms-minus-producers) plus the theme ref-bearers.
  // The recursion means newly-added files (e.g. content/blog/authors.json, which the
  // first full push never scanned) are covered automatically.
  const files = [
    ...listJsonFilesRecursive(fs, join(contentDirPath, 'pages')),
    ...listJsonFilesRecursive(fs, join(contentDirPath, 'blog'), excludeBlog),
    ...listJsonFilesRecursive(fs, formsDir, excludeForms),
    ...themeRefFiles(fs, root),
  ];

  // Collect EVERY unsatisfiable ref before throwing (operator fixes them in one pass).
  const offenders = []; // { file, token, reason }
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // unreadable file contributes no tokens
    }
    for (const { kind, key, token } of listLogicalTokens(text)) {
      if (kind === 'portal') continue; // always satisfiable
      if (kind === 'form') {
        if (!formKeys.has(key)) {
          offenders.push({ file, token, reason: `no content/forms/${key}.json and not in guids.json` });
        }
        continue;
      }
      if (kind === 'asset') {
        // An @asset's committed bytes may live in EITHER scheme's tree
        // (content/assets/<key> for the assets adapter, content/blog/assets/<key>
        // for the blog manifest). resolveAssetBytesPath unifies both — a
        // blog-manifest @asset is satisfiable here. (codex #6.)
        if (!resolveAssetBytesPath(contentDirPath, key, fs.existsSync)) {
          offenders.push({
            file,
            token,
            reason: `no committed bytes at content/assets/${key} or content/blog/assets/${key}`,
          });
        }
        continue;
      }
      // @cta / @menu — no producer adapter exists yet (known gap): UNSATISFIABLE.
      offenders.push({ file, token, reason: `no producer for @${kind} (unsatisfiable)` });
    }
  }

  if (offenders.length > 0) {
    const lines = offenders
      .map((o) => `  ${o.token}  in ${o.file}  — ${o.reason}`)
      .sort();
    throw new Error(
      `push preflight: ${offenders.length} unsatisfiable @logical ref(s) have no producer source on disk; ` +
        `push refuses to run (fail-closed before any network write):\n${lines.join('\n')}`,
    );
  }

  return { scanned: files };
}

// `deps` is a hidden test seam: production callers pass nothing and get the real
// hub/orchestrate/sync-state functions. Unit tests inject fakes so push() can be
// exercised with no network and no real .sync-state writes.
export async function push(name, options = {}, deps = {}) {
  const { publish = false, config: optionConfig } = options;
  const {
    account = realAccount,
    loadAdapters = realLoadAdapters,
    loadAccountRegistry = realLoadAccountRegistry,
    persistAccountRegistry = realPersistAccountRegistry,
    fs = realFs,
  } = deps;
  const config = deps.config || optionConfig;

  const acct = account(name, config);

  // HARD GUARD #1 (FIRST, before the preflight) — refuse to write to production no
  // matter what was asked.
  const readOnly = new Set((config?.readOnlyPortalIds?.length ? config.readOnlyPortalIds : [READ_ONLY_PORTAL]).map(String));
  if (readOnly.has(String(acct.portalId))) {
    throw new Error(
      `portal is read-only: account "${acct.name}" maps to portal ${acct.portalId}; push refuses to run`,
    );
  }

  // PREFLIGHT (account-independent) — verify every @logical ref in the to-be-pushed
  // canonical content has a backing producer source on disk. Runs BEFORE the adapter
  // loop (before ANY network write / registry load) so an unsatisfiable ref fails the
  // push CLOSED instead of half-updating the account on a mid-loop resolve() throw.
  preflightRefs(contentDir(config), { fs });

  const registry = loadAccountRegistry(acct.portalId, config);

  const adapters = await loadAdapters();
  const order = topoSort(adapters);

  const ctx = { contentDir: contentDir(config), registry, publish, config };

  console.log(`push -> account "${acct.name}" (portal ${acct.portalId})${publish ? ' [--publish]' : ''}`);
  console.log(`order: ${order.join(' -> ')}\n`);

  const summary = [];
  for (const adapterName of order) {
    const adapter = adapters[adapterName];
    if (typeof adapter.push !== 'function') {
      console.log(`- ${adapterName}: no push() — skipped`);
      summary.push({ adapter: adapterName, skipped: true });
      continue;
    }
    process.stdout.write(`- ${adapterName}: pushing… `);
    // A resolve() hard-fail inside an adapter throws here and aborts the whole push
    // (the surrounding try in the CLI handler / caller); nothing further is written.
    const result = (await adapter.push(acct, ctx)) || {};
    // Persist immediately so forms/assets target mappings are durable before the next
    // (consuming) adapter resolves against them.
    persistAccountRegistry(acct.portalId, registry, config);
    const count = result.pushed ?? 0;
    console.log(`done (${count})`);
    for (const note of result.notes ?? []) console.log(`    ${note}`);
    summary.push({ adapter: adapterName, ...result });
  }

  console.log('\nPush complete. Per-adapter summary:');
  for (const s of summary) {
    if (s.skipped) { console.log(`  ${s.adapter}: skipped`); continue; }
    console.log(`  ${s.adapter}: ${s.pushed ?? 0}`);
  }

  return { account: acct.name, portalId: acct.portalId, order, summary };
}

// CLI entry.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  const publish = args.includes('--publish');
  const name = args.find((a) => !a.startsWith('--'));
  if (!name) {
    console.error('usage: node sync/push.mjs <account> [--publish]');
    process.exit(2);
  }
  push(name, { publish }).catch((e) => {
    console.error(`\npush failed: ${e.message}`);
    process.exit(1);
  });
}
