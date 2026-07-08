// Unit tests for sync/lib/refs.mjs — pure, no network.
//   node --test test/unit
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REF_PATTERNS,
  KNOWN_PORTALS,
  extractRefs,
  toLogical,
  canonicalize,
  resolve,
  registerRef,
  loadRegistry,
  saveRegistry,
  emptyRegistry,
  listLogicalTokens,
} from '../../src/lib/refs.mjs';

// --- Real example strings from the corpus (codex findings #1,#2) --------------

// content/pages/home.widgets.json:743 — a raw form GUID on a page-instance widget.
const HOME_FORM_GUID = 'e6510401-3265-44d4-88d5-a3c5c4670311';
const HOME_FORM_FIELD = `"form_id": "${HOME_FORM_GUID}"`;

// content/pages/request-demo__-archived-0.json — a full CTA "cta" widget body, with
// every CTA shape: embed HTML, hbspt.cta.load, cta/redirect, pid=, {{cta(...)}},
// hosted image src, and a "guid" field. Portal is prod 529456 throughout.
const CTA_GUID = '5596b1eb-a9b1-4409-9907-7363916d850c';
const CTA_EMBED =
  '<!--HubSpot Call-to-Action Code -->\n' +
  `<span class="hs-cta-wrapper" id="hs-cta-wrapper-${CTA_GUID}">\n` +
  `    <span class="hs-cta-node hs-cta-${CTA_GUID}" id="hs-cta-${CTA_GUID}">\n` +
  `        <a href="http://cta-redirect.hubspot.com/cta/redirect/529456/${CTA_GUID}" >` +
  `<img class="hs-cta-img" id="hs-cta-img-${CTA_GUID}" style="border-width:0px;" ` +
  `src="https://no-cache.hubspot.com/cta/default/529456/${CTA_GUID}.png"  alt="Request a demo"/></a>\n` +
  '    </span>\n' +
  '    <script charset="utf-8" src="https://js.hscta.net/cta/current.js"></script>\n' +
  '    <script type="text/javascript">\n' +
  `        hbspt.cta.load(529456, '${CTA_GUID}', {});\n` +
  '    </script>\n' +
  '</span>\n';
const CTA_GUID_FIELD = `"guid": "${CTA_GUID}"`;
const CTA_TOKEN = `{{cta('${CTA_GUID}')}}`;
const CTA_PID =
  `https://cta-image-cms2.hubspot.com/ctas/v2/public/cs/il/?pg=${CTA_GUID}&pid=529456&ecid={{x}}`;

// Hosted asset URLs (request-demo archived lines 48 & 120).
const ASSET_URL_1 =
  'https://cdn2.hubspot.net/hubfs/529456/Stock%20images/Double%20exposure.jpeg';
const ASSET_URL_2 = 'https://cdn2.hubspot.net/hubfs/529456/Sucess.jpg';

// Additional hosted-URL shapes the corpus carries (codex #7). Each must fold to a
// portal-agnostic @asset:<tail> token.
const ASSET_HSFS = 'https://www.theseventhsense.com/hs-fs/hubfs/undefined-2.png'; // NO portal seg
const ASSET_HUB = 'https://cdn2.hubspot.net/hub/529456/hubfs/242k89.jpg'; // /hub/<portal>/hubfs/
const ASSET_GUC =
  'https://lh4.googleusercontent.com/HgA7k3L_TTxWDEfE3hjuNi3oIpD2F9v5K-wC3d8SE'; // foreign host

// --- Registries representing two accounts that hold the SAME logical keys ------
// "prod-like" source registry (529456) and a "dev" target (246389711). Round-trip
// requires the same logicalKey -> {rawId per account}.
function srcRegistry() {
  return loadRegistry({
    portalId: '529456',
    forms: { 'home-lead': HOME_FORM_GUID },
    ctas: { 'request-demo': CTA_GUID },
    menus: {},
    assets: {},
  });
}
function tgtRegistry() {
  return loadRegistry({
    portalId: '246389711',
    forms: { 'home-lead': 'aaaaaaaa-1111-2222-3333-444444444444' },
    ctas: { 'request-demo': 'bbbbbbbb-5555-6666-7777-888888888888' },
    menus: {},
    assets: {},
  });
}

