// sync/lib/canonical.mjs
//
// Canonicalization for clean, portable git diffs in the bidirectional
// git <-> HubSpot sync system.
//
// PURE: no I/O, no network, no `process`/`fs`. Every export is a pure
// function so it can be unit-tested without a HubSpot account (per the
// codex review tier-1 requirement). Higher layers (adapters) do the I/O
// and call into these helpers.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY canonicalization is RESOURCE/FIELD-SPECIFIC, not a blanket omit
// (codex finding #8, design §1.3 / §6.3):
//
// The naive approach — "recursively drop every null/'' and every empty
// object" — is WRONG for this corpus, and the codex review flagged it as a
// must-fix. Page MODULE CONTENT ("widget carriers": widgets /
// widgetContainers / layoutSections) is pushed back to HubSpot with a
// REPLACE-not-merge PATCH semantics: the complete carrier object is sent and
// HubSpot overwrites the whole widget, it does NOT merge field-by-field.
// That means a widget value of `css: {}`, `child_css: {}`, or `label: ""`
// is LOAD-BEARING — if canonicalization silently dropped it, the round-trip
// (pull -> canonical -> push) would send a thinner payload than HubSpot
// expects and blank-out / reset rendered styling. So inside widget carriers
// we KEEP empty css/child_css/label/body. The volatile-key stripping
// (stripVolatile) is therefore a *targeted* removal of per-account/volatile
// keys (ids, timestamps, urls, hashes, ...), NOT a "remove all empties" pass.
//
// Each exported transform documents exactly which fields it touches.
// ─────────────────────────────────────────────────────────────────────────

// Keys that are per-account or volatile and must NEVER land in a committed
// canonical file. Matched by exact name. *At / *ById are matched by suffix
// (see SUFFIX_AT / SUFFIX_BY_ID below) so new timestamp variants
// (publishDate, archivedAt, lastEditedAt, ...) are caught without an
// ever-growing list.
const VOLATILE_EXACT = new Set([
  'id',
  'currentState',
  'url',
  'hash',
  'folder',
  'children',
  // publishDate is volatile per design §1.3 (HubSpot recomputes it on
  // publish); it ends in "Date" not "At", so it is listed explicitly here.
  'publishDate',
]);

// Suffix matchers for the families of volatile keys.
//  *At   -> createdAt, updatedAt, archivedAt, ...
//  *ById -> createdById, updatedById, ...
function isVolatileKey(key, extra) {
  if (VOLATILE_EXACT.has(key)) return true;
  if (extra.has(key)) return true;
  if (key.endsWith('ById')) return true;
  // `...At` timestamp family (createdAt/updatedAt/archivedAt/...). Guard on
  // length so a literal key named "At" (none in this corpus) doesn't trip,
  // and avoid matching "...Cat"/"...Format" by requiring an uppercase boundary.
  if (/[a-z0-9]At$/.test(key)) return true;
  return false;
}

/**
 * stableStringify(obj) -> string
 *
 * Deterministic JSON serialization for diff-clean commits:
 *   - object keys recursively SORTED (lexicographic, default JS string sort)
 *   - 2-space indent
 *   - LF line endings (JSON.stringify never emits CRLF)
 *   - trailing newline
 *   - arrays keep their order (order is meaningful: layoutSection rows,
 *     stats, logos, ...)
 *
 * Does NOT strip or normalize values — pair it with stripVolatile /
 * canonicalPage first. The only transform is key ordering + formatting, so
 * two semantically-equal but differently-key-ordered inputs serialize byte
 * identically.
 */
export function stableStringify(obj) {
  return JSON.stringify(sortKeysDeep(obj), null, 2) + '\n';
}

// Recursively return a structurally-equal value with all object keys sorted.
// Arrays are mapped in place (order preserved). Primitives pass through.
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * stripVolatile(obj, extraKeys=[]) -> obj
 *
 * Recursively removes per-account / volatile keys so the canonical tree
 * carries no portal-specific identity. Returns a NEW value (does not mutate
 * the input). Recurses through both objects and arrays.
 *
 * Removed: id, *At (createdAt/updatedAt/archivedAt/publishDate-family via
 * explicit + suffix match), *ById, currentState, url, hash, folder, children,
 * plus any names passed in `extraKeys`.
 *
 * This is a TARGETED key removal, NOT an empty/null omit (see the file
 * header). Empty objects/strings that remain after stripping are preserved.
 */
export function stripVolatile(obj, extraKeys = []) {
  const extra = extraKeys instanceof Set ? extraKeys : new Set(extraKeys);
  return strip(obj, extra);
}

