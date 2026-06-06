// Unit tests for sync/adapters/theme.mjs — pure, no real HubSpot API / no real `hs`.
//
// Covers the two codex-mandated guarantees:
//   1. canonicalization: module meta.json strips per-portal `module_id`, migrates
//      `host_template_types` -> `content_types`, and emits sorted keys (key-shuffled
//      input -> identical output).
//   2. build-tree GUID injection: pushing into a TARGET portal resolves @portal /
//      @form tokens to the TARGET's ids — asserts the target portal/guid is present
//      and the SOURCE portal/guid is never emitted; unmapped tokens hard-fail.
//
// The pull/push fs round-trip is exercised against a synthetic theme tree with `hs`
// stubbed via a fake binary on PATH, so no network and no CLI auth are touched.
//   node --test test/unit/adapter-theme.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

import {
  name,
  dependsOn,
  isThemePath,
  normalizeText,
  canonicalizeMeta,
  canonicalizeJsonText,
  canonicalizeThemeText,
  injectRefsIntoTree,
  pull,
  push,
} from '../../src/adapters/theme.mjs';
import { loadRegistry, listLogicalTokens } from '../../src/lib/refs.mjs';

// Known portals from the corpus.
const SRC_PORTAL = '529456'; // prod (read-only source)
const TGT_PORTAL = '246389711'; // dev target
const SRC_FORM_GUID = 'e6510401-3265-44d4-88d5-a3c5c4670311';
const TGT_FORM_GUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// ---------- adapter interface shape ----------

test('exports the adapter interface (name, dependsOn)', () => {
  assert.equal(name, 'theme');
  assert.ok(Array.isArray(dependsOn));
  assert.ok(dependsOn.includes('forms'), 'theme push consumes form GUIDs from the forms adapter');
});

// ---------- isThemePath: scoped-upload predicate (codex #12) ----------

test('isThemePath ACCEPTS theme dirs and the two root theme files', () => {
  for (const p of [
    'templates/page.html',
    'modules/audit-cta.module/meta.json',
    'modules/audit-cta.module/module.html',
    'css/main.css',
    'js/hs-forms.js',
    'images/logo.png',
    'theme.json',
    'fields.json',
  ]) {
    assert.equal(isThemePath(p), true, `${p} is a theme path`);
  }
});

test('isThemePath REJECTS every non-theme root (docs/sync/content/node_modules/test/.sync-state/...)', () => {
  for (const p of [
    'docs/gap-closure-plan.md',
    'sync/adapters/theme.mjs',
    'sync/push.mjs',
    'content/pages/home.widgets.json',
    'node_modules/@hubspot/cli/index.js',
    'test/unit/adapter-theme.test.mjs',
    '.sync-state/registry.json',
    '.git/config',
    'package.json', // a root file, but NOT one of THEME_FILES
    'package-lock.json',
    'README.md',
    'LICENSE.txt',
    'robots.txt',
    'sitemap.xml',
    'llms.txt',
    '.gitignore',
  ]) {
    assert.equal(isThemePath(p), false, `${p} must be excluded from the theme upload`);
  }
});

test('isThemePath does not let a near-miss prefix (cssfoo/, jsx/) leak in, and rejects escapes', () => {
  assert.equal(isThemePath('cssfoo/x'), false, 'first segment must EQUAL a theme dir, not just prefix-match');
  assert.equal(isThemePath('jsx/app.js'), false);
  assert.equal(isThemePath('templatesx/x.html'), false);
  assert.equal(isThemePath('../secrets.json'), false, 'must never escape the theme root');
  assert.equal(isThemePath(''), false);
  // normalization: leading ./ is stripped, OS-sep paths still classify correctly.
  assert.equal(isThemePath('./css/main.css'), true);
});

// ---------- normalizeText ----------

test('normalizeText strips BOM and converts CRLF/CR to LF', () => {
  assert.equal(normalizeText('﻿a\r\nb\rc'), 'a\nb\nc');
});

// ---------- canonicalizeMeta (codex #1) ----------

