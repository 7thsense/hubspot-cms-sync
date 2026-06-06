#!/usr/bin/env node
// scripts/corpus-scan.mjs — CORPUS SCAN: guards the committed canonical content tree
// against NON-PORTABLE values that would break a push into a fresh HubSpot account.
//
// Stage 1-3 (sync/lib/refs.mjs) canonicalize per-account ids into LOGICAL tokens
// (@form / @cta / @asset / @menu / @portal) on pull, and resolve() injects the target
// account's ids on push — HARD-FAILING if a token has no target mapping. That round-trip
// only holds if the committed tree contains tokens, not raw ids. This scanner is the
// invariant check: it walks content/** (the canonical store) plus templates/, modules/
// and js/ (which embed refs in hand-authored HubL/JS) and FLAGS every forbidden literal:
//
//   - literal portal ids            529456 (prod) / 246389711 (dev)
//   - raw form GUIDs                "form_id": "<guid>"
//   - hosted asset URLs             https://…/hubfs/<portal>/…  +  *.hubspotusercontent*
//   - hbspt.cta.load(<portal>,…)    untokenized CTA loader
//   - {{cta('<guid>')}}             untokenized CTA shortcode
//   - bare CTA GUIDs                "guid":"<guid>", cta/redirect/…, pg=<guid>, hs-cta-<guid>
//   - page / blog / module numeric ids   "id": <bigint>, contentId, etc.
//
// A line is CLEAN if the only refs on it are @logical tokens. The scan is PURE (string +
// fs walk, no API) and exported as `scan(dir)` so the node:test suite can drive it over
// deterministic fixtures rather than the live (still-dirty) tree.
//
//   node scripts/corpus-scan.mjs [dir...]   # default dirs: content templates modules js
//   exit 0 = clean, 1 = forbidden values found
//
// NOTE: today's content/ still holds ~145 raw junk pages; running the CLI documents that
// debt. The TEST uses fixtures (test/integration/corpus.test.mjs) so it stays deterministic.

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

import { KNOWN_PORTALS } from './lib/refs.mjs';

const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PORTALS = KNOWN_PORTALS.join('|'); // 529456|246389711

export const DEFAULT_DIRS = ['content', 'templates', 'modules', 'js'];
const SCAN_EXT = new Set(['.json', '.html', '.js', '.mjs', '.css', '.hubl', '.txt', '.md']);

// ---------------------------------------------------------------------------
// RULES — each has an id, a human label, and a `find(line)` that yields the
// offending substring(s). Rules describe NON-PORTABLE shapes; anything that is
// already an `@logical` token is, by construction, not matched by these.
//
// Ordering matters only for which rule "claims" a match in the report; a single
// bad substring may satisfy several rules, which is fine — we de-dupe per line by
// the matched text so a hosted-URL hit isn't double-counted as a bare-portal hit.
// ---------------------------------------------------------------------------
export const RULES = [
  {
    id: 'hosted-asset-url',
    label: 'hosted hubfs/hubspotusercontent asset URL (use @asset:<path>)',
    re: new RegExp(
      // Any HubSpot file host path shape: /hubfs/<portal>/, /hub/<portal>/hubfs/,
      // /hs-fs/hubfs/[<portal>/] (theseventhsense.com has NO portal segment), OR any
      // hubspotusercontent host. Group is the whole URL up to a delimiter.
      `https?://[a-z0-9.-]+/(?:hub/\\d{5,}/hubfs|hs-fs/hubfs(?:/\\d{5,})?|hubfs/\\d{5,})/[^"'\\\\\\s),]+` +
        `|https?://[a-z0-9.-]*hubspotusercontent[a-z0-9.-]*/[^"'\\\\\\s),]+`,
      'gi',
    ),
  },
  {
    id: 'googleusercontent-url',
    label: 'foreign googleusercontent image URL (use @asset:googleusercontent/<blob>)',
    re: new RegExp(`https?://lh[0-9]+\\.googleusercontent\\.com/[^"'\\\\\\s),]+`, 'gi'),
  },
  {
    id: 'cta-load',
    label: 'hbspt.cta.load(<portal>,…) (use hbspt.cta.load(@portal,\'@cta:key\'…))',
    re: new RegExp(`hbspt\\.cta\\.load\\(\\s*\\d{5,}\\s*,\\s*['"]${GUID}['"]`, 'gi'),
  },
  {
    id: 'cta-shortcode',
    label: "untokenized {{cta('<guid>')}} / {{ cta(\"<guid>\") }} (use {{cta('@cta:key')}})",
    re: new RegExp(`\\{\\{\\s*cta\\(\\s*['"]${GUID}['"]`, 'gi'),
  },
  {
    id: 'form-guid',
    label: 'raw form GUID in "form_id" (use @form:key)',
    re: new RegExp(`"form_id"\\s*:\\s*"${GUID}"`, 'gi'),
  },
  {
    id: 'cta-guid',
    label: 'bare CTA GUID (use @cta:key)',
    re: new RegExp(
      `(?:"guid"\\s*:\\s*"|/cta/(?:redirect|default)/\\d{5,}/|[?&]pg=|hs-cta(?:-wrapper|-img|-ie-element|-node)?-|data-hs-img-pg=")${GUID}`,
      'gi',
    ),
  },
  {
    id: 'portal-id',
    label: 'literal portal id (use @portal)',
    re: new RegExp(`\\b(?:${PORTALS})\\b`, 'g'),
  },
  {
    id: 'numeric-content-id',
    label: 'numeric page/blog/module id (canonical store must key by slug/path, not id)',
    // Long numeric ids assigned to id-bearing JSON keys. HubSpot ids are >= 10 digits;
    // we bound at 8+ to also catch shorter legacy ids while not biting small counts.
    // Match only a COMPLETE numeric id value — a quoted run of digits with the
    // closing quote right after (`"id": "4937909260"`), or an unquoted number at a
    // value boundary (`"module_id": 1730194537`). The closing-quote/boundary
    // requirement avoids false-positives on field-definition UUIDs whose all-decimal
    // 8-hex prefix would otherwise match (`"id": "85836571-317e-..."`).
    re: new RegExp(
      `"(?:id|contentId|content_id|pageId|page_id|blogId|blog_id|moduleId|module_id|parentId|parent_id|portalId|portal_id|formId|menuId|themeId|groupId)"\\s*:\\s*"?(\\d{8,})"?(?![\\d-])`,
      'g',
    ),
  },
];

