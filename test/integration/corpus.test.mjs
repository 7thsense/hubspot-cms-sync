// test/integration/corpus.test.mjs — PURE test for scripts/corpus-scan.mjs.
//
// "integration" only by directory convention; this test makes NO API calls and needs
// no network or credentials. It drives the scanner over DETERMINISTIC FIXTURES (planted
// bad samples + a clean tokenized sample) written to an os.tmpdir() scratch dir, NOT the
// live content/ tree (which still carries ~145 raw junk pages of documented debt). So it
// is stable and runs by default with `node --test`.
//
//   node --test test/integration/corpus.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { scan, scanText, RULES } from '../../src/corpus-scan.mjs';

// A real CTA guid + form guid drawn from the corpus shapes (refs.test.mjs).
const CTA_GUID = '5596b1eb-a9b1-4409-9907-7363916d850c';
const FORM_GUID = 'e6510401-3265-44d4-88d5-a3c5c4670311';

// ---------------------------------------------------------------------------
// BAD fixtures — one per forbidden shape the scanner must catch.
// ---------------------------------------------------------------------------
const BAD = {
  'bad-portal-prod.json': '{\n  "owner": "529456"\n}\n',
  'bad-portal-dev.json': '{\n  "owner": "246389711"\n}\n',
  'bad-form-guid.json': `{\n  "form_id": "${FORM_GUID}"\n}\n`,
  'bad-cta-load.html':
    `<script>hbspt.cta.load(529456, '${CTA_GUID}', {});</script>\n`,
  'bad-cta-shortcode.html': `<div>{{cta('${CTA_GUID}')}}</div>\n`,
  'bad-cta-guid.json': `{\n  "guid": "${CTA_GUID}"\n}\n`,
  'bad-cta-redirect.html':
    `<a href="http://cta-redirect.hubspot.com/cta/redirect/529456/${CTA_GUID}">x</a>\n`,
  'bad-cta-pg.html':
    `<img src="https://cta-image-cms2.hubspot.com/?pg=${CTA_GUID}&pid=529456">\n`,
  'bad-hosted-cdn.json':
    '{\n  "src": "https://cdn2.hubspot.net/hubfs/529456/Sucess.jpg"\n}\n',
  'bad-hosted-usercontent.json':
    '{\n  "src": "https://f.hubspotusercontent00.net/hubfs/529456/x.png"\n}\n',
  // /hub/<portal>/hubfs/ legacy File-Manager path shape.
  'bad-hosted-hub.json':
    '{\n  "src": "https://cdn2.hubspot.net/hub/529456/hubfs/242k89.jpg"\n}\n',
  // /hs-fs/hubfs/ shape — NO portal segment (theseventhsense.com).
  'bad-hosted-hsfs.json':
    '{\n  "src": "https://www.theseventhsense.com/hs-fs/hubfs/undefined-2.png"\n}\n',
  // foreign googleusercontent image host (Google Docs paste-in).
  'bad-hosted-guc.json':
    '{\n  "src": "https://lh4.googleusercontent.com/HgA7k3L_TTxWDEfE3hjuNi3oIpD2F9v5K"\n}\n',
  // an HTML srcset embedding two hosted URLs (both must be flagged).
  'bad-srcset.html':
    '<img srcset="https://cdn2.hubspot.net/hubfs/529456/Sucess.jpg 1x, ' +
    'https://cdn2.hubspot.net/hub/529456/hubfs/242k89.jpg 2x">\n',
  // inline-style url() wrapping a hosted URL.
  'bad-inline-url.html':
    '<div style="background:url(https://cdn2.hubspot.net/hubfs/529456/Sucess.jpg)"></div>\n',
  // double-quoted + whitespace CTA shortcode and cta.load variants.
  'bad-cta-dq-shortcode.html': `<div>{{ cta("${CTA_GUID}") }}</div>\n`,
  'bad-cta-dq-load.html': `<script>hbspt.cta.load( 529456 , "${CTA_GUID}" , {});</script>\n`,
  // the blog sourcePortal literal-portal field present in all 68 posts.
  'bad-source-portal.json': '{\n  "sourcePortal": "529456"\n}\n',
  'bad-numeric-id.json': '{\n  "id": "352733424348"\n}\n',
  'bad-content-id.json': '{\n  "contentId": 88112233445\n}\n',
};

