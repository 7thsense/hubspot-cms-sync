// sync/lib/sync-state.mjs — per-account registry persistence + content tree root.
//
// The Registry (refs.mjs) is PER ACCOUNT and lives in the GITIGNORED .sync-state/
// directory at the repo root, one file per portal:
//
//   .sync-state/<portalId>.registry.json
//
// It holds the logical-key <-> per-account-id mapping (forms/ctas/menus/emails ids,
// asset paths, the portal id) that PULL auto-registers and PUSH resolves. It is never
// committed (see .gitignore `.sync-state/`), because it is account-specific identity,
// not portable canonical content.
//
// This module owns the load/init + save of that file (composing refs.emptyRegistry /
// loadRegistry / saveRegistry with canonical.stableStringify for diff-stable bytes)
// and exposes the canonical content/ tree root the adapters write into.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import { emptyRegistry, loadRegistry, saveRegistry } from './refs.mjs';
import { stableStringify } from './canonical.mjs';
import { loadConfigSyncFallback } from '../config.mjs';

function fallbackConfig() {
  return loadConfigSyncFallback();
}

/** Repo-root canonical content tree (content/...). */
export function contentDir(cfg = fallbackConfig()) {
  return cfg.contentDirPath || join(cfg.root || process.cwd(), cfg.contentDir || 'content');
}

/** Gitignored per-account state directory (.sync-state/). */
export function syncStateDir(cfg = fallbackConfig()) {
  return cfg.syncStateDirPath || join(cfg.root || process.cwd(), cfg.syncStateDir || '.sync-state');
}

/** Path to a portal's registry file. */
export function registryPath(portalId, cfg = fallbackConfig()) {
  return join(syncStateDir(cfg), `${String(portalId)}.registry.json`);
}

/**
 * loadAccountRegistry(portalId) -> Registry
 *
 * Load .sync-state/<portalId>.registry.json if present, else initialize an empty
 * registry seeded with this account's portalId (so @portal resolves even on a first
 * push). Always returns a registry whose `portalId` is set to the given portal.
 */
export function loadAccountRegistry(portalId, cfg = fallbackConfig()) {
  const pid = String(portalId);
  const file = registryPath(pid, cfg);
  let reg;
  if (existsSync(file)) {
    try {
      reg = loadRegistry(JSON.parse(readFileSync(file, 'utf8')));
    } catch (e) {
      throw new Error(`Corrupt registry ${file}: ${e.message}`);
    }
  } else {
    reg = emptyRegistry(pid);
  }
  // The registry MUST carry this account's portal id (it may be absent in an
  // older/empty file). Force it to the account we're operating on.
  reg.portalId = pid;
  return reg;
}

/**
 * persistAccountRegistry(portalId, registry) -> void
 *
 * Serialize the registry to .sync-state/<portalId>.registry.json (creating the
 * gitignored dir as needed), via saveRegistry (drops memoized reverse indexes) +
 * stableStringify (sorted keys, trailing newline) for a stable file.
 */
export function persistAccountRegistry(portalId, registry, cfg = fallbackConfig()) {
  const dir = syncStateDir(cfg);
  mkdirSync(dir, { recursive: true });
  // Write to a temp file then atomically rename, so a crash mid-write can never
  // leave a half-written (corrupt) registry — the live file is always either the
  // old complete version or the new complete version.
  const final = registryPath(portalId, cfg);
  const tmp = `${final}.tmp-${process.pid}`;
  writeFileSync(tmp, stableStringify(saveRegistry(registry)));
  renameSync(tmp, final);
}
