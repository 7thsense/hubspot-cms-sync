// sync/adapters/pages.mjs — page DEFINITION adapter (slug, templatePath, name,
// htmlTitle, metaDescription, language, state) for the bidirectional sync.
//
// This adapter owns the page OBJECT/SEO definition, NOT the per-page module
// content (widgets/widgetContainers/layoutSections — that is the widgets
// adapter's job, codex §"Page MODULE CONTENT"). It deliberately projects only
// the portable definition fields via canonicalPage() and never commits a
// per-account id, url, domain host, currentState, publishDate, or AB metadata.
//
// PULL  (acct -> canonical files):
//   GET /cms/v3/pages/site-pages -> drop AB-variants/archived/temp junk
//   (codex #9) -> keep ONLY pages the manifest lists (site.manifest.json is the
//   single source of truth for what is push-able) -> canonicalPage() to project
//   the definition -> canonicalize() the serialized JSON so embedded per-account
//   refs (form/cta/menu guids, hubfs urls, portal ids) become @logical tokens
//   (registering them into THIS account's registry) -> write
//   content/pages/<slugToFile>.json carrying a `desiredState` field taken from
//   the manifest (publish|draft|archive|ignore). Never infer publishability from
//   files present on disk.
//
// PUSH  (canonical files -> acct, idempotent by SLUG):
//   For each page file: resolve() its @logical refs to the TARGET account's ids
//   (hard-fails if any ref is unmapped — push must not proceed); resolvePageBySlug
//   to decide create-vs-update; POST /cms/v3/pages/site-pages to CREATE or PATCH
//   /cms/v3/pages/site-pages/{id}/draft to UPDATE with the definition fields
//   (templatePath, name, htmlTitle, metaDescription, slug, language). Then PUBLISH
//   the ones whose desiredState==='publish' via the schedule endpoint (the
//   push-live-no-ops-on-first-publish workaround, reused from sync/republish.mjs).
//   'archive'/'ignore'/'draft' pages are written as drafts and NOT scheduled.
//
//   PRODUCTION (529456) is never targeted here — the orchestrator passes `acct`;
//   this adapter resolves nothing against a hardcoded portal.

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { hub, getAll, matchPageSlug } from '../lib/hub.mjs';
import { canonicalPage, stableStringify, slugToFile, fileToSlug } from '../lib/canonical.mjs';
import { canonicalize, resolve } from '../lib/refs.mjs';

export const name = 'pages';

// Pages depend on forms/ctas/menus/assets existing in the registry so resolve()
// can map @logical refs embedded in the definition (featuredImage hubfs urls,
// headHtml/footerHtml ctas/forms, portal ids) to target ids at PUSH time.
export const dependsOn = ['forms', 'assets'];

// ---------------------------------------------------------------------------
// Junk filters (codex #9). These are DEFENSE IN DEPTH on top of the manifest:
// the manifest is the authoritative push list, but pull also hard-excludes
// records HubSpot marks as AB variants / archived / temp so they can never be
// minted into the canonical tree even if a manifest entry were stale.
// ---------------------------------------------------------------------------

const AB_STATES = new Set(['LOSER_AB_VARIANT', 'DRAFT_AB']);

/**
 * isABVariant(page) -> boolean
 * True for any A/B test variant: HubSpot tags them via currentState/state
 * (LOSER_AB_VARIANT / DRAFT_AB) or carries an abTestId / abStatus. These are
 * not portable page DEFINITIONS and must never enter the canonical tree.
 */
export function isABVariant(page) {
  if (!page || typeof page !== 'object') return false;
  if (AB_STATES.has(page.currentState) || AB_STATES.has(page.state)) return true;
  if (page.abTestId != null && String(page.abTestId) !== '') return true;
  if (page.abStatus != null && String(page.abStatus) !== '' && page.abStatus !== 'master') {
    // abStatus is set on variants ('loser_variant', etc.); a stand-alone page
    // has no abStatus. ('master' would be the surviving page — but we exclude
    // the whole AB apparatus from portable definitions, so treat any non-empty
    // non-master abStatus as a variant.)
    return true;
  }
  return false;
}