// =============================================================================
// REF_PATTERNS / extractRefs — extract each shape
// =============================================================================

test('REF_PATTERNS.formGuid extracts the home.widgets form_id', () => {
  const refs = extractRefs(HOME_FORM_FIELD);
  const forms = refs.filter((r) => r.kind === 'formGuid');
  assert.equal(forms.length, 1);
  assert.equal(forms[0].rawId, HOME_FORM_GUID);
});

test('extractRefs finds the ctaLoad portal + guid pair', () => {
  const refs = extractRefs(`hbspt.cta.load(529456, '${CTA_GUID}', {});`);
  const load = refs.find((r) => r.kind === 'ctaLoad');
  const portal = refs.find((r) => r.kind === 'portalId');
  assert.equal(load.rawId, CTA_GUID);
  assert.equal(portal.rawId, '529456');
});

test('extractRefs finds cta guid in embed HTML, {{cta()}}, guid field and pid url', () => {
  for (const s of [CTA_EMBED, CTA_TOKEN, CTA_GUID_FIELD, CTA_PID]) {
    const refs = extractRefs(s);
    assert.ok(
      refs.some((r) => (r.kind === 'ctaGuid' || r.kind === 'ctaLoad') && r.rawId === CTA_GUID),
      `expected CTA guid in: ${s.slice(0, 40)}`,
    );
  }
});

test('extractRefs finds hubfs asset url + its portal segment', () => {
  const refs = extractRefs(ASSET_URL_2);
  const asset = refs.find((r) => r.kind === 'hubfsUrl');
  assert.equal(asset.rawId, 'Sucess.jpg');
  assert.ok(refs.some((r) => r.kind === 'portalId' && r.rawId === '529456'));
});

test('extractRefs finds the /hs-fs/hubfs/ shape (no portal segment)', () => {
  const refs = extractRefs(ASSET_HSFS);
  const asset = refs.find((r) => r.kind === 'hubfsUrl');
  assert.equal(asset.rawId, 'undefined-2.png');
  // No portal segment in this host path → no portalId ref emitted for it.
  assert.equal(refs.filter((r) => r.kind === 'portalId').length, 0);
});

test('extractRefs finds the /hub/<portal>/hubfs/ shape + its portal', () => {
  const refs = extractRefs(ASSET_HUB);
  const asset = refs.find((r) => r.kind === 'hubfsUrl');
  assert.equal(asset.rawId, '242k89.jpg');
  assert.ok(refs.some((r) => r.kind === 'portalId' && r.rawId === '529456'));
});

test('extractRefs folds a googleusercontent URL to a googleusercontent/<blob> asset', () => {
  const refs = extractRefs(ASSET_GUC);
  const asset = refs.find((r) => r.kind === 'googleUserContentUrl');
  assert.equal(asset.rawId, 'googleusercontent/HgA7k3L_TTxWDEfE3hjuNi3oIpD2F9v5K-wC3d8SE');
});

test('extractRefs finds each URL inside an HTML srcset (multiple URLs)', () => {
  const srcset = `srcset="${ASSET_URL_2} 1x, ${ASSET_HUB} 2x"`;
  const assets = extractRefs(srcset).filter((r) => r.kind === 'hubfsUrl').map((r) => r.rawId);
  assert.deepEqual(assets.sort(), ['242k89.jpg', 'Sucess.jpg']);
});

test('extractRefs finds a URL inside an inline-style url(...)', () => {
  const style = `style="background:url(${ASSET_URL_2})"`;
  const asset = extractRefs(style).find((r) => r.kind === 'hubfsUrl');
  assert.equal(asset.rawId, 'Sucess.jpg');
});

