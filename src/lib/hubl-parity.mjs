// src/lib/hubl-parity.mjs — HubL-parity GUARD for the STATIC build.
//
// The static target renders the SAME HubL templates HubSpot does, through the
// Nunjucks env built by render.mjs::makeEnv (its built-in filters/globals plus the
// finite HubL compatibility layer registered there). When a template reaches for a
// filter or global that env does NOT implement, Nunjucks fails mid-render with a
// cryptic error (e.g. a missing `request` global surfaces as "Cannot use 'in'
// operator … in unexpected types"), discovered only when a deploy gate trips — not
// when the template is authored.
//
// This guard SCANS the template/module sources BEFORE rendering and reports the
// unimplemented constructs, so build-static can FAIL FAST with an actionable message
// (the construct, the file, "add it to render.mjs") instead of that mid-render crash.
//
// Pure + filesystem-free: callers pass the registered names (reflected off a real
// env so the lists never drift from makeEnv) and the template sources as strings.

// ---------------------------------------------------------------------------
// Context locals the per-render context provides (render.mjs builds these into
// the context object passed to env.render) plus the loop/iteration variables a
// template introduces itself. NEVER flag these as missing globals — they are not
// registered via addGlobal but are always present at render time.
// ---------------------------------------------------------------------------
const CONTEXT_LOCALS = new Set([
  'content', 'contents', 'module', 'post', 'item', 'loop',
  'nav_active', 'nav_hide_cta', 'current_page_num', '__page_modules',
  'theme', // resolved separately (build-static resolveThemeTokens) but referenced as theme.*
]);

// Nunjucks/Jinja keywords + literals that can appear in identifier position but are
// not globals. `loop` is also a context local; listing it here is harmless.
const KEYWORDS = new Set([
  'if', 'else', 'elif', 'endif', 'for', 'endfor', 'in', 'is', 'not', 'and', 'or',
  'set', 'endset', 'block', 'endblock', 'extends', 'include', 'import', 'from',
  'macro', 'endmacro', 'call', 'endcall', 'filter', 'endfilter', 'raw', 'endraw',
  'true', 'false', 'none', 'null', 'True', 'False', 'None', 'loop', 'with',
  'as', 'do', 'recursive', 'without', 'context', 'ignore', 'missing',
]);

// ---------------------------------------------------------------------------
// Filter extraction. HubL/Nunjucks pipe syntax: `value | name`, chained
// `a|b|c`, and filters with args `name('x')` / `name(1, 2)`. We match the filter
// NAME that follows a single `|` (a `||` is the "or" operator, never a filter, so
// require the pipe not be doubled on either side). The name is the identifier; any
// trailing `(...)` args are ignored for the membership check.
// ---------------------------------------------------------------------------
const FILTER_RE = /(?<!\|)\|(?!\|)\s*([A-Za-z_]\w*)/g;

export function extractFilters(src) {
  const found = new Set();
  for (const m of String(src).matchAll(FILTER_RE)) found.add(m[1]);
  return found;
}

// ---------------------------------------------------------------------------
// Global/function extraction (best-effort, conservative — under-report rather
// than flag legitimate context vars). We collect a top-level identifier NAME when
// it is referenced as:
//   {{ NAME(...) }} / {% … NAME(...) … %}   — a function call
//   {{ NAME.prop }} / NAME.x in …           — a member access on a bare global
// and NAME is not a context local, not a keyword, and not introduced as a loop
// variable / {% set %} target in the same source. Only identifiers in `{{ }}`,
// `{% %}` delimiters are scanned (we strip the literal HTML around them first), so
// HTML attributes/text never produce false positives.
// ---------------------------------------------------------------------------