/**
 * isArchived(page) -> boolean
 * Archived/deleted pages (archivedInDashboard, or an archivedAt that is not the
 * 1970 epoch sentinel HubSpot uses for "never archived").
 */
export function isArchived(page) {
  if (!page || typeof page !== 'object') return false;
  if (page.archivedInDashboard === true) return true;
  const at = page.archivedAt;
  if (typeof at === 'string' && at && !at.startsWith('1970-01-01')) return true;
  return false;
}

// HubSpot's auto-generated throwaway slugs for unsaved/temp pages.
const TEMP_SLUG_RE = /^-?temporary-slug/i;
// A slug that is just a leading-dash + bare guid (HubSpot's unnamed-page slug).
const GUID_SLUG_RE = /^-?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A slug that contains an explicit "-ab-variant-" / "-archived" / "-old" marker.
const JUNK_SLUG_RE = /-ab-variant-|(?:^|[/-])archived(?:-\d+)?$|(?:^|[/-])old\d*$/i;

/**
 * isTempSlug(slug) -> boolean
 * Throwaway / non-portable slugs that should never be committed.
 */
export function isTempSlug(slug) {
  const s = slug == null ? '' : String(slug);
  if (s === '') return false; // '' is the homepage — explicitly NOT junk
  return TEMP_SLUG_RE.test(s) || GUID_SLUG_RE.test(s) || JUNK_SLUG_RE.test(s);
}

/**
 * isPortablePage(page) -> boolean
 * The hard junk filter applied on pull regardless of the manifest.
 */
export function isPortablePage(page) {
  return !isABVariant(page) && !isArchived(page) && !isTempSlug(page?.slug);
}

// ---------------------------------------------------------------------------
// Manifest. site.manifest.json (repo root) is the ONLY push list (codex #9).
// Shape used by this adapter:
//   { "pages": [ { "slug": "", "desiredState": "publish" }, ... ] }
// `desiredState` ∈ publish|draft|archive|ignore. A page absent from the manifest
// is NOT pulled and NOT pushed. An 'ignore' entry is pulled (for reviewability)
// but never pushed/published.
// ---------------------------------------------------------------------------

const VALID_DESIRED_STATES = new Set(['publish', 'draft', 'archive', 'ignore']);

/**
 * loadManifestPages(contentDir) -> Map<slug, { slug, desiredState }>
 * Reads <repoRoot>/site.manifest.json. contentDir is .../content; the manifest
 * lives one level up at the repo root. Returns an empty map (not an error) when
 * the manifest is absent so a first-ever pull can be bootstrapped, but push
 * requires it (see push()).
 */
export async function loadManifestPages(contentDir) {
  const manifestPath = manifestPathFor(contentDir);
  if (!existsSync(manifestPath)) return new Map();
  let parsed;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (e) {
    throw new Error(`Invalid JSON in ${manifestPath}: ${e.message}`);
  }
  const map = new Map();
  for (const entry of parsed.pages || []) {
    if (!entry || typeof entry !== 'object') continue;
    const slug = entry.slug == null ? '' : String(entry.slug);
    const desiredState = entry.desiredState || 'publish';
    if (!VALID_DESIRED_STATES.has(desiredState)) {
      throw new Error(
        `site.manifest.json: page "${slug || '(home)'}" has invalid desiredState ` +
          `"${desiredState}" (expected ${[...VALID_DESIRED_STATES].join('|')})`,
      );
    }
    map.set(slug, { slug, desiredState });
  }
  return map;
}

// contentDir is <repoRoot>/content; the manifest is at <repoRoot>/site.manifest.json.
function manifestPathFor(contentDir) {
  return join(contentDir, '..', 'site.manifest.json');
}

function pagesDir(contentDir) {
  return join(contentDir, 'pages');
}