test('canonicalizeMeta strips module_id (per-portal diff noise)', () => {
  const out = canonicalizeMeta({
    label: 'Big stats',
    module_id: 3962035273,
    host_template_types: ['PAGE'],
    global: false,
  });
  assert.ok(!out.includes('module_id'), 'module_id must be removed');
  assert.ok(!out.includes('3962035273'), 'the per-portal id value must not survive');
});

test('canonicalizeMeta migrates host_template_types -> content_types (never both)', () => {
  const out = canonicalizeMeta({
    label: 'X',
    host_template_types: ['PAGE', 'BLOG_POST'],
  });
  const obj = JSON.parse(out);
  assert.deepEqual(obj.content_types, ['PAGE', 'BLOG_POST']);
  assert.ok(!('host_template_types' in obj), 'legacy key must be dropped');
});

test('canonicalizeMeta keeps an already-migrated content_types and drops legacy if both present', () => {
  const out = canonicalizeMeta({
    content_types: ['PAGE'],
    host_template_types: ['PAGE', 'BLOG_POST'],
  });
  const obj = JSON.parse(out);
  assert.deepEqual(obj.content_types, ['PAGE'], 'prefer the already-migrated value');
  assert.ok(!('host_template_types' in obj));
});

test('canonicalizeMeta sorts keys: shuffled input -> identical output', () => {
  const a = canonicalizeMeta({
    module_id: 1,
    label: 'A',
    is_available_for_new_content: true,
    global: false,
    host_template_types: ['PAGE'],
  });
  const b = canonicalizeMeta({
    global: false,
    host_template_types: ['PAGE'],
    label: 'A',
    is_available_for_new_content: true,
    module_id: 999, // different per-portal id, stripped either way
  });
  assert.equal(a, b, 'key order and stripped module_id make these identical');
  // Verify keys are actually sorted in the emitted text.
  const keys = JSON.parse(a);
  assert.deepEqual(Object.keys(keys), Object.keys(keys).slice().sort());
});

test('canonicalizeMeta accepts raw text with a BOM/CRLF', () => {
  const raw = '﻿{\r\n  "module_id": 5,\r\n  "label": "Z",\r\n  "host_template_types": ["PAGE"]\r\n}\r\n';
  const out = canonicalizeMeta(raw);
  const obj = JSON.parse(out);
  assert.deepEqual(obj, { label: 'Z', content_types: ['PAGE'] });
  assert.ok(out.endsWith('\n') && !out.includes('\r'));
});

// ---------- canonicalizeJsonText (fields.json / theme.json) ----------

test('canonicalizeJsonText preserves field UUIDs and values, only reorders keys', () => {
  const raw = JSON.stringify([{ name: 'x', id: 'uuid-1', type: 'text' }]);
  const out = canonicalizeJsonText(raw);
  const obj = JSON.parse(out);
  assert.equal(obj[0].id, 'uuid-1', 'UUID frozen');
  assert.deepEqual(Object.keys(obj[0]), ['id', 'name', 'type'], 'sorted');
});

// ---------- canonicalizeThemeText routing + ref logical-ization ----------

test('canonicalizeThemeText logical-izes the portal id in js/hs-forms.js', () => {
  const reg = loadRegistry({ portalId: null });
  const raw = `var PORTAL_ID = '${SRC_PORTAL}';\n`;
  const out = canonicalizeThemeText('js/hs-forms.js', raw, reg);
  assert.ok(out.includes('@portal'), 'portal id replaced with @portal token');
  assert.ok(!out.includes(SRC_PORTAL), 'raw source portal must not survive in canonical bytes');
  assert.equal(reg.portalId, SRC_PORTAL, 'source portal registered');
});

