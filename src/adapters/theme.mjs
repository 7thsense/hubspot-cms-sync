// sync/adapters/theme.mjs — theme code adapter (HubSpot CMS "seventh-sense-theme").
//
// The theme is the repo-root tree: templates/ modules/*.module/ css/ js/ images/
// plus theme.json and the root fields.json. Those files ALREADY live in git and ARE
// the canonical store — this adapter reconciles + canonicalizes them on pull and
// builds a target-specific copy on push. Identity is theme-name + path (never a
// per-account id), so nothing committed keys off a portal.
//
// Transport is the CMS Source Code REST API only — NO `hs` CLI. pull() walks the theme
// via the metadata endpoint and downloads each file's content; push() PUTs each built
// file. (The old `hs cms fetch`/`hs cms upload` calls were unreliable: the whole-tree
// upload silently no-op'd and mis-named the theme after the build dir.)
//
// PULL (codex canonicalization):
//   GET /cms/v3/source-code/published/metadata|content/seventh-sense-theme/<path>
//   (recursive walk, downloaded straight into the git paths — no staging dir), then
//   for every fetched file:
//     - meta.json: STRIP `module_id` (codex #1 diff-noise: a per-portal id),
//       migrate `host_template_types` -> `content_types`, re-serialize with
//       canon.stableStringify (sorted keys).
//     - fields.json / theme.json: re-serialize with stableStringify.
//     - any text file: normalize to LF, strip BOM.
//     - portability: run refs.canonicalize over files that embed per-account refs
//       (js/hs-forms.js hardcodes the portal id; module fields/html carry form_id
//       GUIDs) so the committed bytes hold @portal / @form:<key> tokens, never the
//       source portal/GUID. Newly-seen ids are registered into the registry.
//   Reconciled bytes are written back into the git theme paths.
//
// PUSH (codex #2 — build target tree, THEN upload):
//   Copy the theme into a TEMP BUILD tree, then refs.resolve every logical-ized file
//   against the TARGET account's registry — injecting the target portal id into
//   js/hs-forms.js and the target form GUIDs into module form_id fields — BEFORE
//   uploading. `refs.resolve` HARD-FAILS if any @form/@portal token has no target
//   mapping, so we never upload JS that still carries the source portal. Then PUT each
//   built file to PUT /cms/v3/source-code/published/content/seventh-sense-theme/<path>.
//   The orchestrator passes `acct`; we never hardcode a portal, so prod (529456) is
//   never a target
//   unless the orchestrator explicitly selects it (and it is read-only by policy).
//
// I/O lives in pull()/push(); the canonicalization and build-tree GUID injection are
// factored into the pure helpers canonicalizeMeta / canonicalizeThemeText /
// injectRefsIntoTree, which are exported for unit testing without a HubSpot account.

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join, dirname, relative, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';

import { stableStringify } from '../lib/canonical.mjs';
import { canonicalize as canonicalizeRefs, resolve as resolveRefs } from '../lib/refs.mjs';

export const name = 'theme';

// Theme push consumes form GUIDs (and the portal id) that the forms adapter
// populates into the registry on its push. No other adapter must run first.
export const dependsOn = ['forms'];

export const THEME_NAME = 'seventh-sense-theme';

// repo root = sync/adapters/theme.mjs -> ../../
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

// The theme tree, relative to whatever root we operate on (repo root on pull-write,
// a temp build dir on push). Directories are walked recursively; loose files copied
// as-is. images/ is binary and copied verbatim — never text-normalized.
const THEME_DIRS = ['templates', 'email-templates', 'modules', 'email-modules', 'css', 'js', 'images'];
const THEME_FILES = ['theme.json', 'fields.json'];

/**
 * isThemePath(relPath) -> boolean (codex #12 — scoped upload guard).
 *
 * Single source of truth for "does this repo-relative path belong in the theme upload?".
 * A path qualifies iff its FIRST segment is one of THEME_DIRS, or the whole path is one
 * of THEME_FILES. Everything else at the repo root — docs/ sync/ content/ node_modules/
 * test/ .sync-state/ .git/ package.json README.md … — is explicitly EXCLUDED so the
 * Design Manager theme never receives non-theme bytes. `listThemeFiles` only walks the
 * theme roots, so this is a belt-and-suspenders guard, but exporting it makes the scope
 * assertable and keeps the inclusion rule in exactly one place.
 */