test('extractRefs finds a double-quoted / whitespace CTA shortcode', () => {
  for (const s of [`{{ cta("${CTA_GUID}") }}`, `{{cta( '${CTA_GUID}' )}}`]) {
    const refs = extractRefs(s);
    assert.ok(
      refs.some((r) => r.kind === 'ctaGuid' && r.rawId === CTA_GUID),
      `expected cta guid in: ${s}`,
    );
  }
});

test('extractRefs finds a double-quoted hbspt.cta.load', () => {
  const refs = extractRefs(`hbspt.cta.load( 529456 , "${CTA_GUID}" , {})`);
  assert.ok(refs.some((r) => r.kind === 'ctaLoad' && r.rawId === CTA_GUID));
  assert.ok(refs.some((r) => r.kind === 'portalId' && r.rawId === '529456'));
});

test('extractRefs treats the blog sourcePortal literal as a bare portal id', () => {
  const refs = extractRefs('"sourcePortal": "529456"');
  assert.ok(refs.some((r) => r.kind === 'portalId' && r.rawId === '529456'));
});

test('extractRefs finds a menu id', () => {
  const refs = extractRefs('"menu_id": 1234567');
  assert.deepEqual(
    refs.filter((r) => r.kind === 'menuId').map((r) => r.rawId),
    ['1234567'],
  );
});

test('extractRefs finds bare portal ids and recognises both known portals', () => {
  for (const p of KNOWN_PORTALS) {
    const refs = extractRefs(`pid=${p} and again ${p}`);
    assert.ok(refs.filter((r) => r.kind === 'portalId' && r.rawId === p).length >= 2);
  }
});

test('extractRefs returns [] for non-strings and empty', () => {
  assert.deepEqual(extractRefs(null), []);
  assert.deepEqual(extractRefs(''), []);
  assert.deepEqual(extractRefs(123), []);
});

// =============================================================================
// toLogical
// =============================================================================

test('toLogical maps known guids to @form:/@cta: tokens', () => {
  const reg = srcRegistry();
  assert.equal(toLogical('formGuid', HOME_FORM_GUID, reg), '@form:home-lead');
  assert.equal(toLogical('ctaGuid', CTA_GUID, reg), '@cta:request-demo');
  assert.equal(toLogical('ctaLoad', CTA_GUID, reg), '@cta:request-demo');
});

test('toLogical maps portal -> @portal and asset path -> @asset:<path>', () => {
  const reg = srcRegistry();
  assert.equal(toLogical('portalId', '529456', reg), '@portal');
  assert.equal(toLogical('hubfsUrl', 'Sucess.jpg', reg), '@asset:Sucess.jpg');
});

test('toLogical throws for an unregistered guid', () => {
  const reg = srcRegistry();
  assert.throws(() => toLogical('ctaGuid', 'deadbeef-0000-0000-0000-000000000000', reg), /no logical key/);
});

// =============================================================================
// canonicalize -> resolve round-trips to the SAME content
// =============================================================================

test('round-trip: form field canonicalizes then resolves to TARGET guid', () => {
  const src = srcRegistry();
  const tgt = tgtRegistry();
  const canon = canonicalize(HOME_FORM_FIELD, src);
  assert.equal(canon, '"form_id": "@form:home-lead"');
  const resolved = resolve(canon, tgt);
  assert.equal(resolved, '"form_id": "aaaaaaaa-1111-2222-3333-444444444444"');
});