test('canonicalizeThemeText logical-izes a module form_id GUID and re-serializes JSON', () => {
  const reg = loadRegistry({ portalId: null });
  // The refs formGuid pattern matches a `"form_id": "<guid>"` property. A module that
  // carries a concrete form binding (e.g. a form_id value) is logical-ized on pull.
  const raw = JSON.stringify({ name: 'audit-cta', form_id: SRC_FORM_GUID });
  const out = canonicalizeThemeText('modules/audit-cta.module/fields.json', raw, reg);
  const tokens = listLogicalTokens(out).filter((t) => t.kind === 'form');
  assert.ok(tokens.length >= 1, 'a @form token is present');
  // The form_id binding now holds a @form token, not the raw GUID.
  assert.ok(/"form_id":\s*"@form:/.test(out), 'form_id value is a logical token');
  assert.ok(!/"form_id":\s*"e6510401/.test(out), 'raw form GUID no longer on the form_id binding');
});

test('canonicalizeThemeText leaves plain template/css text LF-clean without ref damage', () => {
  const out = canonicalizeThemeText('css/main.css', '﻿body{color:red}\r\n', loadRegistry({}));
  assert.equal(out, 'body{color:red}\n');
});

// ---------- injectRefsIntoTree (codex #2 — build-tree GUID injection) ----------

function targetRegistry() {
  return loadRegistry({
    portalId: TGT_PORTAL,
    forms: { 'audit-cta': TGT_FORM_GUID },
  });
}

test('injectRefsIntoTree injects the TARGET portal into hs-forms.js, never the source', () => {
  const reg = targetRegistry();
  const [out] = injectRefsIntoTree(
    [{ relPath: 'js/hs-forms.js', text: `var PORTAL_ID = '@portal';\n` }],
    reg,
  );
  assert.ok(out.text.includes(TGT_PORTAL), 'target portal id injected');
  assert.ok(!out.text.includes('@portal'), 'no logical token left');
  assert.ok(!out.text.includes(SRC_PORTAL), 'SOURCE portal must never appear in the build');
});

test('injectRefsIntoTree injects the TARGET form GUID into a module fields.json', () => {
  const reg = targetRegistry();
  const [out] = injectRefsIntoTree(
    [{ relPath: 'modules/audit-cta.module/fields.json', text: `{"form_id": "@form:audit-cta"}` }],
    reg,
  );
  assert.ok(out.text.includes(TGT_FORM_GUID), 'target GUID injected');
  assert.ok(!out.text.includes(SRC_FORM_GUID), 'source GUID must never appear');
  assert.ok(!out.text.includes('@form'), 'no logical token left');
});

test('injectRefsIntoTree HARD-FAILS when a referenced form has no target mapping', () => {
  const reg = loadRegistry({ portalId: TGT_PORTAL }); // no forms mapped
  assert.throws(
    () =>
      injectRefsIntoTree(
        [{ relPath: 'modules/audit-cta.module/fields.json', text: `{"form_id": "@form:audit-cta"}` }],
        reg,
      ),
    /no mapping in target portal/,
  );
});

test('injectRefsIntoTree passes non-ref-bearing files through untouched', () => {
  const reg = targetRegistry();
  const [out] = injectRefsIntoTree([{ relPath: 'css/main.css', text: 'body{color:red}\n' }], reg);
  assert.equal(out.text, 'body{color:red}\n');
});

test('injectRefsIntoTree HARD-FAILS on an unmapped @form embedded in module.html', () => {
  // module.html is ref-bearing too. A {{ ... form_id ... }} HubL binding that still
  // carries a @form token with no target mapping must hard-fail before any upload.
  const reg = loadRegistry({ portalId: TGT_PORTAL }); // no forms mapped
  assert.throws(
    () =>
      injectRefsIntoTree(
        [{ relPath: 'modules/audit-cta.module/module.html', text: `{% form form_id="@form:audit-cta" %}` }],
        reg,
      ),
    /no mapping in target portal/,
  );
});

test('injectRefsIntoTree HARD-FAILS on an unmapped @portal even when forms are mapped', () => {
  // Target has form mappings but NO portalId — an embedded @portal must still hard-fail.
  const reg = loadRegistry({ portalId: null, forms: { 'audit-cta': TGT_FORM_GUID } });
  assert.throws(
    () => injectRefsIntoTree([{ relPath: 'js/hs-forms.js', text: `var P = '@portal';\n` }], reg),
    /@portal/,
  );
});

// ---------- round-trip canonicalize -> inject reproduces the target ----------

test('canonicalize(source) then inject(target) yields the target portal end-to-end', () => {
  const src = loadRegistry({ portalId: null });
  const canon = canonicalizeThemeText('js/hs-forms.js', `var PORTAL_ID = '${SRC_PORTAL}';\n`, src);
  // canonical bytes hold @portal, not the source portal:
  assert.ok(canon.includes('@portal') && !canon.includes(SRC_PORTAL));
  // push into the target:
  const [out] = injectRefsIntoTree([{ relPath: 'js/hs-forms.js', text: canon }], targetRegistry());
  assert.equal(out.text, `var PORTAL_ID = '${TGT_PORTAL}';\n`);
});

// ---------- pull/push fs round-trip with a MOCKED Source Code API (no network) ----------

// The adapter talks ONLY to the CMS Source Code REST API now (no `hs` CLI). withFakeHs
// stubs globalThis.fetch to serve a synthetic theme for pull (GET metadata = folder /
// children; GET content = file bytes) and to capture push (PUT content) into uploadOut
// so tests can inspect exactly what bytes went on the wire. This is the synthetic theme
// `hs cms fetch` used to write — module.css/module.js are empty to exercise the adapter's
// ignore-empty logic; meta.json carries a module_id; fields.json carries a source GUID.
function syntheticTheme() {
  return {
    'modules/audit-cta.module/meta.json':
      '{\n  "module_id": 3962035273,\n  "label": "Audit CTA",\n  "host_template_types": ["PAGE"]\n}\n',
    'modules/audit-cta.module/fields.json': JSON.stringify({ name: 'audit-cta', form_id: SRC_FORM_GUID }),
    'modules/audit-cta.module/module.css': '',
    'modules/audit-cta.module/module.js': '\n',
    'js/hs-forms.js': `var PORTAL_ID = '${SRC_PORTAL}';\n`,
    'css/main.css': 'body{color:red}\r\n',
    'theme.json': '{"name":"seventh-sense-theme","label":"X"}',
  };
}

// Folder/file metadata for a theme-relative path, derived from the synthetic file set.
function metaFor(theme, rel) {
  if (rel in theme) return { folder: false };
  const prefix = rel + '/';
  const children = new Set();
  for (const k of Object.keys(theme)) {
    if (k.startsWith(prefix)) children.add(k.slice(prefix.length).split('/')[0]);
  }
  return children.size ? { folder: true, children: [...children] } : null;
}

async function withFakeHs(fn) {
  const work = mkdtempSync(join(tmpdir(), 'theme-it-'));
  const uploadOut = join(work, 'uploaded');
  const theme = syntheticTheme();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let m;
    // push: PUT content -> capture the uploaded bytes into uploadOut.
    if (opts.method === 'PUT' && (m = u.match(/\/source-code\/[^/]+\/content\/[^/]+\/(.+)$/))) {
      const dst = join(uploadOut, decodeURIComponent(m[1]));
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, Buffer.from(await opts.body.get('file').arrayBuffer()));
      return new Response('', { status: 200 });
    }
    // pull: GET metadata -> folder/children listing for the synthetic theme.
    if ((m = u.match(/\/source-code\/[^/]+\/metadata\/[^/]+\/(.+)$/))) {
      const meta = metaFor(theme, decodeURIComponent(m[1]));
      return meta ? new Response(JSON.stringify(meta), { status: 200 }) : new Response('{}', { status: 404 });
    }
    // pull: GET content -> file bytes.
    if ((m = u.match(/\/source-code\/[^/]+\/content\/[^/]+\/(.+)$/))) {
      const rel = decodeURIComponent(m[1]);
      return rel in theme ? new Response(theme[rel], { status: 200 }) : new Response('', { status: 404 });
    }
    return prevFetch(url, opts);
  };
  try {
    return await fn({ work, uploadOut });
  } finally {
    globalThis.fetch = prevFetch;
    rmSync(work, { recursive: true, force: true });
  }
}