// ---------------------------------------------------------------------------
// PULL
// ---------------------------------------------------------------------------

/**
 * pull(acct, { contentDir, registry, writeFile, getAll: getAllOverride })
 *   -> { pulled, notes }
 *
 * Tests inject a stubbed `getAll` and `writeFile` so no real network/disk is
 * touched. In production the orchestrator passes the real fs writer.
 */
export async function pull(acct, ctx) {
  const { contentDir, registry } = ctx;
  const getAllFn = ctx.getAll || getAll;
  const writeFileFn = ctx.writeFile || defaultWriteFile;

  const manifest = await loadManifestPages(contentDir);
  const rawPages = await getAllFn(acct, '/cms/v3/pages/site-pages');

  const notes = [];
  let pulled = 0;

  for (const raw of rawPages) {
    // 1. Hard junk filter (AB/archived/temp) regardless of manifest.
    if (!isPortablePage(raw)) continue;

    const slug = raw.slug == null ? '' : String(raw.slug);

    // 2. Manifest is the source of truth for what we keep. If a manifest exists,
    //    only pull pages it lists. (Empty manifest -> bootstrap: keep all
    //    portable pages so a first pull can seed site.manifest.json by hand.)
    let desiredState = 'publish';
    if (manifest.size > 0) {
      const entry = manifest.get(slug);
      if (!entry) {
        notes.push(`skip (not in manifest): ${slug || '(home)'}`);
        continue;
      }
      desiredState = entry.desiredState;
    }

    // 3. Project the portable definition (drops id/url/currentState/publishDate/
    //    domain-host/AB metadata; keeps slug/name/htmlTitle/metaDescription/
    //    language/templatePath/widgets).
    const def = canonicalPage(raw);

    // 4. Logical-ize embedded per-account refs (featuredImage hubfs urls inside
    //    widgets, cta/form guids in head/footer html, portal ids). Serialize,
    //    run through canonicalize() against THIS account's registry (which
    //    registers any new ids), then re-parse so the committed file is clean
    //    structured JSON, not a string.
    const logicalized = JSON.parse(canonicalize(stableStringify(def), registry));

    // 5. Attach the manifest-driven desiredState (codex #9: never inferred).
    logicalized.desiredState = desiredState;

    const file = join(pagesDir(contentDir), `${slugToFile(slug)}.json`);
    await writeFileFn(file, stableStringify(logicalized));
    pulled += 1;
  }

  return { pulled, notes };
}

// ---------------------------------------------------------------------------
// PUSH
// ---------------------------------------------------------------------------

// The schedule publish workaround (sync/republish.mjs pattern): push-live
// no-ops on first publish, so we POST a near-future publishDate to the schedule
// endpoint. publishDate MUST be future and the title MUST be non-empty.
//
// codex #11 — per-item scheduling. The lead is computed FRESH for each item,
// immediately before that item's schedule call, off a `nowFn`. A single batch
// timestamp would be computed once at the start of the loop and could slip into
// the PAST for later items in a large/slow batch (HubSpot rejects a non-future
// publishDate), silently leaving a draft unpublished. A fresh date per item
// keeps every schedule request safely in the future.
const PUBLISH_LEAD_MS = 90_000;

function futurePublishDate(nowMs = Date.now()) {
  return new Date(nowMs + PUBLISH_LEAD_MS).toISOString().replace(/\.\d+Z$/, '.000Z');
}

// The definition fields we create/update with. Intentionally a small allow-list
// — this adapter does NOT push widgets/layoutSections (widgets adapter owns
// those) nor any per-account/volatile field.
// String fields pushed verbatim (after ref-resolve). headHtml/footerHtml/featuredImage
// carry @logical refs that resolve() already swapped to target ids before push.
const PUSH_FIELDS = [
  'templatePath', 'name', 'htmlTitle', 'metaDescription', 'slug', 'language',
  'headHtml', 'footerHtml', 'linkRelCanonicalUrl', 'featuredImage', 'featuredImageAltText',
];
// Boolean fields need their own default (not the '' string PUSH_FIELDS uses).
const PUSH_BOOL_FIELDS = { useFeaturedImage: false };

