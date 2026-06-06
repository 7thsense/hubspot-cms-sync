// sync/adapters/assets.mjs — File Manager image sync for pages + blog.
//
// CODEX FINDING #4 (the contract this adapter exists to enforce):
//   Canonical content committed to git stores REPO ASSET PATHS / logical
//   `@asset:<path>` keys, NEVER hosted URLs. The per-account
//   portal -> hostedURL map is volatile state living in
//   `.sync-state/<portalId>.rehosted.json` (gitignored), NOT committed.
//
// HOW THE @asset KEY IS DEFINED (must agree with sync/lib/refs.mjs):
//   refs.mjs collapses any `…/hubfs/<portal>/<pathTail>` URL into the single
//   token `@asset:<pathTail>` (the portal + host are discarded — they are
//   per-account). That `<pathTail>` (e.g. `Sucess.jpg`,
//   `Stock%20images/Double%20exposure.jpeg`) is at once:
//     • the logical registry key  (registry.assets[<pathTail>])
//     • the repo path under        content/assets/<pathTail>   (bytes committed)
//   We keep the tail BYTE-FOR-BYTE (including any %20) so the on-disk path, the
//   registry key, and the `@asset:` token are the same string and round-trip.
//
// PULL  (read source acct -> write canonical bytes + register source URLs):
//   1. scan canonical content (pages/*.json, pages/*.widgets.json, blog/**)
//      for `@asset:<path>` tokens — these were produced by refs.canonicalize.
//   2. for each path, find a downloadable URL ON THE SOURCE ACCOUNT
//      (File Manager search by name, hubfs reconstruction fallback) and
//      download the bytes to content/assets/<path>  (COMMIT these bytes).
//   3. record source-URL -> @asset in the registry (registry.assets[path] =
//      sourceURL) and mirror it to .sync-state/<portalId>.rehosted.json.
//
// PUSH  (read committed bytes -> upload to target -> register target URLs):
//   for each content/assets/<path>, upload to the TARGET File Manager with
//   OVERWRITE (codex #4: the legacy overwrite:false made duplicates), then
//   record @asset -> target hosted URL in registry.assets[path] so the
//   content / blog / theme adapters can resolve() their `@asset:` tokens to a
//   concrete URL. dependsOn: [] — assets POPULATE the registry, depend on no
//   other adapter.
//
// READ-ONLY PROD (529456): this adapter never hardcodes a portal; the
// orchestrator passes `acct`. push() writes to whatever `acct` it is given;
// the orchestrator is responsible for never passing prod to a push.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, dirname, resolve as pathResolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { hub } from '../lib/hub.mjs';
import { stableStringify } from '../lib/canonical.mjs';

const API = 'https://api.hubapi.com';

export const name = 'assets';
// Assets POPULATE the registry (logical -> hosted url) for everyone else.
// Nothing has to run before assets, so this is empty.
export const dependsOn = [];

// Folder under the target File Manager that re-hosted assets live in. A single
// flat-ish namespace keeps overwrite-by-path deterministic across runs.
const TARGET_FOLDER = '/synced-assets';

// ───────────────────────────────────────────────────────────────────────────
// PURE: path <-> logical mapping. `@asset:<path>` <-> content/assets/<path>.
// Exported for unit testing (no network).
// ───────────────────────────────────────────────────────────────────────────