test('pull canonicalizes a fetched theme into contentDir (module_id stripped, refs logical-ized)', async () => {
  await withFakeHs(async ({ work }) => {
    const contentDir = join(work, 'theme');
    const registry = loadRegistry({ portalId: null });
    const acct = { name: 'prod', portalId: SRC_PORTAL, key: 'k' };

    const { pulled } = await pull(acct, { contentDir, registry });
    assert.ok(pulled >= 4, 'all fetched files written');

    const meta = readFileSync(join(contentDir, 'modules/audit-cta.module/meta.json'), 'utf8');
    assert.ok(!meta.includes('module_id') && !meta.includes('3962035273'));
    assert.ok(JSON.parse(meta).content_types && !('host_template_types' in JSON.parse(meta)));

    const js = readFileSync(join(contentDir, 'js/hs-forms.js'), 'utf8');
    assert.ok(js.includes('@portal') && !js.includes(SRC_PORTAL), 'portal logical-ized on pull');

    const fields = readFileSync(join(contentDir, 'modules/audit-cta.module/fields.json'), 'utf8');
    assert.ok(!fields.includes(SRC_FORM_GUID), 'form GUID logical-ized on pull');

    const css = readFileSync(join(contentDir, 'css/main.css'), 'utf8');
    assert.ok(!css.includes('\r'), 'CRLF normalized to LF');

    assert.equal(registry.portalId, SRC_PORTAL, 'source portal registered');
  });
});

