// src/lib/page-sync.mjs — shared page-DEFINITION sync core for HubSpot "page"
// surfaces (site pages AND landing pages: same object shape, same v3 API shape,
// different endpoint + content subdir + manifest key). createPageAdapter() returns
// a { name, dependsOn, pull, push, loadManifest } adapter; the site-pages and
// landing-pages adapters are thin instantiations.
//
// The pure junk filters, the canonical projection (canonicalPage, in canonical.mjs),
// buildPagePayload, and the schedule-publish workaround are IDENTICAL across surfaces
// and live here once. See the original pages.mjs history for the codex rationale
// (#9 manifest-is-the-push-list, #11 per-item fresh publishDate, slug-skew guard).

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { hub as realHub, getAll as realGetAll, matchPageSlug } from './hub.mjs';
import { canonicalPage, stableStringify, slugToFile, fileToSlug } from './canonical.mjs';
import { canonicalize, resolve } from './refs.mjs';

// ── junk filters (shared) ────────────────────────────────────────────────────
const AB_STATES = new Set(['LOSER_AB_VARIANT', 'DRAFT_AB']);

export function isABVariant(page) {
  if (!page || typeof page !== 'object') return false;
  if (AB_STATES.has(page.currentState) || AB_STATES.has(page.state)) return true;
  if (page.abTestId != null && String(page.abTestId) !== '') return true;
  if (page.abStatus != null && String(page.abStatus) !== '' && page.abStatus !== 'master') return true;
  return false;
}

export function isArchived(page) {
  if (!page || typeof page !== 'object') return false;
  if (page.archivedInDashboard === true) return true;
  const at = page.archivedAt;
  if (typeof at === 'string' && at && !at.startsWith('1970-01-01')) return true;
  return false;
}

const TEMP_SLUG_RE = /^-?temporary-slug/i;
const GUID_SLUG_RE = /^-?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JUNK_SLUG_RE = /-ab-variant-|(?:^|[/-])archived(?:-\d+)?$|(?:^|[/-])old\d*$/i;

export function isTempSlug(slug) {
  const s = slug == null ? '' : String(slug);
  if (s === '') return false; // '' is the homepage — explicitly NOT junk
  return TEMP_SLUG_RE.test(s) || GUID_SLUG_RE.test(s) || JUNK_SLUG_RE.test(s);
}

export function isPortablePage(page) {
  return !isABVariant(page) && !isArchived(page) && !isTempSlug(page?.slug);
}

// ── manifest ─────────────────────────────────────────────────────────────────
const VALID_DESIRED_STATES = new Set(['publish', 'draft', 'archive', 'ignore']);

function manifestPathFor(contentDir) {
  return join(contentDir, '..', 'site.manifest.json');
}

// ── push payload (shared) ────────────────────────────────────────────────────
const PUSH_FIELDS = [
  'templatePath', 'name', 'htmlTitle', 'metaDescription', 'slug', 'language',
  'headHtml', 'footerHtml', 'linkRelCanonicalUrl', 'featuredImage', 'featuredImageAltText',
];
const PUSH_BOOL_FIELDS = { useFeaturedImage: false };

export function buildPagePayload(def) {
  const out = {};
  for (const f of PUSH_FIELDS) {
    if (f === 'slug') out.slug = def.slug ?? '';
    else if (f === 'language') out.language = def.language ?? 'en';
    else out[f] = def[f] ?? '';
  }
  for (const [f, dflt] of Object.entries(PUSH_BOOL_FIELDS)) {
    out[f] = def[f] ?? dflt;
  }
  if (typeof out.templatePath === 'string' && out.templatePath.startsWith('/')) {
    out.templatePath = out.templatePath.replace(/^\/+/, '');
  }
  return out;
}

const PUBLISH_LEAD_MS = 90_000;
function futurePublishDate(nowMs = Date.now()) {
  return new Date(nowMs + PUBLISH_LEAD_MS).toISOString().replace(/\.\d+Z$/, '.000Z');
}