export function isThemePath(relPath) {
  const p = String(relPath).split(sep).join('/').replace(/^\.\//, '');
  if (p === '' || p.startsWith('../')) return false; // never escape the theme root
  if (THEME_FILES.includes(p)) return true;
  const first = p.split('/')[0];
  return THEME_DIRS.includes(first);
}

// Files that may embed per-account references (portal id / form GUIDs) and therefore
// must round-trip through refs.canonicalize (pull) / refs.resolve (push). We match by
// path suffix so it is independent of the operating root.
const REF_BEARING = (relPath) => {
  const p = relPath.split(sep).join('/');
  return (
    p === 'js/hs-forms.js' ||
    p.endsWith('.module/fields.json') ||
    p.endsWith('.module/module.html') ||
    // Page templates (incl. shared partials) may carry @asset refs to content
    // assets (e.g. og:image, founder/product photos). Resolve them to the
    // target's hosted URL on push, same as module.html — keeps content images
    // (webp included, which the theme source rejects) out of the theme tree.
    ((p.startsWith('templates/') || p.startsWith('email-templates/')) && p.endsWith('.html'))
  );
};

// HubSpot's `hs cms fetch` ALWAYS emits a `module.css` and `module.js` for every
// `*.module/`, even when the module defines neither — they come down as empty (or
// whitespace-only) files. Committing those would add a churning empty file to git for
// every module on the first pull (and re-upload them on push). We therefore IGNORE an
// auto-created empty module.css/module.js on pull *unless that file already exists in
// the tree* (i.e. someone authored real CSS/JS for the module — then we round-trip it).
// Matched by path suffix so it is independent of the operating root.
const isModuleAsset = (relPath) => {
  const p = relPath.split(sep).join('/');
  return p.endsWith('.module/module.css') || p.endsWith('.module/module.js');
};
// Empty == nothing but whitespace once BOM/CRLF are normalized away.
const isBlank = (s) => normalizeText(s).trim() === '';

// Text vs binary: only these extensions are text-normalized / ref-processed. Anything
// under images/ (or any other extension) is treated as opaque bytes.
const TEXT_EXT = new Set(['.html', '.css', '.js', '.json', '.txt', '.csv', '.svg']);
const extOf = (p) => {
  const i = p.lastIndexOf('.');
  return i < 0 ? '' : p.slice(i).toLowerCase();
};
const isText = (relPath) => TEXT_EXT.has(extOf(relPath));

// ---------------------------------------------------------------------------
// PURE canonicalization helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Strip BOM, normalize CRLF/CR -> LF. Pure string transform. */
export function normalizeText(s) {
  let t = String(s);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1); // strip leading BOM
  return t.replace(/\r\n?/g, '\n');
}

/**
 * canonicalizeMeta(rawMetaText | obj) -> stable meta.json TEXT.
 *
 * The two codex-mandated migrations for module meta.json:
 *   - DELETE `module_id` (a per-portal id — the #1 source of diff noise; every pull
 *     from a different account would otherwise rewrite it).
 *   - MIGRATE `host_template_types` -> `content_types` (never keep both). If the file
 *     already uses `content_types`, leave it; if both are present, the legacy key is
 *     dropped in favour of the already-migrated value.
 * Then re-serialize with stableStringify (sorted keys, 2-space, LF, trailing NL).
 */
export function canonicalizeMeta(input) {
  const meta = typeof input === 'string' ? JSON.parse(normalizeText(input)) : { ...input };

  // Strip the per-portal id.
  delete meta.module_id;

  // Migrate host_template_types -> content_types (prefer an already-migrated value).
  if ('host_template_types' in meta) {
    if (!('content_types' in meta)) {
      meta.content_types = meta.host_template_types;
    }
    delete meta.host_template_types;
  }

  return stableStringify(meta);
}

/**
 * canonicalizeJsonText(rawText) -> stable JSON text.
 * For fields.json / theme.json: parse, re-serialize with stableStringify. Field UUIDs
 * and every other value are preserved verbatim; only key order + formatting change.
 */