test('pull IGNORES the auto-created empty module.css/module.js (no git churn)', async () => {
  await withFakeHs(async ({ work }) => {
    const contentDir = join(work, 'theme');
    const registry = loadRegistry({ portalId: null });
    await pull({ name: 'prod', portalId: SRC_PORTAL, key: 'k' }, { contentDir, registry });

    // The fake hs emits empty module.css ('') and module.js ('\n') for the module.
    // Neither existed in the (empty) contentDir, so they must NOT be written.
    let cssExists = true, jsExists = true;
    try { readFileSync(join(contentDir, 'modules/audit-cta.module/module.css'), 'utf8'); } catch { cssExists = false; }
    try { readFileSync(join(contentDir, 'modules/audit-cta.module/module.js'), 'utf8'); } catch { jsExists = false; }
    assert.equal(cssExists, false, 'empty auto-created module.css must not be committed');
    assert.equal(jsExists, false, 'empty auto-created module.js must not be committed');
  });
});

test('pull is idempotent across runs for the empty-module-asset case (pulled count stable)', async () => {
  await withFakeHs(async ({ work }) => {
    const contentDir = join(work, 'theme');
    const reg1 = loadRegistry({ portalId: null });
    const { pulled: p1 } = await pull({ name: 'prod', portalId: SRC_PORTAL, key: 'k' }, { contentDir, registry: reg1 });
    const reg2 = loadRegistry({ portalId: null });
    const { pulled: p2 } = await pull({ name: 'prod', portalId: SRC_PORTAL, key: 'k' }, { contentDir, registry: reg2 });
    // The empty module.css/js are skipped on BOTH runs (they're never created), so the
    // pulled count does not drift — and the second pull doesn't suddenly start counting
    // them just because some other file now exists.
    assert.equal(p1, p2, 'pulled count is stable across runs (no empty-asset drift)');
  });
});

test('pull ROUND-TRIPS a module.css that already has authored content', async () => {
  await withFakeHs(async ({ work }) => {
    const contentDir = join(work, 'theme');
    const modDir = join(contentDir, 'modules/audit-cta.module');
    mkdirSync(modDir, { recursive: true });
    // Author real CSS in git before the pull. Even though the fetch returns an empty
    // module.css, the dst exists, so the ignore-empty guard must NOT apply — the fetched
    // bytes win (here: empty -> the authored content is overwritten with what HubSpot
    // returned, which is the normal pull-is-authoritative semantics). We assert the file
    // is still PRESENT (not deleted) and was treated as a normal pull (LF-normalized).
    writeFileSync(join(modDir, 'module.css'), '.audit { color: blue }\n');

    const reg = loadRegistry({ portalId: null });
    await pull({ name: 'prod', portalId: SRC_PORTAL, key: 'k' }, { contentDir, registry: reg });

    // File still exists (not skipped, because it pre-existed) and was written by pull.
    const css = readFileSync(join(modDir, 'module.css'), 'utf8');
    assert.equal(typeof css, 'string', 'pre-existing module.css is round-tripped, not skipped');
    assert.ok(!css.includes('\r'), 'pulled module.css is LF-clean');
  });
});