// ── default I/O hooks (overridable for tests) ────────────────────────────────
async function defaultWriteFile(path, text) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
async function defaultReadDir(dir) {
  if (!existsSync(dir)) return [];
  return readdir(dir);
}
async function defaultReadFileText(path) {
  return readFile(path, 'utf8');
}

/**
 * createPageAdapter({ name, endpoint, subdir, manifestKey, dependsOn }) -> adapter
 *
 *   name        adapter name + error prefix (e.g. 'pages', 'landing-pages')
 *   endpoint    base API path (e.g. '/cms/v3/pages/site-pages')
 *   subdir      content subdir under contentDir (e.g. 'pages', 'landing-pages')
 *   manifestKey site.manifest.json key listing this surface's pages
 *   dependsOn   push-order deps (default forms+assets for ref resolution)
 */
export function createPageAdapter({
  name, endpoint, subdir, manifestKey, dependsOn = ['forms', 'assets'],
  // strictManifest: an EMPTY manifest list is a hard error (a misconfigured push must
  // not silently no-op). True for site-pages (every site has pages). False for optional
  // surfaces like landing pages — a site with none legitimately pushes nothing, and the
  // orchestrator runs this adapter unconditionally, so it must not throw on absence.
  strictManifest = false,
}) {
  const dirFor = (contentDir) => join(contentDir, subdir);
  const httpErr = (op, slug, res) => {
    const msg = res.json?.message || res.json?.category || JSON.stringify(res.json).slice(0, 200);
    return `${name}.push: ${op} "${slug || '(home)'}" -> ${res.status}: ${msg}`;
  };

  async function loadManifest(contentDir) {
    const manifestPath = manifestPathFor(contentDir);
    if (!existsSync(manifestPath)) return new Map();
    let parsed;
    try {
      parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (e) {
      throw new Error(`Invalid JSON in ${manifestPath}: ${e.message}`);
    }
    const map = new Map();
    for (const entry of parsed[manifestKey] || []) {
      if (!entry || typeof entry !== 'object') continue;
      const slug = entry.slug == null ? '' : String(entry.slug);
      const desiredState = entry.desiredState || 'publish';
      if (!VALID_DESIRED_STATES.has(desiredState)) {
        throw new Error(
          `site.manifest.json: ${manifestKey} "${slug || '(home)'}" has invalid desiredState `
          + `"${desiredState}" (expected ${[...VALID_DESIRED_STATES].join('|')})`,
        );
      }
      map.set(slug, { slug, desiredState });
    }
    return map;
  }

  async function pull(acct, ctx) {
    const { contentDir, registry } = ctx;
    const getAllFn = ctx.getAll || realGetAll;
    const writeFileFn = ctx.writeFile || defaultWriteFile;

    const manifest = await loadManifest(contentDir);
    const rawPages = await getAllFn(acct, endpoint);

    const notes = [];
    let pulled = 0;
    for (const raw of rawPages) {
      if (!isPortablePage(raw)) continue;
      const slug = raw.slug == null ? '' : String(raw.slug);

      let desiredState = 'publish';
      if (manifest.size > 0) {
        const entry = manifest.get(slug);
        if (!entry) {
          notes.push(`skip (not in manifest): ${slug || '(home)'}`);
          continue;
        }
        desiredState = entry.desiredState;
      }

      const def = canonicalPage(raw);
      const logicalized = JSON.parse(canonicalize(stableStringify(def), registry));
      logicalized.desiredState = desiredState;

      await writeFileFn(join(dirFor(contentDir), `${slugToFile(slug)}.json`), stableStringify(logicalized));
      pulled += 1;
    }
    return { pulled, notes };
  }

  async function makeSlugResolver(acct, hubFn) {
    let pages = null;
    const list = async () => {
      const out = [];
      let after;
      do {
        const path = `${endpoint}?limit=100${after ? `&after=${after}` : ''}`;
        const res = await hubFn(acct, 'GET', path);
        if (!res.ok) {
          const msg = res.json?.message || res.json?.category || JSON.stringify(res.json).slice(0, 200);
          throw new Error(`${name}.push: GET ${endpoint} -> ${res.status}: ${msg}`);
        }
        out.push(...(res.json?.results || []));
        after = res.json?.paging?.next?.after;
      } while (after);
      return out;
    };
    return async (slug) => {
      if (pages === null) pages = await list();
      return matchPageSlug(pages, slug);
    };
  }

  async function push(acct, ctx) {
    const { contentDir, registry } = ctx;
    const hubFn = ctx.hub || realHub;
    const readDirFn = ctx.readDir || defaultReadDir;
    const readFileTextFn = ctx.readFileText || defaultReadFileText;
    const nowFn = ctx.nowFn || (typeof ctx.now === 'number' ? () => ctx.now : Date.now);
    const resolvePageId = ctx.resolvePageId || (await makeSlugResolver(acct, hubFn));

    const manifest = await loadManifest(contentDir);
    if (manifest.size === 0) {
      if (strictManifest) {
        throw new Error(
          `${name}.push: site.manifest.json has no ${manifestKey} — it is the only push list `
          + `(refusing to infer publishable content from files in content/${subdir}).`,
        );
      }
      // Optional surface with nothing to manage — a clean no-op (the orchestrator runs
      // every adapter, so an absent landingPages list must not abort the whole push).
      return { pushed: 0, notes: [`no ${manifestKey} in site.manifest.json — nothing to push`] };
    }

    const dir = dirFor(contentDir);
    const files = (await readDirFn(dir)).filter((f) => f.endsWith('.json'));

    const notes = [];
    const toPublish = [];
    let pushed = 0;

    for (const fileName of files) {
      const fileSlug = fileToSlug(fileName.replace(/\.json$/, ''));
      const manifestEntry = manifest.get(fileSlug);
      if (!manifestEntry) {
        notes.push(`skip (not in manifest): ${fileName}`);
        continue;
      }
      const desiredState = manifestEntry.desiredState;
      if (desiredState === 'ignore') {
        notes.push(`ignore (manifest): ${fileSlug || '(home)'}`);
        continue;
      }

      const text = await readFileTextFn(join(dir, fileName));
      let def;
      try {
        def = JSON.parse(resolve(text, registry));
      } catch (e) {
        throw new Error(`${name}.push: ${fileName}: ${e.message}`);
      }

      const slug = def.slug ?? '';
      if (slug !== fileSlug) {
        throw new Error(
          `${name}.push: ${fileName}: body slug "${slug}" != filename slug "${fileSlug}" — `
          + 'refusing to push (would risk a duplicate page). Reconcile the filename and its slug.',
        );
      }
      const payload = buildPagePayload(def);
      if (!payload.name && !payload.htmlTitle) {
        throw new Error(
          `${name}.push: ${fileName}: name and htmlTitle are both empty — `
          + 'HubSpot rejects publish with CONTENT_TITLE_MISSING.',
        );
      }

      const existingId = await resolvePageId(slug);
      let pageId;
      if (existingId) {
        const res = await hubFn(acct, 'PATCH', `${endpoint}/${existingId}/draft`, payload);
        if (!res.ok) throw new Error(httpErr('PATCH draft', slug, res));
        pageId = existingId;
        notes.push(`updated: ${slug || '(home)'} (#${pageId})`);
      } else {
        const res = await hubFn(acct, 'POST', endpoint, payload);
        if (!res.ok) throw new Error(httpErr('POST create', slug, res));
        pageId = res.json?.id;
        if (!pageId) throw new Error(`${name}.push: create of "${slug}" returned no id`);
        notes.push(`created: ${slug || '(home)'} (#${pageId})`);
      }

      pushed += 1;
      if (desiredState === 'publish') toPublish.push({ slug, pageId });
    }

    for (const { slug, pageId } of toPublish) {
      const publishDate = futurePublishDate(nowFn());
      const res = await hubFn(acct, 'POST', `${endpoint}/schedule`, { id: String(pageId), publishDate });
      if (res.status === 204 || res.ok) {
        notes.push(`scheduled publish: ${slug || '(home)'} @ ${publishDate}`);
      } else {
        throw new Error(httpErr('schedule', slug, res));
      }
    }

    return { pushed, notes };
  }

  return { name, dependsOn, pull, push, loadManifest };
}