/**
 * buildPagePayload(def) -> create/update body.
 * Pure: project the create/update body from a canonical (refs-resolved) page
 * definition. `domain` is intentionally omitted so the page publishes onto the
 * target account's system domain (the prod host is never carried, codex §pages
 * round-trip risks). templatePath must NOT begin with '/'.
 */
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

/**
 * push(acct, { contentDir, registry, readDir, readFileText, resolvePageId, now })
 *   -> { pushed, notes }
 *
 * Idempotent by SLUG: resolvePageBySlug decides create (POST) vs update (PATCH
 * /{id}/draft). Tests inject `readDir`, `readFileText`, a `resolvePageId(slug)`
 * stub, and a `hub` stub so nothing real is touched.
 */
export async function push(acct, ctx) {
  const { contentDir, registry } = ctx;
  const hubFn = ctx.hub || hub;
  const readDirFn = ctx.readDir || defaultReadDir;
  const readFileTextFn = ctx.readFileText || defaultReadFileText;
  // codex #11: `nowFn()` is called FRESH for each scheduled item so the
  // publishDate is recomputed immediately before each schedule request and can
  // never slip into the past for a later item in a large batch. Tests may inject
  // a `nowFn` (a function, called once per item) or a fixed `now` (a number,
  // used as a constant base — for those tests there is exactly one item so it is
  // equivalent). Default: real wall clock, read per item.
  const nowFn = ctx.nowFn || (typeof ctx.now === 'number' ? () => ctx.now : Date.now);

  // resolvePageId(slug) -> id|null. Default lists site-pages ONCE and matches by
  // slug (so a write-only key still works via a single read; matchPageSlug is
  // the same pure matcher resolvePageBySlug uses). Tests stub this.
  const resolvePageId = ctx.resolvePageId || (await makeSlugResolver(acct, hubFn));

  // PUSH requires the manifest — never infer the push set from files present.
  const manifest = await loadManifestPages(contentDir);
  if (manifest.size === 0) {
    throw new Error(
      `pages.push: site.manifest.json has no pages — it is the only push list ` +
        `(refusing to infer publishable content from files in content/pages).`,
    );
  }

  const dir = pagesDir(contentDir);
  const files = (await readDirFn(dir)).filter((f) => f.endsWith('.json'));

  const notes = [];
  const toPublish = [];
  let pushed = 0;

  for (const fileName of files) {
    const fileSlug = fileToSlug(fileName.replace(/\.json$/, ''));

    // Honour the manifest: a file on disk not listed is NOT pushed.
    const manifestEntry = manifest.get(fileSlug);
    if (!manifestEntry) {
      notes.push(`skip (not in manifest): ${fileName}`);
      continue;
    }

    // An 'ignore' page is never pushed/published, so it must be skipped BEFORE
    // we read or resolve it. Otherwise an unmapped @logical ref inside an
    // ignored file would make resolve() throw and abort the ENTIRE push — an
    // ignored page must never be able to block valid pages from syncing.
    const desiredState = manifestEntry.desiredState;
    if (desiredState === 'ignore') {
      notes.push(`ignore (manifest): ${fileSlug || '(home)'}`);
      continue;
    }

    const text = await readFileTextFn(join(dir, fileName));

    // Resolve @logical refs to the TARGET account's ids. resolve() THROWS,
    // listing every unmapped ref, so push hard-fails before any network write
    // (codex #2). We resolve on the serialized string, then re-parse.
    let def;
    try {
      def = JSON.parse(resolve(text, registry));
    } catch (e) {
      throw new Error(`pages.push: ${fileName}: ${e.message}`);
    }

    const slug = def.slug ?? '';
    // INVARIANT: the filename slug (used for the manifest gate + resolve) and the
    // body slug (used for the create-vs-update decision) MUST agree. If a hand-edit
    // made them diverge, the manifest could gate on one slug while we create/update
    // a different one — minting a DUPLICATE page. Fail closed on skew.
    if (slug !== fileSlug) {
      throw new Error(
        `pages.push: ${fileName}: body slug "${slug}" != filename slug "${fileSlug}" — ` +
          `refusing to push (would risk a duplicate page). Reconcile the filename and its slug.`,
      );
    }
    const payload = buildPagePayload(def);

    // CONTENT_TITLE_MISSING guard: schedule requires a non-empty title.
    if (!payload.name && !payload.htmlTitle) {
      throw new Error(
        `pages.push: ${fileName}: name and htmlTitle are both empty — ` +
          `HubSpot rejects publish with CONTENT_TITLE_MISSING.`,
      );
    }

    // Create-vs-update decision is by SLUG identity.
    const existingId = await resolvePageId(slug);

    let pageId;
    if (existingId) {
      const res = await hubFn(acct, 'PATCH', `/cms/v3/pages/site-pages/${existingId}/draft`, payload);
      if (!res.ok) throw new Error(httpErr('PATCH draft', slug, res));
      pageId = existingId;
      notes.push(`updated: ${slug || '(home)'} (#${pageId})`);
    } else {
      const res = await hubFn(acct, 'POST', '/cms/v3/pages/site-pages', payload);
      if (!res.ok) throw new Error(httpErr('POST create', slug, res));
      pageId = res.json?.id;
      if (!pageId) throw new Error(`pages.push: create of "${slug}" returned no id`);
      notes.push(`created: ${slug || '(home)'} (#${pageId})`);
    }

    pushed += 1;
    if (desiredState === 'publish') toPublish.push({ slug, pageId });
    // 'draft'/'archive' are written as drafts and intentionally NOT scheduled.
  }

  // PUBLISH last, via schedule (republish.mjs pattern). codex #11: compute a
  // FRESH future publishDate for EACH item, immediately before its schedule
  // request, so a large/slow batch can never push a later item's date into the
  // past (which HubSpot would reject, silently leaving the draft unpublished).
  for (const { slug, pageId } of toPublish) {
    const publishDate = futurePublishDate(nowFn());
    const res = await hubFn(acct, 'POST', '/cms/v3/pages/site-pages/schedule', {
      id: String(pageId),
      publishDate,
    });
    if (res.status === 204 || res.ok) {
      notes.push(`scheduled publish: ${slug || '(home)'} @ ${publishDate}`);
    } else {
      throw new Error(httpErr('schedule', slug, res));
    }
  }

  return { pushed, notes };
}