test('push builds a target tree and uploads target portal/GUID, never the source', async () => {
  await withFakeHs(async ({ work, uploadOut }) => {
    // First pull the source into a contentDir so we have logical-ized canonical files.
    const contentDir = join(work, 'theme');
    const srcReg = loadRegistry({ portalId: null });
    await pull({ name: 'prod', portalId: SRC_PORTAL, key: 'k' }, { contentDir, registry: srcReg });

    // Now push into the TARGET account with a target registry mapping the form.
    // The canonical form key is auto-minted on pull; read it back so the target maps it.
    const fields = readFileSync(join(contentDir, 'modules/audit-cta.module/fields.json'), 'utf8');
    const formKey = listLogicalTokens(fields).find((t) => t.kind === 'form').key;
    const tgtReg = loadRegistry({ portalId: TGT_PORTAL, forms: { [formKey]: TGT_FORM_GUID } });

    const { pushed } = await push({ name: 'dev', portalId: TGT_PORTAL, key: 'k' }, { contentDir, registry: tgtReg });
    assert.ok(pushed >= 4);

    // Inspect what was "uploaded".
    const upJs = readFileSync(join(uploadOut, 'js/hs-forms.js'), 'utf8');
    assert.ok(upJs.includes(TGT_PORTAL), 'uploaded JS carries the TARGET portal');
    assert.ok(!upJs.includes(SRC_PORTAL), 'uploaded JS must NOT carry the source portal');
    assert.ok(!upJs.includes('@portal'), 'no logical token left in upload');

    const upFields = readFileSync(join(uploadOut, 'modules/audit-cta.module/fields.json'), 'utf8');
    assert.ok(upFields.includes(TGT_FORM_GUID) && !upFields.includes(SRC_FORM_GUID));

    // meta.json in the build is still canonical (no module_id).
    const upMeta = readFileSync(join(uploadOut, 'modules/audit-cta.module/meta.json'), 'utf8');
    assert.ok(!upMeta.includes('module_id'));
  });
});

test('push build/upload tree is THEME-SCOPED: non-theme roots at the push root are never uploaded (codex #12)', async () => {
  await withFakeHs(async ({ work, uploadOut }) => {
    const contentDir = join(work, 'theme');
    const srcReg = loadRegistry({ portalId: null });
    await pull({ name: 'prod', portalId: SRC_PORTAL, key: 'k' }, { contentDir, registry: srcReg });

    // Plant non-theme content at the SAME root the push reads from. A naive `hs cms
    // upload .` (or an unscoped walk) would sweep all of these into Design Manager.
    const plant = (rel, body) => {
      const abs = join(contentDir, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, body);
    };
    plant('docs/gap-closure-plan.md', '# secret plan\n');
    plant('sync/adapters/theme.mjs', 'export const oops = 1;\n');
    plant('content/pages/home.widgets.json', '{"secret":true}');
    plant('node_modules/@hubspot/cli/index.js', 'module.exports = {};\n');
    plant('test/unit/x.test.mjs', 'test()\n');
    plant('.sync-state/registry.json', '{"portalId":"529456"}');
    plant('package.json', '{"name":"repo-root"}');
    plant('README.md', '# repo\n');

    const fields = readFileSync(join(contentDir, 'modules/audit-cta.module/fields.json'), 'utf8');
    const formKey = listLogicalTokens(fields).find((t) => t.kind === 'form').key;
    const tgtReg = loadRegistry({ portalId: TGT_PORTAL, forms: { [formKey]: TGT_FORM_GUID } });

    await push({ name: 'dev', portalId: TGT_PORTAL, key: 'k' }, { contentDir, registry: tgtReg });

    // Walk what was actually "uploaded" and assert every path is a theme path AND that
    // none of the planted non-theme files made it onto the wire.
    const seen = [];
    (function walk(dir, base = '') {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const rel = base ? `${base}/${e.name}` : e.name;
        if (e.isDirectory()) walk(join(dir, e.name), rel);
        else seen.push(rel);
      }
    })(uploadOut);

    assert.ok(seen.length > 0, 'something was uploaded');
    for (const rel of seen) {
      assert.ok(isThemePath(rel), `uploaded path must be a theme path, got non-theme: ${rel}`);
    }
    const forbidden = ['docs', 'sync', 'content', 'node_modules', 'test', '.sync-state'];
    for (const dir of forbidden) {
      assert.ok(
        !seen.some((p) => p === dir || p.startsWith(`${dir}/`)),
        `${dir}/ must never appear in the upload tree`,
      );
    }
    assert.ok(!seen.includes('package.json'), 'root package.json is not a theme file');
    assert.ok(!seen.includes('README.md'), 'root README.md is not a theme file');
    // sanity: the real theme files DID upload.
    assert.ok(seen.includes('js/hs-forms.js') && seen.includes('theme.json'));
  });
});