// ---------------------------------------------------------------------------
// CLEAN fixture — fully tokenized; every identity is an @logical token. Must pass.
// Mirrors what canonicalize() produces on pull.
// ---------------------------------------------------------------------------
const CLEAN = {
  'clean-page.json':
    '{\n' +
    '  "slug": "request-demo",\n' +
    '  "form_id": "@form:home-lead",\n' +
    '  "guid": "@cta:request-demo",\n' +
    '  "hero": "@asset:Stock images/Double exposure.jpeg",\n' +
    '  "menu_id": "@menu:main",\n' +
    '  "owner": "@portal"\n' +
    '}\n',
  'clean-cta.html':
    "<span class=\"hs-cta-wrapper\">\n" +
    "  <script>hbspt.cta.load(@portal, '@cta:request-demo', {});</script>\n" +
    "  <div>{{cta('@cta:request-demo')}}</div>\n" +
    '</span>\n',
  // Tokenized forms of the new hosted/cta shapes must pass clean.
  'clean-srcset.html':
    '<img srcset="@asset:Sucess.jpg 1x, @asset:242k89.jpg 2x">\n',
  'clean-inline-url.html':
    '<div style="background:url(@asset:Sucess.jpg)"></div>\n',
  'clean-guc.json': '{\n  "src": "@asset:googleusercontent/HgA7k3L"\n}\n',
  'clean-source-portal.json': '{\n  "sourcePortal": "@portal"\n}\n',
  'clean-cta-dq.html':
    '<div>{{ cta("@cta:request-demo") }}</div>\n' +
    '<script>hbspt.cta.load(@portal, "@cta:request-demo", {});</script>\n',
  // Small numeric values that are NOT id-keyed must not trip the numeric-id rule.
  'clean-counts.json': '{\n  "limit": 25,\n  "count": 1062,\n  "order": 7\n}\n',
};

// ---------------------------------------------------------------------------
// PRODUCER / REGISTRY fixtures — files that LEGITIMATELY hold raw guids as the
// VALUES of a logical-key map (the @form/@cta producer side). These must NOT be
// flagged by the cta-guid / form-guid rules: the guid is the resolve TARGET, the
// JSON key is the logical name. Mirrors content/forms/guids.json (and a future
// content/ctas/guids.json). The cta-guid rule keys off `"guid":` / `"form_id":` /
// CTA-HTML shapes specifically, so a `"<logical-key>": "<guid>"` line is portable.
// ---------------------------------------------------------------------------
const PRODUCER = {
  // forms producer map: { "<logical key>": "<target guid>" } — exactly guids.json.
  'forms-guids.json':
    '{\n' +
    `  "demo": "${FORM_GUID}",\n` +
    '  "contact": "7c2f992a-2f7a-4c83-a981-adea6008b80c",\n' +
    `  "request-demo": "${CTA_GUID}"\n` +
    '}\n',
  // a CTA producer map of the same shape (logical key -> raw guid).
  'ctas-guids.json':
    '{\n' +
    `  "request-demo": "${CTA_GUID}",\n` +
    '  "agency-connect": "bd6d5c26-d90d-4350-befe-41d8b8be2f8c"\n' +
    '}\n',
  // a landing page already fully canonicalized — every ref is an @logical token,
  // including the CTA embed HTML and the form_id. Must be byte-portable.
  'tokenized-page.json':
    '{\n' +
    '  "slug": "agency-thank-you",\n' +
    '  "form_id": "@form:demo",\n' +
    '  "guid": "@cta:agency-connect",\n' +
    '  "embed_code": "<span class=\\"hs-cta-wrapper\\">{{cta(\'@cta:agency-connect\')}}</span>",\n' +
    '  "load": "hbspt.cta.load(@portal, \'@cta:agency-connect\', {})"\n' +
    '}\n',
};

