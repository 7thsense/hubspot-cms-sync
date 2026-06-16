// publish-snapshot — change-aware publishing state.
//
// The blog push used to re-publish EVERY post on every run via a schedule→publish→
// restore-date dance, which transiently flipped all blog dates to "today" and risked
// permanent churn if interrupted. With this snapshot the adapter can:
//
//   1. SKIP-UNCHANGED — skip a post whose SOURCE is unchanged since the last push AND
//      whose LIVE remote still matches what we pushed. No PATCH, no publish, no dance.
//   2. DRIFT — notice when the LIVE remote changed out from under us (a HubSpot UI edit:
//      remoteFp differs while sourceFp matches) and surface it instead of clobbering.
//
// The snapshot is COMMITTED (.sync-state/<portal>.sync.json) so CI — a fresh checkout
// each run — can skip unchanged items. It holds only content hashes + ids (no secrets),
// like the already-committed <portal>.registry.json.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const EMPTY = () => ({ version: 1, posts: {}, pages: {} });

export function snapshotPath(root, portalId) {
  return join(root || process.cwd(), '.sync-state', `${String(portalId)}.sync.json`);
}

/** Load the committed snapshot for a portal (empty shape if absent/corrupt). */
export function loadPublishSnapshot(root, portalId) {
  const p = snapshotPath(root, portalId);
  if (!existsSync(p)) return EMPTY();
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return { version: 1, posts: j.posts || {}, pages: j.pages || {} };
  } catch {
    return EMPTY();
  }
}

/** Persist the snapshot atomically with stable key order (reviewable diffs). */
export function savePublishSnapshot(root, portalId, snap) {
  const p = snapshotPath(root, portalId);
  mkdirSync(dirname(p), { recursive: true });
  const ordered = { version: 1, posts: sortKeys(snap.posts || {}), pages: sortKeys(snap.pages || {}) };
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(ordered, null, 2)}\n`);
  renameSync(tmp, p);
  return p;
}

function sortKeys(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

/** Short, stable content hash (order-insensitive for object keys). */
export function fingerprint(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 24);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// classifyChange(stored, sourceFp, remoteFp, {remotePresent}) -> action
//   'create'    — not present remotely (must create + publish)
//   'unchanged' — source matches last push AND remote still matches -> SKIP
//   'update'    — our source changed since last push -> re-push
//   'drift'     — source unchanged but remote changed (UI edit) -> notify, don't clobber
export function classifyChange(stored, sourceFp, remoteFp, { remotePresent = true } = {}) {
  if (!remotePresent) return 'create';
  if (!stored) return 'update';
  if (stored.sourceFp !== sourceFp) return 'update';
  if (stored.remoteFp !== remoteFp) return 'drift';
  return 'unchanged';
}