// Pull out just the expression/statement bodies; ignore everything outside the
// HubL delimiters and the contents of `{# comments #}`.
const DELIM_RE = /\{\{([\s\S]*?)\}\}|\{%([\s\S]*?)%\}/g;
const COMMENT_RE = /\{#[\s\S]*?#\}/g;

// A bare identifier used as a call or as the root of a member access. Excludes a
// name that is itself preceded by `.` (a property, e.g. the `path` in request.path)
// or by `|` (a filter, handled above) or that is immediately a kwarg `name=` inside
// a call signature. The capturing group is the root identifier.
const IDENT_RE = /(?<![.\w|'"])([A-Za-z_]\w*)\s*(\(|\.)/g;

// String literals inside an expression body must NOT be scanned for identifiers — a
// path arg like "../modules/hero.module" would otherwise read `hero` as a missing
// global. Blank them (preserving the quotes so adjacent syntax is unaffected).
const STRING_RE = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g;

// Loop targets `{% for X[, Y] in … %}` and set targets `{% set X = … %}` introduce
// locals; collect them so a template-local name is never reported as a missing global.
const FOR_RE = /\{%-?\s*for\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)?)\s+in\b/g;
const SET_RE = /\{%-?\s*set\s+([A-Za-z_]\w*)\b/g;

function localTargets(src) {
  const locals = new Set();
  for (const m of src.matchAll(FOR_RE)) {
    for (const name of m[1].split(',')) locals.add(name.trim());
  }
  for (const m of src.matchAll(SET_RE)) locals.add(m[1]);
  return locals;
}

export function extractGlobals(src) {
  const text = String(src).replace(COMMENT_RE, '');
  const locals = localTargets(text);
  const found = new Set();
  for (const m of text.matchAll(DELIM_RE)) {
    const body = (m[1] ?? m[2] ?? '').replace(STRING_RE, "''");
    for (const im of body.matchAll(IDENT_RE)) {
      const name = im[1];
      if (KEYWORDS.has(name)) continue;
      if (CONTEXT_LOCALS.has(name)) continue;
      if (locals.has(name)) continue;
      found.add(name);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Core check. Pure: given the registered filter/global NAME sets and the template
// sources (a list of { file, src }), return the constructs each source uses that
// are NOT in the registered union. The available filter set is the registered set
// (which, from a real env, already includes every Nunjucks built-in); the available
// global set is the registered globals (built-in cycler/joiner/range included).
//
//   checkHublParity({ registeredFilters, registeredGlobals, sources }) ->
//     { missingFilters: [{ file, name }], missingGlobals: [{ file, name }] }
// ---------------------------------------------------------------------------
export function checkHublParity({ registeredFilters, registeredGlobals, sources }) {
  const filters = registeredFilters instanceof Set ? registeredFilters : new Set(registeredFilters);
  const globals = registeredGlobals instanceof Set ? registeredGlobals : new Set(registeredGlobals);
  const missingFilters = [];
  const missingGlobals = [];
  for (const { file, src } of sources) {
    for (const name of extractFilters(src)) {
      if (!filters.has(name)) missingFilters.push({ file, name });
    }
    for (const name of extractGlobals(src)) {
      if (!globals.has(name)) missingGlobals.push({ file, name });
    }
  }
  return { missingFilters, missingGlobals };
}

// ---------------------------------------------------------------------------
// Format the actionable error message build-static throws. Names every missing
// construct, the file it appears in, and points at render.mjs::makeEnv.
// ---------------------------------------------------------------------------
export function formatParityError({ missingFilters, missingGlobals }) {
  const lines = ['HubL parity check failed: the static render env (src/lib/render.mjs) is missing constructs these templates use.'];
  if (missingFilters.length) {
    lines.push('', 'Missing FILTERS (register with env.addFilter in makeEnv):');
    for (const { file, name } of missingFilters) lines.push(`  | ${name}   used in ${file}`);
  }
  if (missingGlobals.length) {
    lines.push('', 'Missing GLOBALS/functions (register with env.addGlobal in makeEnv):');
    for (const { file, name } of missingGlobals) lines.push(`  ${name}   used in ${file}`);
  }
  lines.push('', 'Add the missing construct(s) to makeEnv() in src/lib/render.mjs, then rebuild.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Filesystem + env-reflection driver (the impure shell over the pure core above).
// Collects every .html under templates/ and modules/ and reflects the registered
// filter/global NAMES off a REAL env — env.filters / env.globals on a Nunjucks
// Environment already hold the built-ins PLUS everything makeEnv registered, so the
// available sets stay in sync with render.mjs automatically (no second hardcoded
// list to drift). preprocessHubl is applied to each source so the scanned bytes are
// exactly what Nunjucks will compile.
// ---------------------------------------------------------------------------

// Gather { file, src } for every .html under the given dirs (recursive). Missing
// dirs are skipped (a site may ship no modules/). Synchronous to match makeEnv's
// loader and keep the guard a simple pre-pass.
export function collectTemplateSources(dirs, { readFileSync, readdirSync, statSync, join, relativeTo }) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith('.html')) {
        out.push({ file: relativeTo ? relativeTo(full) : full, src: readFileSync(full, 'utf8') });
      }
    }
  };
  for (const d of dirs) walk(d);
  return out;
}

export { CONTEXT_LOCALS, KEYWORDS };
