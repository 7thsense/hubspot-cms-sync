// sync/adapters/content.mjs — page MODULE CONTENT (widgets) adapter.
//
// WHAT THIS OWNS: the per-page-INSTANCE module field VALUES — HubSpot calls these
// `widgets` (a map keyed by module-instance name; each value is a "carrier"
// { body, name, type, label, css, child_css }). This is the only render path for
// content that a coded `{% module %}` template exposes for marketer editing and that
// won't serialize as HubL tag params (rich text / HTML). It is the canonicalized,
// account-agnostic successor to the proven sync/page-content.mjs one-shot script.
//
// SINGLE SOURCE OF TRUTH — widgets are EMBEDDED in content/pages/<slug>.json:
//   The page's module content lives under the `widgets` key of its own page file,
//   the SAME file (and SAME normalized carrier shape) the `pages` adapter writes on
//   pull via canonicalPage -> normalizeWidgets. There is NO separate <slug>.widgets.json
//   — one file per page, read by BOTH publishing targets (this adapter for HubSpot,
//   build-static for the static target). A standalone widgets file was a second
//   pull-writer for the same content and drifted; this design removes it.
//
// SEPARATION OF CONCERNS:
//   - The page DEFINITION (slug, name, htmlTitle, templatePath, ...) is the `pages`
//     adapter's job; that adapter OWNS content/pages/<slug>.json end-to-end on pull
//     (definition + embedded widgets). This adapter is PUSH-ONLY for widgets: the
//     `pages` adapter deliberately does NOT push the widgets map, so we do. We touch
//     ONLY the widgets map on an existing page, identified by SLUG; we never create
//     pages (pages.push does) — we resolve a page id by slug and PATCH its draft.
//   - Reference portability (form GUIDs, CTA guids, hosted asset URLs, bare portal
//     ids embedded inside widget body strings) is delegated wholesale to
//     sync/lib/refs.mjs. The embedded `widgets` carry logical tokens (`@form:<key>`);
//     on push each is resolved to the TARGET account's GUID.
//
// CANONICAL CONTRACT (codex #8 — keep widget-carrier empties, replace-not-merge):
//   normalizeWidgets() in canonical.mjs deliberately KEEPS empty css/child_css/label
//   and passes `body` through verbatim (including empty-string body fields like
//   section_id:''), because the push PATCH REPLACES the whole widget — a thinner
//   payload would blank rendered styling. We therefore must NOT run a generic
//   empty-omit over the carrier. stableStringify gives the diff-clean bytes; refs
//   canonicalize/resolve only swap id substrings, so the JSON stays valid + stable.
//
// ROUND-TRIP (pull -> push -> pull converges, PROVABLY): the `pages` adapter pull
// writes the embedded widgets as  normalizeWidgets(raw)  into <slug>.json. This adapter
// push reads that SAME embedded map, runs  resolve(stableStringify({widgets}), reg) ->
// parse -> PATCH draft -> schedule. normalizeWidgets is idempotent and canonicalize/
// resolve are exact string inverses for matched logical keys, so a value pulled then
// pushed then pulled again is byte-identical. (Both sides share normalizeWidgets, so
// there is no second normalizer that could diverge.)
//
// READ-ONLY PROD: this adapter never hardcodes a portal; the orchestrator passes
// `acct`. push() targets whatever `acct` it is given (prod is excluded upstream).

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { hub, resolvePageBySlug } from '../lib/hub.mjs';
import { stableStringify, normalizeWidgets, fileToSlug } from '../lib/canonical.mjs';
import { resolve } from '../lib/refs.mjs';

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
// pull(acct, ctx) -> { pulled: 0, notes }
//
// INTENTIONAL NO-OP. The page's widgets are embedded in content/pages/<slug>.json,
// which the `pages` adapter OWNS on pull: its canonicalPage() projects
// normalizeWidgets(raw.widgets) into the page file AND canonicalize()s the embedded
// refs into the registry. Having THIS adapter also fetch + write the same widgets
// (to a separate file) is exactly the dual-writer drift this design removes. Push
// still reads those embedded widgets, so the pull -> push round-trip is intact —
// the pull half just belongs to the `pages` adapter now.
// ---------------------------------------------------------------------------
export async function pull() {
  return {
    pulled: 0,
    notes: ['widgets are embedded in content/pages/<slug>.json (owned by the `pages` adapter); nothing to pull separately'],
  };
}

// ---------------------------------------------------------------------------
// push(acct, { contentDir, registry }) -> { pushed, notes }
// For each content/pages/<slug>.json carrying a non-empty embedded `widgets` map:
// resolve embedded logical refs to THIS account's ids/urls (HARD-FAILS via resolve()
// if any ref is unmapped), resolve the page id by slug, PATCH the page draft with the
// full widgets carrier (replace-not-merge), then schedule a near-future publish so the
// draft goes live. Standalone <slug>.widgets.json files (legacy) are ignored.
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

  // Source of truth: the embedded `widgets` of each page file. Skip standalone
  // legacy <slug>.widgets.json (no longer emitted) so a page is never double-owned.
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.endsWith(WIDGETS_SUFFIX))
    .sort();
  let pushed = 0;
  for (const fname of files) {
    // 1. Read the page file and project its embedded widgets to the canonical carrier
    //    (normalizeWidgets keeps the load-bearing empties; idempotent — the `pages`
    //    adapter wrote these with the same function). A page with no widgets is a
    //    plain template-only page and is simply skipped (NOT an empty PATCH — see #2).
    let page;
    try {
      page = JSON.parse(readFileSync(join(dir, fname), 'utf8'));
    } catch (e) {
      throw new Error(`content.push: ${fname} is not valid JSON: ${e.message}`);
    }
    const widgetsRaw = normalizeWidgets(page.widgets);
    // DATA-LOSS GUARD (replace-not-merge): an empty widgets map would PATCH the draft
    // with `widgets: {}`, and because HubSpot REPLACES the whole carrier that BLANKS
    // every widget on the live page. A page with no instance-editable modules has
    // nothing for THIS adapter to own — skip it silently (the common case: every
    // template-only page), never emit an empty PATCH.
    if (Object.keys(widgetsRaw).length === 0) continue;

    const slug = page.slug == null ? fileToSlug(fname.replace(/\.json$/, '')) : String(page.slug);

    // 1b. Inject target ids. resolve() THROWS listing every unmapped logical ref — a
    //     missing form/cta/asset mapping must abort the push (never a partial blank).
    let widgets;
    try {
      widgets = JSON.parse(resolve(stableStringify({ widgets: widgetsRaw }), registry)).widgets;
    } catch (e) {
      // A ref-resolve failure is a hard error (re-throw); JSON.parse here cannot fail
      // because stableStringify produced the bytes, but keep the slug in any message.
      throw new Error(`content.push: ${fname} (slug "${slug}"): ${e.message}`);
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

  notes.push(`pushed ${pushed} page widget map(s) (from embedded <slug>.json) to portal ${acct.portalId}`);
  return { pushed, notes };
}

export default { name, dependsOn, pull, push };