let dir;
let badDir;
let cleanDir;
let producerDir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'corpus-scan-'));
  badDir = join(dir, 'bad');
  cleanDir = join(dir, 'clean');
  producerDir = join(dir, 'producer');
  mkdirSync(badDir, { recursive: true });
  mkdirSync(cleanDir, { recursive: true });
  mkdirSync(producerDir, { recursive: true });
  for (const [name, body] of Object.entries(BAD)) writeFileSync(join(badDir, name), body);
  for (const [name, body] of Object.entries(CLEAN)) writeFileSync(join(cleanDir, name), body);
  for (const [name, body] of Object.entries(PRODUCER)) writeFileSync(join(producerDir, name), body);
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
test('scan FLAGS every planted bad sample (at least one finding per bad file)', () => {
  const { findings } = scan(badDir);
  assert.ok(findings.length > 0, 'expected findings in the bad fixture dir');
  const flaggedFiles = new Set(findings.map((f) => f.file));
  for (const name of Object.keys(BAD)) {
    assert.ok(
      [...flaggedFiles].some((f) => f.endsWith(name)),
      `expected ${name} to be flagged; flagged: ${[...flaggedFiles].join(', ')}`,
    );
  }
});

test('every rule fires on at least one planted sample (no dead rule)', () => {
  const { findings } = scan(badDir);
  const firedRules = new Set(findings.map((f) => f.rule));
  for (const rule of RULES) {
    assert.ok(firedRules.has(rule.id), `rule '${rule.id}' never fired on the bad fixtures`);
  }
});

test('scan PASSES the clean tokenized sample (zero findings)', () => {
  const { findings } = scan(cleanDir);
  assert.deepEqual(
    findings,
    [],
    `clean fixture must be portable; got: ${findings.map((f) => `${f.file}:${f.line} ${f.rule}=${f.match}`).join(' | ')}`,
  );
});

test('producer/registry guid maps are NOT flagged as cta-guid/form-guid', () => {
  // A `{ "<logical key>": "<raw guid>" }` map (content/forms/guids.json and a
  // future content/ctas/guids.json) is the resolve TARGET side and must stay
  // clean — the raw guid is the value of an arbitrary logical key, not a
  // "guid"/"form_id" field nor a CTA-HTML shape.
  const { findings } = scan(producerDir);
  const offenders = findings.filter(
    (f) => f.file.endsWith('forms-guids.json') || f.file.endsWith('ctas-guids.json'),
  );
  assert.deepEqual(
    offenders,
    [],
    `producer guid maps must not be flagged; got: ${offenders
      .map((f) => `${f.file}:${f.line} ${f.rule}=${f.match}`)
      .join(' | ')}`,
  );
});

test('an already-tokenized landing page (CTA embed + form_id) is clean', () => {
  // The whole point of canonicalization: once @form/@cta/@portal tokens replace
  // the raw guids, the page must produce ZERO findings (idempotent / portable).
  const { findings } = scan(producerDir);
  const offenders = findings.filter((f) => f.file.endsWith('tokenized-page.json'));
  assert.deepEqual(
    offenders,
    [],
    `tokenized page must be portable; got: ${offenders
      .map((f) => `${f.file}:${f.line} ${f.rule}=${f.match}`)
      .join(' | ')}`,
  );
});

test('cta-guid / form-guid never fire on a logical-key -> raw-guid value line', () => {
  // Tighter unit-level proof of the producer-map non-match for each at-risk rule.
  const producerLines = [
    `  "demo": "${FORM_GUID}",`,
    `  "request-demo": "${CTA_GUID}",`,
    `  "contact": "7c2f992a-2f7a-4c83-a981-adea6008b80c"`,
  ];
  for (const line of producerLines) {
    const hits = scanText(line, 'guids.json');
    const bad = hits.filter((h) => h.rule === 'cta-guid' || h.rule === 'form-guid');
    assert.deepEqual(
      bad,
      [],
      `producer line wrongly flagged: ${line} -> ${bad.map((h) => h.rule).join(',')}`,
    );
  }
});