// `@logical` token grammar (mirrors refs.mjs TOKEN_RE). A line carrying ONLY these
// for its identity is portable and must NOT be flagged.
const TOKEN_RE = /@(?:form|cta|menu):[A-Za-z0-9_-]+|@asset:[^\s"'\\)]+|@portal\b/g;

// ---------------------------------------------------------------------------
// scanText(text, file) -> [{ file, line, rule, match }]
// Pure: runs each rule line-by-line. A match that is wholly inside an `@logical`
// token span is ignored (defensive — tokens never contain raw ids, but e.g. an
// @asset:path could in theory embed digits). Per (line, matchText) pairs are
// de-duplicated, preferring the most specific rule (RULES order).
// ---------------------------------------------------------------------------
export function scanText(text, file = '<text>') {
  if (typeof text !== 'string' || text.length === 0) return [];
  const lines = text.split('\n');
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;

    // Spans covered by an @logical token — matches inside these are portable.
    const tokenSpans = [];
    for (const t of line.matchAll(TOKEN_RE)) tokenSpans.push([t.index, t.index + t[0].length]);
    const inToken = (start, end) =>
      tokenSpans.some(([s, e]) => start >= s && end <= e);

    const seen = new Set(); // matchText already claimed on this line (most-specific wins)
    for (const rule of RULES) {
      for (const m of line.matchAll(rule.re)) {
        const start = m.index;
        const end = start + m[0].length;
        if (inToken(start, end)) continue;
        if (seen.has(m[0])) continue;
        // For portal-id, skip a hit that is actually part of a longer match a more
        // specific rule already claimed (e.g. the portal inside a hosted URL).
        if (rule.id === 'portal-id' && [...seen].some((s) => s.includes(m[0]))) continue;
        seen.add(m[0]);
        out.push({ file, line: i + 1, rule: rule.id, label: rule.label, match: m[0] });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// walk(dir) -> [absolute file paths] of scannable files. Skips dot-dirs,
// node_modules, and the gitignored .sync-state. Pure-ish (fs reads only).
// ---------------------------------------------------------------------------
export function walk(dir) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files; // missing dir is not an error — caller passes a default set
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) files.push(...walk(full));
    else if (SCAN_EXT.has(extname(name))) files.push(full);
  }
  return files;
}

// ---------------------------------------------------------------------------
// scan(dir | [dirs]) -> { findings, files, scanned }
// Walks the given root(s), scans each file, returns all findings with paths
// relative to the first root for stable, portable output. PURE wrt API (no network).
// ---------------------------------------------------------------------------
export function scan(dirs = DEFAULT_DIRS) {
  const roots = Array.isArray(dirs) ? dirs : [dirs];
  const base = roots[0];
  const findings = [];
  const files = [];
  for (const root of roots) {
    for (const f of walk(root)) {
      files.push(f);
      let text;
      try {
        text = readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      const rel = relative(base, f) || f;
      findings.push(...scanText(text, rel.startsWith('..') ? f : rel));
    }
  }
  return { findings, files: findings.length ? [...new Set(findings.map((x) => x.file))] : [], scanned: files.length };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function main(argv) {
  const dirs = argv.length ? argv : DEFAULT_DIRS;
  const { findings, scanned } = scan(dirs);
  if (!findings.length) {
    console.log(`corpus-scan: clean — ${scanned} file(s) scanned, 0 non-portable values.`);
    return 0;
  }
  // Group by file for a readable file:match list.
  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  const byRule = new Map();
  for (const f of findings) byRule.set(f.rule, (byRule.get(f.rule) || 0) + 1);

  console.error(`corpus-scan: FAIL — ${findings.length} non-portable value(s) in ${byFile.size} file(s) (${scanned} scanned).\n`);
  for (const [file, hits] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.error(`${file}  (${hits.length})`);
    for (const h of hits.slice(0, 50)) {
      console.error(`  L${h.line}  ${h.rule}: ${h.match}`);
    }
    if (hits.length > 50) console.error(`  …and ${hits.length - 50} more`);
  }
  console.error('\nby rule:');
  for (const [rule, n] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
    console.error(`  ${rule}: ${n}`);
  }
  return 1;
}

// ESM entry guard.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