function strip(value, extra) {
  if (Array.isArray(value)) return value.map((v) => strip(v, extra));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (isVolatileKey(key, extra)) continue;
      out[key] = strip(v, extra);
    }
    return out;
  }
  return value;
}

/**
 * slugToFile(slug) -> filename
 *
 * Maps a HubSpot page slug to a safe canonical filename stem.
 *   - '' (homepage)        -> 'home'
 *   - '/' inside the slug  -> '__'   (e.g. 'blog/x' -> 'blog__x')
 *
 * The empty-slug homepage cannot be a filename, so it gets the 'home'
 * sentinel. '/' is not legal in a path segment, so it is escaped to '__'.
 */
export function slugToFile(slug) {
  if (slug === '' || slug == null) return 'home';
  return String(slug).replace(/\//g, '__');
}

/**
 * fileToSlug(name) -> slug
 *
 * Inverse of slugToFile.
 *   - 'home'      -> ''
 *   - 'blog__x'   -> 'blog/x'
 *
 * A trailing '.json' (or any extension) should be stripped by the caller
 * before calling; fileToSlug operates on the bare stem.
 */
export function fileToSlug(name) {
  if (name === 'home' || name === '' || name == null) return '';
  return String(name).replace(/__/g, '/');
}

// Fields kept on a canonical page widget carrier value. Per codex finding #8
// these are kept VERBATIM even when empty (css/child_css/label), because the
// push is replace-not-merge.
const WIDGET_KEEP = ['body', 'name', 'type', 'label', 'css', 'child_css'];

/**
 * canonicalPage(rawPage) -> canonical page definition
 *
 * Produces the portable, slug-keyed page DEFINITION object:
 *   { slug, name, htmlTitle, metaDescription, language, templatePath, widgets }
 *
 * - slug:            raw slug, defaulting to '' (homepage). NOT the volatile id.
 * - name/htmlTitle/metaDescription: SEO/definition fields, defaulted to ''.
 * - language:        defaults to 'en'.
 * - templatePath:    kept as-is (the manifest-driven rewrite of non-portable
 *                    marketplace/generated paths is a separate adapter
 *                    concern, intentionally NOT done here so this stays pure).
 * - widgets:         normalized widget carrier map (see normalizeWidgets).
 *
 * Volatile page-level keys (id, url, *At, currentState, publishDate, ...) are
 * simply not projected here. We project an explicit allow-list of definition
 * fields rather than strip-everything-else, so the schema is stable and
 * documented.
 */
export function canonicalPage(rawPage) {
  const raw = rawPage || {};
  return {
    slug: raw.slug ?? '',
    name: raw.name ?? '',
    htmlTitle: raw.htmlTitle ?? '',
    metaDescription: raw.metaDescription ?? '',
    language: raw.language ?? 'en',
    templatePath: raw.templatePath ?? '',
    widgets: normalizeWidgets(raw.widgets),
  };
}

/**
 * normalizeWidgets(widgets) -> normalized widget carrier map
 *
 * For each widget instance (keyed by instance name), keep exactly the
 * carrier fields HubSpot needs for a replace-not-merge PATCH:
 *   body, name, type, label, css, child_css
 *
 * CRITICAL (codex #8): empty css/child_css/label and body sub-fields are
 * KEPT, not omitted. `body` is passed through unchanged (its per-field values
 * — including empty strings like section_id:'' — are the actual content and
 * must survive). Only keys OUTSIDE the WIDGET_KEEP set (e.g. a stray volatile
 * `id` HubSpot might echo on a widget) are dropped.
 *
 * Default empties are supplied for any missing carrier field so the pushed
 * payload is always complete: label -> '', css/child_css -> {}, type ->
 * 'module', body -> {}.
 */
export function normalizeWidgets(widgets) {
  if (!widgets || typeof widgets !== 'object') return {};
  const out = {};
  for (const [instanceName, raw] of Object.entries(widgets)) {
    if (!raw || typeof raw !== 'object') continue;
    const w = {};
    for (const field of WIDGET_KEEP) {
      if (field in raw) {
        w[field] = raw[field];
      } else {
        // Supply explicit empties so the carrier is complete for push.
        if (field === 'css' || field === 'child_css') w[field] = {};
        else if (field === 'label') w[field] = '';
        else if (field === 'type') w[field] = 'module';
        else if (field === 'name') w[field] = instanceName;
        else if (field === 'body') w[field] = {};
      }
    }
    out[instanceName] = w;
  }
  return out;
}