export function canonicalizeJsonText(rawText) {
  return stableStringify(JSON.parse(normalizeText(rawText)));
}

/**
 * canonicalizeThemeText(relPath, rawText, registry) -> canonical TEXT.
 *
 * The single pull-time text pipeline:
 *   1. normalize to LF / strip BOM
 *   2. shape-canonicalize JSON (meta.json migrations; fields/theme re-serialize)
 *   3. portability: for ref-bearing files, logical-ize per-account refs
 *      (portal id -> @portal, form GUIDs -> @form:<key>) via refs.canonicalize,
 *      registering any newly-seen ids into `registry`.
 * Non-JSON, non-ref-bearing text (template HubL, css, main.js) is returned LF-clean.
 */
export function canonicalizeThemeText(relPath, rawText, registry) {
  const p = relPath.split(sep).join('/');
  let text = normalizeText(rawText);

  if (p.endsWith('.module/meta.json')) {
    // meta.json: migrate, but it carries no portal/form refs, so no ref pass.
    return canonicalizeMeta(text);
  }

  if (REF_BEARING(p)) {
    // module fields.json is still JSON: shape-canonicalize first, then logical-ize the
    // embedded form_id GUID. js/hs-forms.js and module.html are plain text: just
    // logical-ize the portal id / GUIDs in place.
    if (p.endsWith('.json')) text = canonicalizeJsonText(text);
    if (registry) text = canonicalizeRefs(text, registry);
    return text;
  }

  if (p === 'theme.json' || p.endsWith('/fields.json') || p === 'fields.json') {
    return canonicalizeJsonText(text);
  }

  return text;
}

/**
 * injectRefsIntoTree(files, registry) -> [{ relPath, text }]
 *
 * PUSH build step (pure): given the theme's ref-bearing text files as
 * { relPath, text } (text already LF-clean and holding @portal / @form tokens),
 * resolve each against the TARGET `registry`, returning the injected text. THROWS via
 * refs.resolve if any logical token has no target mapping — so the caller never writes
 * a build tree that still carries the source portal/GUID. Files without logical tokens
 * pass through unchanged.
 */
export function injectRefsIntoTree(files, registry) {
  return files.map(({ relPath, text }) => ({
    relPath,
    text: REF_BEARING(relPath) ? resolveRefs(text, registry) : text,
  }));
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

// Recursively list files under `root` for the theme tree. Returns relPaths (POSIX-ish
// via the OS sep) relative to `root`.
//
// Scope (codex #12): we ONLY descend THEME_DIRS and ONLY add THEME_FILES, so non-theme
// roots (docs/ sync/ content/ node_modules/ test/ .sync-state/ …) are never visited.
// Every emitted path is additionally run through isThemePath() as a defensive guard, so
// the build tree provably contains only theme files even if the walk ever regressed.
async function listThemeFiles(root) {
  const out = [];
  async function walk(absDir) {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return; // missing optional dir (e.g. images/) — skip
    }
    for (const e of entries) {
      const abs = join(absDir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) {
        const rel = relative(root, abs);
        if (isThemePath(rel)) out.push(rel); // belt-and-suspenders: never emit a non-theme path
      }
    }
  }
  for (const d of THEME_DIRS) await walk(join(root, d));
  for (const f of THEME_FILES) if (existsSync(join(root, f))) out.push(f);
  return out;
}

const HUB_API = 'https://api.hubapi.com';

/**
 * PUT one built file to the target account via the CMS Source Code API
 * (create-or-replace by path). Used instead of `hs cms upload`, whose whole-tree
 * form silently no-ops / mis-names the theme after the build dir, and whose per-dir
 * form is flaky. The API PUT is deterministic and idempotent. `relPath` is an
 * OS-path relative to the build root; the remote path always uses forward slashes.
 */