test('push hard-fails (no upload) when the target registry lacks a referenced form', async () => {
  await withFakeHs(async ({ work, uploadOut }) => {
    const contentDir = join(work, 'theme');
    const srcReg = loadRegistry({ portalId: null });
    await pull({ name: 'prod', portalId: SRC_PORTAL, key: 'k' }, { contentDir, registry: srcReg });

    // target portal set, but NO form mapping -> resolve() must throw before upload.
    const tgtReg = loadRegistry({ portalId: TGT_PORTAL });
    await assert.rejects(
      () => push({ name: 'dev', portalId: TGT_PORTAL, key: 'k' }, { contentDir, registry: tgtReg }),
      /no mapping in target portal/,
    );
    // nothing should have been uploaded
    let uploaded = true;
    try {
      readFileSync(join(uploadOut, 'js/hs-forms.js'), 'utf8');
    } catch {
      uploaded = false;
    }
    assert.equal(uploaded, false, 'upload must not run when injection fails');
  });
});

test('push hard-fails (no upload) on an unmapped @form embedded in a module.html', async () => {
  await withFakeHs(async ({ work, uploadOut }) => {
    const contentDir = join(work, 'theme');
    const modDir = join(contentDir, 'modules/contact.module');
    mkdirSync(modDir, { recursive: true });
    // A module.html that binds a form via a @form token (ref-bearing file #2). The
    // target maps the portal but NOT this form -> resolve() must throw BEFORE upload.
    writeFileSync(join(modDir, 'module.html'), `{% form form_id="@form:contact" %}\n`);
    writeFileSync(join(modDir, 'meta.json'), JSON.stringify({ label: 'Contact', content_types: ['PAGE'] }));

    const tgtReg = loadRegistry({ portalId: TGT_PORTAL }); // portal ok, no forms
    await assert.rejects(
      () => push({ name: 'dev', portalId: TGT_PORTAL, key: 'k' }, { contentDir, registry: tgtReg }),
      /no mapping in target portal/,
    );
    let uploaded = true;
    try { readFileSync(join(uploadOut, 'modules/contact.module/module.html'), 'utf8'); } catch { uploaded = false; }
    assert.equal(uploaded, false, 'upload must not run when a module.html @form is unmapped');
  });
});

test('push refuses when target registry has no portalId', async () => {
  await withFakeHs(async ({ work }) => {
    const contentDir = join(work, 'theme');
    await pull({ name: 'prod', portalId: SRC_PORTAL, key: 'k' }, { contentDir, registry: loadRegistry({}) });
    await assert.rejects(
      () => push({ name: 'dev', portalId: TGT_PORTAL, key: 'k' }, { contentDir, registry: loadRegistry({}) }),
      /no portalId/,
    );
  });
});