// Build a default slug->id resolver that lists site-pages once and reuses the
// pure matcher. Cached across the push run.
async function makeSlugResolver(acct, hubFn) {
  let pages = null;
  return async (slug) => {
    if (pages === null) pages = await listSitePages(acct, hubFn);
    return matchPageSlug(pages, slug);
  };
}

async function listSitePages(acct, hubFn) {
  const out = [];
  let after;
  do {
    const path = `/cms/v3/pages/site-pages?limit=100${after ? `&after=${after}` : ''}`;
    const res = await hubFn(acct, 'GET', path);
    if (!res.ok) {
      const msg = res.json?.message || res.json?.category || JSON.stringify(res.json).slice(0, 200);
      throw new Error(`pages.push: GET site-pages -> ${res.status}: ${msg}`);
    }
    out.push(...(res.json?.results || []));
    after = res.json?.paging?.next?.after;
  } while (after);
  return out;
}

function httpErr(op, slug, res) {
  const msg = res.json?.message || res.json?.category || JSON.stringify(res.json).slice(0, 200);
  return `pages.push: ${op} "${slug || '(home)'}" -> ${res.status}: ${msg}`;
}

// ---------------------------------------------------------------------------
// Default real-I/O hooks (overridable for unit tests).
// ---------------------------------------------------------------------------

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
