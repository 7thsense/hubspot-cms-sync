// sync/adapters/content.mjs — page MODULE CONTENT (widgets) adapter.
//
// WHAT THIS OWNS: the per-page-INSTANCE module field VALUES — HubSpot calls these
// `widgets` (a map keyed by module-instance name; each value is a "carrier"
// { body, name, type, label, css, child_css }). This is the only render path for
// content that a coded `{% module %}` template exposes for marketer editing and that
// won't serialize as HubL tag params (rich text / HTML). It is the canonicalized,
// account-agnostic successor to the proven sync/page-content.mjs one-shot script.
//
// SEPARATION OF CONCERNS:
//   - The page DEFINITION (slug, name, htmlTitle, templatePath, ...) is the `pages`
//     adapter's job. This adapter touches ONLY the widgets map on an existing page,
//     identified by SLUG. It never creates pages (pages.push does) — it resolves a
//     page id by slug at push time and PATCHes its draft.
//   - Reference portability (form GUIDs, CTA guids, hosted asset URLs, bare portal
//     ids embedded inside widget body strings) is delegated wholesale to
//     sync/lib/refs.mjs. home.widgets.json:743 carries a raw `form_id` GUID; on pull
//     that becomes `@form:<key>`, on push it is resolved to the TARGET account's GUID.
//
// CANONICAL CONTRACT (codex #8 — keep widget-carrier empties, replace-not-merge):
//   normalizeWidgets() in canonical.mjs deliberately KEEPS empty css/child_css/label
//   and passes `body` through verbatim (including empty-string body fields like
//   section_id:''), because the push PATCH REPLACES the whole widget — a thinner
//   payload would blank rendered styling. We therefore must NOT run a generic
//   empty-omit over the carrier. stableStringify gives the diff-clean bytes; refs
//   canonicalize/resolve only swap id substrings, so the JSON stays valid + stable.
//
// ROUND-TRIP (pull -> push -> pull converges): pull writes
//   stableStringify({ widgets: normalizeWidgets(raw) })  then  canonicalize(str, reg)
// push does the inverse: resolve(fileBytes, reg) -> parse -> PATCH draft -> schedule.
// Because canonicalize/resolve are exact string inverses for matched logical keys and
// stableStringify is idempotent, bytes converge.
//
// READ-ONLY PROD: this adapter never hardcodes a portal; the orchestrator passes
// `acct`. push() targets whatever `acct` it is given (prod is excluded upstream).

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { hub, getAll, resolvePageBySlug } from '../lib/hub.mjs';
import { stableStringify, normalizeWidgets, slugToFile, fileToSlug } from '../lib/canonical.mjs';
import { canonicalize, resolve } from '../lib/refs.mjs';

export const name = 'content';

// Page widgets embed form GUIDs and CTA refs whose TARGET ids/urls are populated by
// the forms and assets adapters' push. We CONSUME those registry entries at push
// time, so we depend on them. (The orchestrator runs dependsOn adapters' push first.)
export const dependsOn = ['forms', 'assets'];

// Where canonical widget files live, relative to contentDir.
const PAGES_SUBDIR = join('pages');
const WIDGETS_SUFFIX = '.widgets.json';

// Seconds in the future to schedule a draft publish. The schedule endpoint requires a
// FUTURE publishDate; the page goes live ~90s later. Mirrors page-content.mjs.
const PUBLISH_LEAD_MS = 90_000;

// ---------------------------------------------------------------------------
// Page selection (pull): exclude AB variants and any page without a widgets map.
// A page with no instance-editable modules has nothing for THIS adapter to own.
// ---------------------------------------------------------------------------
function isABVariant(page) {
  if (page.abTestId) return true;
  const st = String(page.currentState || page.state || '');
  return st === 'LOSER_AB_VARIANT' || st === 'DRAFT_AB' || st === 'AB';
}

function hasWidgets(page) {
  return page && page.widgets && typeof page.widgets === 'object' && Object.keys(page.widgets).length > 0;
}

// Build the canonical, account-portable widgets file CONTENT (a string) for one page.
// Steps: project to carrier-only widgets (keeps empties), stable-stringify for a clean
// diff, then logical-ize embedded refs (form GUID -> @form:key, etc.) via the registry,
// which also REGISTERS any newly-seen ids so first pull is self-bootstrapping.
function canonicalWidgetsFile(rawPage, registry) {
  const widgets = normalizeWidgets(rawPage.widgets);
  const bytes = stableStringify({ widgets });
  return canonicalize(bytes, registry);
}

function widgetsPath(contentDir, slug) {
  return join(contentDir, PAGES_SUBDIR, `${slugToFile(slug)}${WIDGETS_SUFFIX}`);
}

