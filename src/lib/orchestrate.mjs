// sync/lib/orchestrate.mjs — shared adapter loading + dependency ordering.
//
// The pull/push orchestrators (sync/pull.mjs, sync/push.mjs) both need to:
//   1. discover every adapter under sync/adapters/*.mjs and key it by `name`, and
//   2. run those adapters in DEPENDENCY ORDER (an adapter's `dependsOn` names must
//      have run first).
//
// On PUSH the order is load-bearing: the `forms` and `assets` adapters POPULATE the
// per-account registry (logical key -> target id / hosted url) that downstream
// adapters (theme, pages, content, blog) RESOLVE via refs.resolve. Run a consumer
// before its producer and resolve() hard-fails on an unmapped ref. topoSort encodes
// that contract from each adapter's declared `dependsOn`, so neither orchestrator
// hardcodes a sequence — add an adapter, declare its deps, and the order follows.
//
// On PULL order is not strictly required (pull is read-only and auto-registers refs),
// but we run the SAME topo order for determinism and so a producer's registry entries
// exist before a consumer pulls (e.g. forms register source GUIDs first).
//
// PURE except for loadAdapters' dynamic import: topoSort is a pure function over a
// {name: {dependsOn}} map, so it unit-tests with fake adapter modules and no fs.

import { readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// sync/lib/orchestrate.mjs -> sync/adapters/
const ADAPTERS_DIR = join(__dirname, '..', 'adapters');

/**
 * loadAdapters(dir?) -> { [name]: module }
 *
 * Dynamically import every `*.mjs` under sync/adapters/ and key each module by its
 * exported `name`. Each adapter module exports: name, dependsOn[], pull(), push().
 * Throws if two adapters declare the same `name` (ambiguous graph) or a module is
 * missing its `name`.
 *
 * @param {string} [dir] override the adapters directory (used by tests)
 * @returns {Promise<Record<string, any>>}
 */
export async function loadAdapters(dir = ADAPTERS_DIR) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
    .map((e) => e.name)
    .sort(); // deterministic import order

  const adapters = {};
  for (const file of files) {
    const mod = await import(pathToFileURL(join(dir, file)).href);
    const name = mod.name ?? mod.default?.name;
    if (!name) {
      throw new Error(`Adapter ${file} does not export a \`name\``);
    }
    if (adapters[name]) {
      throw new Error(`Duplicate adapter name "${name}" (in ${file})`);
    }
    // Normalize to a single object carrying name/dependsOn/pull/push regardless of
    // whether the adapter exported them individually or via `default`.
    const def = mod.default ?? mod;
    adapters[name] = {
      name,
      dependsOn: def.dependsOn ?? mod.dependsOn ?? [],
      pull: def.pull ?? mod.pull,
      push: def.push ?? mod.push,
      module: mod,
    };
  }
  return adapters;
}

/**
 * topoSort(adapters) -> string[]
 *
 * Kahn/DFS topological sort of adapter NAMES by their `dependsOn`. A name appears
 * AFTER every name it depends on. Deterministic: ties are broken alphabetically so a
 * given graph always yields the same order.
 *
 * Throws on:
 *   - an unknown dependency (a `dependsOn` entry with no matching adapter), and
 *   - a dependency cycle (naming the offending nodes).
 *
 * `adapters` is any map of `name -> { dependsOn: string[] }` (the real adapter
 * registry, or a fake one in tests).
 *
 * @param {Record<string, { dependsOn?: string[] }>} adapters
 * @returns {string[]} adapter names in dependency order
 */
export function topoSort(adapters) {
  const names = Object.keys(adapters).sort(); // stable, alphabetical tie-break

  // Validate dependencies up front so the error names the missing dep, not a
  // confusing "cycle" later.
  for (const name of names) {
    for (const dep of adapters[name].dependsOn ?? []) {
      if (!(dep in adapters)) {
        throw new Error(`Adapter "${name}" dependsOn unknown adapter "${dep}"`);
      }
    }
  }

  // Kahn's algorithm: repeatedly emit a node whose deps are all already emitted.
  // Among the currently-ready nodes we pick the alphabetically-first, so roots come
  // out first and the order is fully deterministic (e.g. assets, forms before their
  // consumers). This keeps producers (forms/assets) ahead of consumers and reads
  // naturally in the orchestrator's printed order.
  const remaining = new Set(names);
  const order = [];

  while (remaining.size) {
    const ready = [...remaining]
      .filter((name) => (adapters[name].dependsOn ?? []).every((dep) => !remaining.has(dep)))
      .sort();
    if (ready.length === 0) {
      // Everything left is part of (or blocked by) a cycle. Report the offenders.
      const cycle = describeCycle(adapters, remaining);
      throw new Error(`Dependency cycle detected: ${cycle}`);
    }
    const next = ready[0];
    order.push(next);
    remaining.delete(next);
  }

  return order;
}

// Walk dependency edges among the still-unresolved nodes to surface a concrete cycle
// chain (a -> b -> c -> a) for the error message.
function describeCycle(adapters, remaining) {
  const start = [...remaining].sort()[0];
  const path = [];
  const seen = new Set();
  let node = start;
  while (node != null && !seen.has(node)) {
    seen.add(node);
    path.push(node);
    node = (adapters[node].dependsOn ?? []).find((dep) => remaining.has(dep));
  }
  if (node != null) path.push(node); // close the loop back to a repeated node
  return path.join(' -> ');
}