test('@logical tokens are never flagged (per-shape)', () => {
  const lines = [
    '"form_id": "@form:home-lead"',
    '"guid": "@cta:request-demo"',
    "hbspt.cta.load(@portal, '@cta:request-demo', {})",
    "{{cta('@cta:request-demo')}}",
    '"src": "@asset:Stock images/Double exposure.jpeg"',
    '"src": "@asset:googleusercontent/HgA7k3L"',
    'srcset="@asset:Sucess.jpg 1x, @asset:242k89.jpg 2x"',
    'style="background:url(@asset:Sucess.jpg)"',
    '{{ cta("@cta:request-demo") }}',
    '"menu_id": "@menu:main"',
    '"sourcePortal": "@portal"',
    '"owner": "@portal"',
  ];
  for (const line of lines) {
    assert.deepEqual(scanText(line, 'x'), [], `tokenized line should be clean: ${line}`);
  }
});

test('specific shapes map to specific rules', () => {
  const cases = [
    [`{ "form_id": "${FORM_GUID}" }`, 'form-guid'],
    [`hbspt.cta.load(529456, '${CTA_GUID}', {})`, 'cta-load'],
    [`{{cta('${CTA_GUID}')}}`, 'cta-shortcode'],
    [`{ "guid": "${CTA_GUID}" }`, 'cta-guid'],
    ['"src": "https://cdn2.hubspot.net/hubfs/529456/Sucess.jpg"', 'hosted-asset-url'],
    ['"src": "https://f.hubspotusercontent00.net/hubfs/529456/x.png"', 'hosted-asset-url'],
    ['"src": "https://cdn2.hubspot.net/hub/529456/hubfs/242k89.jpg"', 'hosted-asset-url'],
    ['"src": "https://www.theseventhsense.com/hs-fs/hubfs/undefined-2.png"', 'hosted-asset-url'],
    ['"src": "https://lh4.googleusercontent.com/HgA7k3L"', 'googleusercontent-url'],
    [`{{ cta("${CTA_GUID}") }}`, 'cta-shortcode'],
    [`hbspt.cta.load( 529456 , "${CTA_GUID}" , {})`, 'cta-load'],
    ['{ "sourcePortal": "529456" }', 'portal-id'],
    ['{ "owner": "529456" }', 'portal-id'],
    ['{ "id": "352733424348" }', 'numeric-content-id'],
  ];
  for (const [line, rule] of cases) {
    const hits = scanText(line, 'x');
    assert.ok(
      hits.some((h) => h.rule === rule),
      `expected rule '${rule}' for: ${line}; got: ${hits.map((h) => h.rule).join(',') || '(none)'}`,
    );
  }
});

test('a bare portal id inside a hosted URL is not double-counted as portal-id', () => {
  const hits = scanText('"src": "https://cdn2.hubspot.net/hubfs/529456/Sucess.jpg"', 'x');
  // The hosted-asset-url rule claims the whole URL (which contains 529456); the
  // portal-id rule must not separately re-flag that same embedded portal.
  assert.equal(hits.filter((h) => h.rule === 'portal-id').length, 0);
  assert.equal(hits.filter((h) => h.rule === 'hosted-asset-url').length, 1);
});

test('scan(dir) reports paths relative to the scanned root and a scanned count', () => {
  const res = scan(badDir);
  assert.ok(res.scanned >= Object.keys(BAD).length, 'scanned count should cover all bad files');
  assert.ok(res.findings.every((f) => !f.file.startsWith('/')), 'paths should be root-relative');
});

test('scan tolerates a missing directory (returns empty, no throw)', () => {
  const res = scan(join(dir, 'does-not-exist'));
  assert.deepEqual(res.findings, []);
  assert.equal(res.scanned, 0);
});