test('round-trip: identical registries reproduce the input byte-for-byte (CTA embed)', () => {
  // Build a target whose rawIds equal the source's — round-trip must be identity.
  const src = srcRegistry();
  const sameAsSrc = loadRegistry(saveRegistry(srcRegistry())); // same portal + guids
  const canon = canonicalize(CTA_EMBED, src);
  // canonical form must contain NO raw portal id and NO raw cta guid
  assert.ok(!canon.includes('529456'), 'no raw portal id survives canon');
  assert.ok(!canon.includes(CTA_GUID), 'no raw cta guid survives canon');
  assert.ok(canon.includes('@cta:request-demo') && canon.includes('@portal'));
  const back = resolve(canon, sameAsSrc);
  assert.equal(back, CTA_EMBED);
});

test('round-trip: full mixed widget blob (embed + token + guid field + pid url + asset)', () => {
  const blob =
    `${CTA_EMBED}\n${CTA_TOKEN}\n${CTA_GUID_FIELD}\n${CTA_PID}\n` +
    `${HOME_FORM_FIELD}\n${ASSET_URL_2}\n${ASSET_URL_1}`;

  // Source registry auto-registers assets during canonicalize.
  const src = srcRegistry();
  const canon = canonicalize(blob, src);

  // Nothing per-account survives.
  assert.ok(!canon.includes('529456'));
  assert.ok(!canon.includes(CTA_GUID));
  assert.ok(!canon.includes(HOME_FORM_GUID));
  assert.ok(!canon.includes('cdn2.hubspot.net/hubfs'));
  // Logical tokens present.
  assert.ok(canon.includes('@cta:request-demo'));
  assert.ok(canon.includes('@form:home-lead'));
  assert.ok(canon.includes('@asset:Sucess.jpg'));

  // Build an identity target: copy src guids/portal AND carry concrete asset URLs so
  // @asset resolves back to the ORIGINAL hosted URLs (identity round-trip).
  const tgt = loadRegistry(saveRegistry(src));
  tgt.assets = {
    'Sucess.jpg': ASSET_URL_2,
    'Stock%20images/Double%20exposure.jpeg': ASSET_URL_1,
  };
  const back = resolve(canon, tgt);
  assert.equal(back, blob);
});

test('canonicalize folds all hosted-URL shapes to portal-agnostic @asset tokens', () => {
  const src = srcRegistry();
  const blob = [ASSET_HSFS, ASSET_HUB, ASSET_GUC].join('\n');
  const canon = canonicalize(blob, src);
  assert.ok(!canon.includes('theseventhsense.com'), 'hs-fs host gone');
  assert.ok(!canon.includes('lh4.googleusercontent.com'), 'foreign host gone');
  assert.ok(!canon.includes('529456'), 'portal segment gone from /hub/ shape');
  assert.ok(canon.includes('@asset:undefined-2.png'));
  assert.ok(canon.includes('@asset:242k89.jpg'));
  assert.ok(canon.includes('@asset:googleusercontent/HgA7k3L_TTxWDEfE3hjuNi3oIpD2F9v5K-wC3d8SE'));
});

test('round-trip: srcset with two hosted URLs canonicalizes + resolves identity', () => {
  const srcset = `srcset="${ASSET_URL_2} 1x, ${ASSET_HUB} 2x"`;
  const src = srcRegistry();
  const canon = canonicalize(srcset, src);
  assert.equal(canon, 'srcset="@asset:Sucess.jpg 1x, @asset:242k89.jpg 2x"');
  // identity target carries the original URLs back for both tails
  const tgt = loadRegistry(saveRegistry(src));
  tgt.assets = { 'Sucess.jpg': ASSET_URL_2, '242k89.jpg': ASSET_HUB };
  assert.equal(resolve(canon, tgt), srcset);
});

test('round-trip: inline-style url() canonicalizes + resolves', () => {
  const style = `style="background:url(${ASSET_URL_2})"`;
  const src = srcRegistry();
  const canon = canonicalize(style, src);
  assert.equal(canon, 'style="background:url(@asset:Sucess.jpg)"');
  const tgt = loadRegistry(saveRegistry(src));
  tgt.assets = { 'Sucess.jpg': ASSET_URL_2 };
  assert.equal(resolve(canon, tgt), style);
});