const ASSET_TOKEN_RE = /@asset:([^\s"'\\)]+)/g;

/**
 * assetTokenToPath('@asset:Sucess.jpg') -> 'Sucess.jpg'
 * Also accepts a bare path tail (idempotent). Returns null for anything that
 * is not an @asset token / path.
 */
export function assetTokenToPath(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const m = token.match(/^@asset:([^\s"'\\)]+)$/);
  if (m) return m[1];
  // already a bare path tail
  if (token.startsWith('@')) return null;
  return token;
}

/** pathToAssetToken('Sucess.jpg') -> '@asset:Sucess.jpg' */
export function pathToAssetToken(path) {
  return `@asset:${path}`;
}

/**
 * assetRepoPath(contentDir, '<pathTail>') -> absolute file path under
 * content/assets/<pathTail>. The tail is kept verbatim (slashes become real
 * sub-directories) so it matches the `@asset:` token and the registry key.
 */
export function assetRepoPath(contentDir, path) {
  return join(contentDir, 'assets', path);
}

// ───────────────────────────────────────────────────────────────────────────
// ASSET-SCHEME UNIFICATION (codex #6).
//
// Two adapters emit `@asset:<key>` tokens with DIFFERENT committed-bytes trees:
//   • the assets adapter: key = the hubfs path tail (e.g. `Sucess.jpg`),
//     bytes committed at  content/assets/<key>.
//   • the blog adapter:   key = a sha1-prefixed manifest filename
//     (e.g. `4e7bf9bad5-Inbox.png`), bytes committed at
//     content/blog/assets/<key>  (blog.rehostAssets uploads these itself).
//
// A blog-manifest `@asset` is therefore a legitimate, satisfiable ref whose
// bytes live OUTSIDE content/assets/. The single source of truth for "where can
// an @asset key's committed bytes live" is `assetRepoCandidates` below; both the
// assets adapter and the push preflight consult it, so the two schemes resolve and
// preflight identically. We RECOGNIZE both trees rather than migrate blog bytes:
// migrating would have to rewrite the manifest keys + blog.pull tokenization + move
// 51 committed files (and re-key registry.assets), all of which the blog adapter
// owns. Recognition is purely additive and keeps each adapter's bytes where it
// already commits them. (See docs note in the unification report.)
//
// The blog tree's name is centralized here so the preflight need not hard-code it.
export const BLOG_ASSETS_REL = ['blog', 'assets'];

/**
 * blogAssetRepoPath(contentDir, '<key>') -> absolute path under
 * content/blog/assets/<key> (the blog adapter's manifest byte tree).
 */
export function blogAssetRepoPath(contentDir, path) {
  return join(contentDir, ...BLOG_ASSETS_REL, path);
}

/**
 * assetRepoCandidates(contentDir, '<key>') -> the ordered list of absolute file
 * paths where an @asset key's committed bytes may live, across BOTH schemes:
 *   1. content/assets/<key>        (assets adapter — hubfs tail)
 *   2. content/blog/assets/<key>   (blog adapter — manifest filename)
 * Pure (no I/O). Callers test each with existsSync.
 */
export function assetRepoCandidates(contentDir, path) {
  return [assetRepoPath(contentDir, path), blogAssetRepoPath(contentDir, path)];
}

/**
 * resolveAssetBytesPath(contentDir, '<key>', existsFn) -> the first candidate
 * path (assets tree, then blog tree) whose bytes are committed, or null if an
 * @asset key has committed bytes in NEITHER tree. `existsFn` defaults to fs
 * existsSync but is injectable so the push preflight can pass its fake fs.
 * This is the one function that unifies the two @asset schemes for "are the
 * bytes here?" — used by both the assets adapter (push) and the preflight.
 */
export function resolveAssetBytesPath(contentDir, path, existsFn = existsSync) {
  for (const cand of assetRepoCandidates(contentDir, path)) {
    if (existsFn(cand)) return cand;
  }
  return null;
}

/**
 * extractAssetPaths(str) -> string[] of unique `<pathTail>`s referenced by
 * `@asset:` tokens in the given canonical string. Pure.
 */
export function extractAssetPaths(str) {
  if (typeof str !== 'string' || str.length === 0) return [];
  const out = new Set();
  for (const m of str.matchAll(ASSET_TOKEN_RE)) out.add(m[1]);
  return [...out];
}

// ───────────────────────────────────────────────────────────────────────────
// PURE: File Manager upload options. The codex #4 fix lives here — OVERWRITE.
// Exported so a unit test can assert overwrite:true without any network.
// ───────────────────────────────────────────────────────────────────────────

/**
 * uploadOptions(path) -> the `options` object posted to /files/v3/files.
 * overwrite:true (codex #4 — the legacy overwrite:false created a new
 * duplicate file every push, so pull->push->pull never converged). Public so
 * pages/blog can hotlink the result; EXACT_FOLDER scope so overwrite targets
 * the same path deterministically.
 */
export function uploadOptions() {
  return {
    access: 'PUBLIC_INDEXABLE',
    overwrite: true,
    duplicateValidationStrategy: 'NONE',
    duplicateValidationScope: 'EXACT_FOLDER',
  };
}

// fileName + folderPath the upload should target for a given asset path tail.
// A nested tail like `Stock%20images/Double%20exposure.jpeg` becomes
// folderPath=`/synced-assets/Stock%20images`, fileName=`Double%20exposure.jpeg`
// so overwrite-by-path stays stable.
export function uploadTarget(path) {
  // DECODE each segment for File Manager: the @asset key keeps URL-encoding
  // (`%20`) so the token/registry/on-disk path all match, but File Manager
  // REJECTS `%` (and #?&;*^!$|) in folder/file names — so a nested key like
  // `Google%20Drive%20Integration/x.jpg` must upload to folder
  // `Google Drive Integration`. The hosted URL re-encodes the space, so resolve()
  // still maps the encoded @asset token to the served URL.
  const dec = (s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const segs = String(path).split('/').map(dec);
  const fileName = segs.pop();
  const sub = segs.join('/');
  const folderPath = sub ? `${TARGET_FOLDER}/${sub}` : TARGET_FOLDER;
  return { fileName, folderPath };
}

// ───────────────────────────────────────────────────────────────────────────
// .sync-state/<portalId>.rehosted.json — per-account, gitignored URL cache.
// Maps `<pathTail> -> hostedURL` for THIS account (source URLs after pull,
// target URLs after push). NOT committed.
// ───────────────────────────────────────────────────────────────────────────

function syncStateDir() {
  const here = dirname(fileURLToPath(import.meta.url)); // sync/adapters
  return pathResolve(here, '..', '..', '.sync-state');
}

function rehostedPath(portalId) {
  return join(syncStateDir(), `${portalId}.rehosted.json`);
}

export function loadRehosted(portalId) {
  const f = rehostedPath(portalId);
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return {};
  }
}

export function saveRehosted(portalId, map) {
  const dir = syncStateDir();
  mkdirSync(dir, { recursive: true });
  // Atomic write: serialize to a per-pid temp file then rename into place. A
  // direct writeFileSync can be observed (or interrupted) mid-write — a crash or
  // a concurrent reader between truncate and the final bytes would see a
  // half-written / empty `{}` cache, which on the NEXT push silently means
  // "nothing is rehosted" and re-uploads all 207 assets (the idempotency bug this
  // adapter exists to prevent). rename(2) is atomic on the same filesystem, so the
  // live cache file is always either the previous complete version or the new
  // complete version — never an empty/truncated one.
  const final = rehostedPath(portalId);
  const tmp = `${final}.tmp-${process.pid}`;
  writeFileSync(tmp, stableStringify(map));
  renameSync(tmp, final);
}

// ───────────────────────────────────────────────────────────────────────────
// Scan the committed canonical tree for `@asset:` references.
// Sources: content/pages/*.json (+ *.widgets.json), content/blog/** *.json.
// theme/templates are ALSO @asset carriers, but the assets they reference are
// likewise tokenized; reading every *.json under contentDir covers pages+blog,
// and the optional `extraDirs` lets the orchestrator widen the scan.
// ───────────────────────────────────────────────────────────────────────────

function walkJson(dir, acc) {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) walkJson(full, acc);
    else if (ent.isFile() && ent.name.endsWith('.json')) acc.push(full);
  }
  return acc;
}

/**
 * collectReferencedAssetPaths(contentDir) -> string[] unique `<pathTail>`s
 * referenced anywhere in the canonical content tree (pages + blog).
 */
export function collectReferencedAssetPaths(contentDir) {
  const files = [];
  walkJson(join(contentDir, 'pages'), files);
  walkJson(join(contentDir, 'landing-pages'), files);
  walkJson(join(contentDir, 'blog'), files);
  const paths = new Set();
  for (const f of files) {
    // skip our own state/manifest files if they ever live under content/
    let text;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const p of extractAssetPaths(text)) paths.add(p);
  }
  return [...paths];
}

// ───────────────────────────────────────────────────────────────────────────
// Source-URL resolution (PULL). Given a path tail, find a URL on the SOURCE
// account we can actually download. Order:
//   1. an existing .sync-state rehosted entry (already known this account),
//   2. File Manager search by file name (recovers dead legacy CDN URLs — the
//      blog-sync.mjs fileManagerUrl trick),
//   3. reconstruct the canonical hubfs URL from the account's portal id.
// ───────────────────────────────────────────────────────────────────────────

async function fileManagerUrl(acct, path) {
  // search by the bare file-name stem (matches blog-sync.mjs behaviour)
  const name = decodeURIComponent(path.split('/').pop());
  const stem = name.replace(/\.[^.]+$/, '');
  const { ok, json } = await hub(
    acct,
    'GET',
    `/files/v3/files/search?name=${encodeURIComponent(stem)}&limit=5`,
  );
  if (!ok) return null;
  const results = json.results || [];
  const hit =
    results.find((f) => `${f.name}.${f.extension}`.toLowerCase() === name.toLowerCase()) ||
    results[0];
  return hit?.url || null;
}

function reconstructHubfsUrl(portalId, path) {
  // canonical legacy host; recovery via File Manager handles the dead ones.
  return `https://cdn2.hubspot.net/hubfs/${portalId}/${path}`;
}

async function downloadBytes(url) {
  const res = await fetch(encodeURI(url));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ───────────────────────────────────────────────────────────────────────────
// Target upload (PUSH). Uploads bytes with OVERWRITE; returns the hosted URL.
// Network-injectable `doFetch` for unit testing the option payload.
// ───────────────────────────────────────────────────────────────────────────

export async function uploadAsset(acct, buf, path, doFetch = fetch) {
  const { fileName, folderPath } = uploadTarget(path);
  // Retry on transient throttling (429) / server errors (5xx). A bulk push of
  // ~200 files reliably trips the Files API rate limit; without backoff a single
  // transient 429 fails the whole push (assets hard-fails on failed>0). FormData
  // is single-use, so rebuild it each attempt.
  let res;
  for (let attempt = 0; attempt < 5; attempt++) {
    const form = new FormData();
    form.append('file', new Blob([buf]), fileName);
    form.append('fileName', fileName);
    form.append('folderPath', folderPath);
    form.append('options', JSON.stringify(uploadOptions()));
    res = await doFetch(`${API}/files/v3/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${acct.key}` },
      body: form,
    });
    if (res.ok) {
      const j = await res.json();
      return j.url || j.objects?.[0]?.url || null;
    }
    if (res.status !== 429 && res.status < 500) break; // non-retryable client error
    await new Promise((r) => setTimeout(r, 600 * 2 ** attempt)); // 0.6s,1.2s,2.4s,4.8s
  }
  const j = await res.json().catch(() => ({}));
  throw new Error(`upload ${fileName} -> ${res.status}: ${j.message || ''}`);
}

// ───────────────────────────────────────────────────────────────────────────
// pull(acct, { contentDir, registry }) -> { pulled, notes }
// ───────────────────────────────────────────────────────────────────────────

export async function pull(acct, { contentDir, registry }) {
  const notes = [];
  const paths = collectReferencedAssetPaths(contentDir);
  const rehosted = loadRehosted(acct.portalId);
  let downloaded = 0;
  let reused = 0;
  let failed = 0;

  for (const path of paths) {
    // New downloads land in the unified content/assets/<path> tree; but bytes may
    // already be committed in EITHER tree (the blog adapter commits its manifest
    // assets under content/blog/assets/<path>), so an existing blog-manifest asset
    // counts as already-committed and is never re-downloaded. (codex #6.)
    const repoFile = assetRepoPath(contentDir, path);
    const committedFile = resolveAssetBytesPath(contentDir, path);

    // Resolve a downloadable source URL for this account.
    let sourceUrl = rehosted[path] || null;
    if (!sourceUrl) {
      try {
        sourceUrl = await fileManagerUrl(acct, path);
      } catch {
        sourceUrl = null;
      }
    }
    if (!sourceUrl) sourceUrl = reconstructHubfsUrl(acct.portalId, path);

    // Already have the bytes committed (in either tree) -> just (re)register the
    // source URL; never re-download.
    if (committedFile) {
      reused++;
    } else {
      let buf = null;
      try {
        buf = await downloadBytes(sourceUrl);
      } catch {
        // last-ditch File Manager recovery for a dead reconstructed URL
        try {
          const alt = await fileManagerUrl(acct, path);
          if (alt && alt !== sourceUrl) {
            buf = await downloadBytes(alt);
            sourceUrl = alt;
          }
        } catch {
          /* fall through to failure */
        }
      }
      if (!buf) {
        failed++;
        notes.push(`download failed: @asset:${path}`);
        continue;
      }
      mkdirSync(dirname(repoFile), { recursive: true });
      writeFileSync(repoFile, buf);
      downloaded++;
    }

    // Record source URL -> @asset for this account (registry + state cache).
    registry.assets[path] = sourceUrl;
    rehosted[path] = sourceUrl;
  }

  saveRehosted(acct.portalId, rehosted);
  notes.unshift(
    `assets pull: ${paths.length} referenced | downloaded ${downloaded} | reused ${reused} | failed ${failed}`,
  );
  return { pulled: downloaded, notes };
}

// ───────────────────────────────────────────────────────────────────────────
// push(acct, { contentDir, registry }) -> { pushed, notes }
// ───────────────────────────────────────────────────────────────────────────

export async function push(acct, { contentDir, registry }) {
  const notes = [];
  const assetsDir = join(contentDir, 'assets');
  // Union of referenced paths and bytes-on-disk: upload anything we have a file
  // for, so content/blog/theme can resolve every @asset they reference.
  const referenced = new Set(collectReferencedAssetPaths(contentDir));
  const onDisk = new Set(listAssetFiles(assetsDir));
  const paths = [...new Set([...referenced, ...onDisk])];

  // The rehosted cache (.sync-state/<portal>.rehosted.json) is the per-account
  // path -> hosted-URL map. It is the primary reuse source, but it is gitignored
  // volatile state that can be lost, truncated, or never written. The per-account
  // REGISTRY (registry.assets[path]) is the SAME mapping and is persisted by the
  // orchestrator ATOMICALLY after every adapter — so it is the durable backstop.
  // Seed the rehosted map from any target hosted URLs already in the registry so a
  // missing/empty cache still yields REUSE (uploaded 0 | reused N) on a re-push
  // instead of silently re-uploading all 207 assets. We only seed concrete http(s)
  // URLs (a registry entry can also be `true` "known-but-url-built-by-caller",
  // which is not a reusable hosted URL).
  const rehosted = loadRehosted(acct.portalId);
  for (const [k, v] of Object.entries(registry.assets || {})) {
    if (rehosted[k] == null && typeof v === 'string' && /^https?:\/\//.test(v)) {
      rehosted[k] = v;
    }
  }
  let uploaded = 0;
  let reused = 0;
  let missing = 0;
  let failed = 0;
  // Referenced @asset tokens whose bytes are NOT committed. These are fatal:
  // pushing past them would leave the content/blog/theme resolve() either
  // hard-failing later (confusing) or — if a stale rehosted entry exists from a
  // prior run — silently resolving to a DRIFTED url. We collect every one so the
  // abort error names them all, then throw after the loop (data-loss guard).
  const missingReferenced = [];

  for (const path of paths) {
    // Bytes may live in EITHER scheme's tree: content/assets/<path> (this
    // adapter) or content/blog/assets/<path> (the blog manifest). We upload from
    // wherever they are committed so a blog-manifest @asset referenced by a page
    // (or vice-versa) resolves. (codex #6 unification.) The blog adapter ALSO
    // rehosts its manifest assets, but overwrite-by-path makes a double upload
    // idempotent, and finding bytes here keeps the assets-adapter scan from
    // hard-failing on a blog-only @asset.
    const repoFile = resolveAssetBytesPath(contentDir, path);
    if (!repoFile) {
      // referenced but bytes not committed in either tree — record so push can
      // hard-fail below.
      missing++;
      notes.push(`missing bytes for @asset:${path} (run pull)`);
      if (referenced.has(path)) missingReferenced.push(path);
      continue;
    }
    // Already hosted on THIS account (cached from a prior pull/push) — reuse the
    // URL instead of re-uploading. Re-uploading every referenced asset on each
    // push is wasteful and trips the Files API rate limit on bulk runs; the
    // bytes are byte-stable, so the cached URL is correct. (Set $ASSET_FORCE=1
    // to force a re-upload.)
    if (rehosted[path] && !process.env.ASSET_FORCE) {
      registry.assets[path] = rehosted[path];
      reused++;
      continue;
    }
    let buf;
    try {
      buf = readFileSync(repoFile);
    } catch (e) {
      failed++;
      notes.push(`read failed @asset:${path}: ${e.message}`);
      continue;
    }
    let url;
    try {
      url = await uploadAsset(acct, buf, path);
    } catch (e) {
      failed++;
      notes.push(`upload failed @asset:${path}: ${e.message}`);
      continue;
    }
    // @asset -> target hosted URL, so resolve() in content/blog/theme works.
    registry.assets[path] = url;
    rehosted[path] = url;
    uploaded++;
  }

  // Persist any URLs we DID resolve this run before aborting, so a re-run after
  // the missing bytes are committed reuses them and stays idempotent.
  saveRehosted(acct.portalId, rehosted);
  notes.unshift(
    `assets push: ${paths.length} asset(s) | uploaded ${uploaded} | reused ${reused} | missing-bytes ${missing} | failed ${failed}`,
  );

  // DATA-LOSS GUARD: a referenced @asset with no committed bytes aborts the
  // whole push (the orchestrator's contract — throw to stop before a consumer
  // resolves a missing/stale ref). Names every offender so the operator can
  // `pull` once and re-push.
  if (missingReferenced.length > 0) {
    throw new Error(
      `assets push: ${missingReferenced.length} referenced @asset(s) missing committed bytes — run \`pull\` first: ` +
        missingReferenced.map((p) => `@asset:${p}`).join(', '),
    );
  }
  // An upload that actually failed (network/API) is likewise fatal — don't let a
  // consumer resolve a token we never uploaded.
  if (failed > 0) {
    throw new Error(`assets push: ${failed} asset upload(s) failed — see notes`);
  }

  return { pushed: uploaded, notes };
}

// List every committed asset's path tail (relative to content/assets), with
// '/' separators, so it matches the `@asset:<tail>` / registry key form.
export function listAssetFiles(assetsDir) {
  if (!existsSync(assetsDir)) return [];
  const out = [];
  const walk = (dir, prefix) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'manifest.json') continue; // legacy sidecar, not an asset
      const full = join(dir, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(full, rel);
      else if (ent.isFile() && statSync(full).size >= 0) out.push(rel);
    }
  };
  walk(assetsDir, '');
  return out;
}

export default { name, dependsOn, pull, push };