async function uploadSourceFile(acct, themeName, relPath, absPath, { tries = 4 } = {}) {
  const remote = relPath.split(sep).join('/');
  const buf = await fs.readFile(absPath);
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const fd = new FormData();
      fd.append('file', new Blob([buf]), basename(remote));
      const res = await fetch(
        `${HUB_API}/cms/v3/source-code/published/content/${themeName}/${remote}`,
        { method: 'PUT', headers: { Authorization: `Bearer ${acct.key}` }, body: fd },
      );
      if (res.ok) return;
      // 429/5xx are transient — back off and retry; 4xx (except 429) are fatal.
      const body = await res.text().catch(() => '');
      if (res.status !== 429 && res.status < 500) {
        throw new Error(`source-code PUT ${remote} -> ${res.status} ${body.slice(0, 200)}`);
      }
      lastErr = new Error(`source-code PUT ${remote} -> ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < tries) await new Promise((r) => setTimeout(r, 400 * attempt));
  }
  throw lastErr;
}

/**
 * GET one Source Code API path with retry on 429/5xx. Returns the Response (callers
 * handle 404 — a theme dir we ask for may simply not exist). Mirrors the upload helper.
 */
async function sourceGet(acct, kind, path, { tries = 4 } = {}) {
  const url = `${HUB_API}/cms/v3/source-code/published/${kind}/${path}`;
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${acct.key}` } });
      if (res.ok || res.status === 404) return res;
      if (res.status !== 429 && res.status < 500) {
        const b = await res.text().catch(() => '');
        throw new Error(`source-code GET ${kind}/${path} -> ${res.status} ${b.slice(0, 200)}`);
      }
      lastErr = new Error(`source-code GET ${kind}/${path} -> ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < tries) await new Promise((r) => setTimeout(r, 400 * attempt));
  }
  throw lastErr;
}

// Bounded-concurrency runner so the recursive tree walk doesn't fan out into hundreds
// of simultaneous requests (which would trip rate limits).
function makeLimiter(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < max && queue.length) {
      active++;
      const { fn, resolve, reject } = queue.shift();
      fn().then(resolve, reject).finally(() => {
        active--;
        pump();
      });
    }
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}

/**
 * Recursively download a theme subtree (the given top-level entries) from the CMS
 * Source Code API, invoking `onFile(relPath, Buffer)` for each file. Folders are
 * discovered via the metadata endpoint (`folder` + `children` names); missing entries
 * (404) are skipped. No staging dir — callers reconcile each file straight to git.
 */
async function downloadThemeTree(acct, themeName, entries, onFile) {
  const limit = makeLimiter(8);
  async function walk(relPath) {
    const metaRes = await limit(() => sourceGet(acct, 'metadata', `${themeName}/${relPath}`));
    if (metaRes.status === 404) return;
    const meta = await metaRes.json();
    if (meta.folder) {
      await Promise.all((meta.children || []).map((child) => walk(`${relPath}/${child}`)));
      return;
    }
    const res = await limit(() => sourceGet(acct, 'content', `${themeName}/${relPath}`));
    if (res.status === 404) return;
    await onFile(relPath, Buffer.from(await res.arrayBuffer()));
  }
  await Promise.all(entries.map((entry) => walk(entry)));
}

// ---------------------------------------------------------------------------
// pull
// ---------------------------------------------------------------------------

/**
 * pull(acct, { contentDir, registry }) -> { pulled, notes }
 *
 * `contentDir` is the operating root for theme files. The theme tree lives at the REPO
 * root (templates/ modules/ css/ js/ ...), so by default we write there; tests pass an
 * explicit contentDir to redirect writes. Source portal is acct.portalId; nothing is
 * written back (read-only). Files are downloaded directly via the CMS Source Code API
 * and reconciled straight into the git paths — NO intermediate staging dir (the old
 * `hs cms fetch` needed one because it wrote a whole tree at once).
 */
export async function pull(acct, { contentDir, registry, config } = {}) {
  const root = config?.root || contentDir || REPO_ROOT;
  const themeName = config?.theme?.name || THEME_NAME;
  const notes = [];
  let pulled = 0;
  let skippedEmptyModuleAssets = 0;

  // Download + canonicalize each theme file in place. Only the theme roots are walked
  // (templates/ modules/ css/ js/ images/ + theme.json/fields.json), matching what the
  // git tree tracks.
  await downloadThemeTree(acct, themeName, [...THEME_DIRS, ...THEME_FILES], async (relPath, buf) => {
    const dst = join(root, relPath.split('/').join(sep));

    // HubSpot auto-creates empty module.css/module.js. If the module never had one in
    // git, don't create churn by committing an empty file; only round-trip it when it
    // already exists (real authored CSS/JS) — see isModuleAsset note above.
    if (isModuleAsset(relPath) && !existsSync(dst) && isBlank(buf.toString('utf8'))) {
      skippedEmptyModuleAssets++;
      return;
    }

    await fs.mkdir(dirname(dst), { recursive: true });
    if (isText(relPath)) {
      await fs.writeFile(dst, canonicalizeThemeText(relPath, buf.toString('utf8'), registry), 'utf8');
    } else {
      // binary (images/...) — write verbatim, git is source of truth for bytes.
      await fs.writeFile(dst, buf);
    }
    pulled++;
  });

  notes.push(
    `fetched ${themeName} from portal ${acct.portalId} via source-code API; canonicalized ${pulled} file(s)`,
  );
  if (skippedEmptyModuleAssets) {
    notes.push(`ignored ${skippedEmptyModuleAssets} auto-created empty module.css/module.js file(s)`);
  }

  return { pulled, notes };
}

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

/**
 * push(acct, { contentDir, registry }) -> { pushed, notes }
 *
 * Build a temp tree, inject the TARGET account's portal id + form GUIDs into the
 * ref-bearing files (refs.resolve, which hard-fails on any unmapped token), then
 * upload that tree. Idempotent: `hs cms upload` to the same theme name creates-or-
 * updates by path. Never targets a hardcoded portal — `acct` is supplied by the
 * orchestrator.
 */
export async function push(acct, { contentDir, registry, config } = {}) {
  const root = config?.root || contentDir || REPO_ROOT;
  const themeName = config?.theme?.name || THEME_NAME;
  const notes = [];

  if (!registry || registry.portalId == null) {
    throw new Error(
      `theme.push: target registry has no portalId — cannot inject @portal for account ${acct.name}`,
    );
  }

  // Build tree under the repo (same mount as cwd) so `hs cms upload` reads it
  // reliably — os.tmpdir() may be a different mount (see pull()).
  const buildBase = config?.syncStateDirPath || join(root, '.sync-state');
  await fs.mkdir(buildBase, { recursive: true });
  const build = await mkdtemp(join(buildBase, 'theme-build-'));
  let pushed = 0;
  try {
    const files = await listThemeFiles(root);

    for (const relPath of files) {
      const src = join(root, relPath);
      const dst = join(build, relPath);
      await fs.mkdir(dirname(dst), { recursive: true });

      if (REF_BEARING(relPath)) {
        // Inject target refs BEFORE writing into the build tree.
        const raw = normalizeText(await fs.readFile(src, 'utf8'));
        const [injected] = injectRefsIntoTree([{ relPath, text: raw }], registry);
        await fs.writeFile(dst, injected.text, 'utf8');
      } else if (isText(relPath)) {
        await fs.writeFile(dst, normalizeText(await fs.readFile(src, 'utf8')), 'utf8');
      } else {
        await fs.copyFile(src, dst);
      }
      pushed++;
    }

    notes.push(
      `built target theme for portal ${registry.portalId} (${pushed} files); injected refs into ref-bearing files`,
    );

    // Upload the BUILT tree to the target account via the CMS Source Code API,
    // PUTting each file directly. We do NOT use `hs cms upload`: its whole-tree form
    // silently no-ops and mis-names the theme after the build dir, and the per-dir
    // form is unreliable in this environment. The API PUT is deterministic and
    // idempotent (create-or-replace by path). `files` is the list copied into the
    // build tree, so ref-bearing files already carry the injected target tokens.
    const CONCURRENCY = 8;
    let next = 0;
    let uploaded = 0;
    async function worker() {
      while (next < files.length) {
        const relPath = files[next++];
        await uploadSourceFile(acct, themeName, relPath, join(build, relPath));
        uploaded++;
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, files.length) }, () => worker()),
    );
    notes.push(
      `uploaded ${uploaded} file(s) to ${themeName} via source-code API (account ${acct.name}, portal ${acct.portalId})`,
    );
  } finally {
    await rm(build, { recursive: true, force: true });
  }

  return { pushed, notes };
}

export default { name, dependsOn, pull, push };