test('round-trip: double-quoted CTA shortcode + sourcePortal field', () => {
  const src = srcRegistry();
  const line = `{{ cta("${CTA_GUID}") }} "sourcePortal": "529456"`;
  const canon = canonicalize(line, src);
  assert.ok(!canon.includes(CTA_GUID));
  assert.ok(!canon.includes('529456'));
  assert.equal(canon, '{{ cta("@cta:request-demo") }} "sourcePortal": "@portal"');
  // resolve back with identity registry
  const tgt = loadRegistry(saveRegistry(src));
  assert.equal(resolve(canon, tgt), line);
});

test('canonicalize is idempotent on the new hosted/cta shapes', () => {
  const src = srcRegistry();
  const blob = `srcset="${ASSET_URL_2} 1x, ${ASSET_GUC} 2x" {{ cta("${CTA_GUID}") }} "sourcePortal":"529456"`;
  const canon = canonicalize(blob, src);
  const twice = canonicalize(canon, loadRegistry(saveRegistry(src)));
  assert.equal(twice, canon);
});

test('canonicalize is idempotent on already-canonical content', () => {
  const src = srcRegistry();
  const canon = canonicalize(CTA_EMBED, src);
  const twice = canonicalize(canon, loadRegistry(saveRegistry(src)));
  assert.equal(twice, canon);
});

// =============================================================================
// resolve THROWS on an unmapped ref (push must hard-fail)
// =============================================================================

test('resolve throws listing every unmapped logical token', () => {
  const tgt = emptyRegistry('999999'); // knows nothing
  const canon = '"form_id": "@form:home-lead" and @cta:request-demo and @menu:main';
  let err;
  try {
    resolve(canon, tgt);
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'expected resolve to throw');
  assert.match(err.message, /push must not proceed/);
  assert.match(err.message, /@cta:request-demo/);
  assert.match(err.message, /@form:home-lead/);
  assert.match(err.message, /@menu:main/);
});

test('resolve throws when @portal has no target portalId', () => {
  const tgt = { portalId: null, forms: {}, ctas: {}, menus: {}, assets: {} };
  assert.throws(() => resolve('load(@portal)', tgt), /@portal/);
});

test('resolve throws when an @asset is not registered for the target', () => {
  const tgt = tgtRegistry(); // no assets
  assert.throws(() => resolve('src="@asset:Sucess.jpg"', tgt), /@asset:Sucess\.jpg/);
});

// =============================================================================
// listLogicalTokens — corpus-test helper
// =============================================================================

test('listLogicalTokens enumerates tokens for corpus assertions', () => {
  const canon = canonicalize(`${CTA_EMBED}${HOME_FORM_FIELD}${ASSET_URL_2}`, srcRegistry());
  const toks = listLogicalTokens(canon);
  const kinds = new Set(toks.map((t) => t.kind));
  assert.ok(kinds.has('cta'));
  assert.ok(kinds.has('form'));
  assert.ok(kinds.has('asset'));
  assert.ok(kinds.has('portal'));
});

test('listLogicalTokens recognizes @email-block tokens', () => {
  const text = '{"blocks":["@email-block:logo","@email-block:footer-can-spam"]}';
  const toks = listLogicalTokens(text);
  assert.deepEqual(
    toks.filter((t) => t.kind === 'email-block').map((t) => t.key).sort(),
    ['footer-can-spam', 'logo'],
  );
});

test('registerRef mints deterministic keys and is stable on repeat', () => {
  const reg = emptyRegistry('529456');
  const k1 = registerRef(reg, 'ctaGuid', CTA_GUID);
  const k2 = registerRef(reg, 'ctaGuid', CTA_GUID);
  assert.equal(k1, k2);
  assert.equal(reg.ctas[k1], CTA_GUID);
});