// ---------------------------------------------------------------------------
// pull(acct, { contentDir, registry }) -> { pulled, notes }
// For every live, non-AB site page that carries module-instance values, fetch the
// full page (the list endpoint omits widgets), canonicalize, and write
// content/pages/<slug>.widgets.json. Registers any embedded refs into `registry`.
// ---------------------------------------------------------------------------
export async function pull(acct, { contentDir, registry }) {
  const notes = [];
  const outDir = join(contentDir, PAGES_SUBDIR);
  mkdirSync(outDir, { recursive: true });

  const list = await getAll(acct, '/cms/v3/pages/site-pages');
  const candidates = list.filter((p) => !isABVariant(p));

  let pulled = 0;
  for (const summary of candidates) {
    const id = String(summary.id);
    // The list payload omits `widgets`; fetch the full page to get the carrier map.
    const { ok, status, json } = await hub(acct, 'GET', `/cms/v3/pages/site-pages/${id}`);
    if (!ok) {
      notes.push(`skip page ${id} (${summary.slug ?? ''}): GET -> ${status}`);
      continue;
    }
    if (!hasWidgets(json)) continue; // no instance-editable modules -> nothing to own

    const slug = String(json.slug ?? summary.slug ?? '');
    const file = canonicalWidgetsFile(json, registry);
    writeFileSync(widgetsPath(contentDir, slug), file);
    pulled += 1;
  }

  notes.push(`pulled ${pulled} page widget file(s) from ${candidates.length} non-AB page(s)`);
  return { pulled, notes };
}

// ---------------------------------------------------------------------------
// push(acct, { contentDir, registry }) -> { pushed, notes }
// For each content/pages/<slug>.widgets.json: resolve embedded logical refs to THIS
// account's ids/urls (HARD-FAILS via resolve() if any ref is unmapped), resolve the
// page id by slug, PATCH the page draft with the full widgets carrier (replace-not-
// merge), then schedule a near-future publish so the draft goes live.
// Idempotent: PATCH draft + schedule by stable identity (slug -> page id) — running
// twice converges to the same draft+publish.
// ---------------------------------------------------------------------------
export async function push(acct, { contentDir, registry }) {
  const notes = [];
  const dir = join(contentDir, PAGES_SUBDIR);
  if (!existsSync(dir)) {
    notes.push(`no pages dir at ${dir}; nothing to push`);
    return { pushed: 0, notes };
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(WIDGETS_SUFFIX));
  let pushed = 0;
  for (const fname of files) {
    const stem = fname.slice(0, -WIDGETS_SUFFIX.length);
    const slug = fileToSlug(stem);

    // 1. Read canonical bytes and inject target ids. resolve() THROWS listing every
    //    unmapped logical ref — a missing form/cta/asset mapping must abort the push.
    const raw = readFileSync(join(dir, fname), 'utf8');
    const resolved = resolve(raw, registry); // throws on unmapped refs
    let widgets;
    try {
      widgets = JSON.parse(resolved).widgets;
    } catch (e) {
      throw new Error(`content.push: ${fname} is not valid JSON after ref-resolve: ${e.message}`);
    }
    if (!widgets || typeof widgets !== 'object') {
      notes.push(`skip ${fname}: no widgets object`);
      continue;
    }
    // DATA-LOSS GUARD (replace-not-merge): an empty widgets map would PATCH the
    // draft with `widgets: {}`, and because HubSpot REPLACES the whole carrier
    // that BLANKS every widget on the live page. A file with no widgets has
    // nothing to own (mirrors pull's hasWidgets skip) — never emit an empty PATCH.
    if (Object.keys(widgets).length === 0) {
      notes.push(`skip ${fname}: widgets map is empty (refusing to blank the live page)`);
      continue;
    }

    // 2. Resolve the page id by slug. The page DEFINITION must already exist (pages
    //    adapter runs first). If it doesn't, this adapter can't place the widgets.
    const pageId = await resolvePageBySlug(acct, slug);
    if (!pageId) {
      notes.push(`skip ${fname}: no page in account ${acct.portalId} for slug "${slug}" (pages.push must create it first)`);
      continue;
    }

    // 3. PATCH the draft with the FULL carrier (replace-not-merge). We send the
    //    complete widgets map; HubSpot overwrites each widget wholesale, so the kept
    //    empties (css/child_css/label) are load-bearing.
    const patch = await hub(acct, 'PATCH', `/cms/v3/pages/site-pages/${pageId}/draft`, { widgets });
    if (!patch.ok) {
      const msg = patch.json?.message || patch.json?.category || `HTTP ${patch.status}`;
      throw new Error(`content.push: PATCH draft for slug "${slug}" (page ${pageId}) failed: ${msg}`);
    }

    // 4. Schedule a near-future publish so the updated draft goes live. The schedule
    //    endpoint requires a FUTURE publishDate (.000Z form); never push-live/draft.
    //    codex #11: compute the publishDate FRESH here, immediately before the
    //    schedule request (per item — never one shared batch timestamp), so a
    //    large/slow batch can't push a later item's date into the past.
    const publishDate = new Date(Date.now() + PUBLISH_LEAD_MS).toISOString().replace(/\.\d+Z$/, '.000Z');
    const sch = await hub(acct, 'POST', '/cms/v3/pages/site-pages/schedule', {
      id: String(pageId),
      publishDate,
    });
    // codex #11: THROW on a schedule failure — never a soft note. The draft PATCH
    // already landed, so a failed schedule leaves a live/draft DIVERGENCE (the
    // draft has the new widgets but the live page does not). Swallowing that was
    // silent data divergence; fail closed so the operator sees + retries it.
    if (!sch.ok && sch.status !== 204) {
      const msg = sch.json?.message || sch.json?.category || `HTTP ${sch.status}`;
      throw new Error(
        `content.push: schedule publish for slug "${slug}" (page ${pageId}) failed: ${msg} ` +
          `(draft was PATCHed but is NOT live — re-run to converge)`,
      );
    }
    pushed += 1;
  }

  notes.push(`pushed ${pushed} page widget file(s) to portal ${acct.portalId}`);
  return { pushed, notes };
}

export default { name, dependsOn, pull, push };
