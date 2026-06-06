// Unit tests for sync/cta-inventory.mjs — pure helpers + the resolution path with a
// mocked fetch (no network).  node --test test/unit
//
// Covers: CTA guid enumeration across every embed shape; destination extraction from
// the cta-redirect interstitial; embed -> portable <a> link resolution from a mocked
// inventory; unknown/still-tracked CTAs PRESERVED + noted (never silently dropped);
// resolveCta against a mocked fetch (interstitial body + 3xx Location forms).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ctaGuidsInText,
  extractRedirectUrl,
  ctaNameFromEmbed,
  resolveCtaEmbeds,
  buildResolvedLink,
  resolveCta,
} from '../../src/cta-inventory.mjs';

const GUID = 'bd6d5c26-d90d-4350-befe-41d8b8be2f8c';

// The exact legacy embed shape found in the corpus (agency-thank-you.json).
const EMBED =
  `<!--HubSpot Call-to-Action Code --><span class="hs-cta-wrapper" id="hs-cta-wrapper-${GUID}">` +
  `<span class="hs-cta-node hs-cta-${GUID}" id="hs-cta-${GUID}">` +
  `<!--[if lte IE 8]><div id="hs-cta-ie-element"></div><![endif]-->` +
  `<a href="https://cta-redirect.hubspot.com/cta/redirect/529456/${GUID}"  target="_blank" >` +
  `<img class="hs-cta-img" id="hs-cta-img-${GUID}" style="border-width:0px;" ` +
  `src="https://no-cache.hubspot.com/cta/default/529456/${GUID}.png"  alt="Schedule a Time Now"/></a></span>` +
  `<script charset="utf-8" src="https://js.hscta.net/cta/current.js"></script>` +
  `<script type="text/javascript"> hbspt.cta.load(529456, '${GUID}', {}); </script>` +
  `</span><!-- end HubSpot Call-to-Action Code -->`;

// ── ctaGuidsInText: every shape, deduped ────────────────────────────────────────

test('ctaGuidsInText finds the guid across all embed shapes, deduped', () => {
  assert.deepEqual(ctaGuidsInText(EMBED), [GUID]);
});

test('ctaGuidsInText finds {{cta(...)}} and hbspt.cta.load shortcodes', () => {
  assert.deepEqual(ctaGuidsInText(`a {{ cta('${GUID}') }} b`), [GUID]);
  assert.deepEqual(ctaGuidsInText(`hbspt.cta.load(529456,"${GUID}",{})`), [GUID]);
});

test('ctaGuidsInText returns [] when there is no CTA and on empty input', () => {
  assert.deepEqual(ctaGuidsInText('no cta here, just the word predictable'), []);
  assert.deepEqual(ctaGuidsInText(''), []);
  assert.deepEqual(ctaGuidsInText(null), []);
});

// ── extractRedirectUrl: the interstitial's JS var ───────────────────────────────

test('extractRedirectUrl reads the JS redirectUrl variable from the interstitial', () => {
  const html = `<html><script>var referrer = ""; var redirectUrl = "https://www.theseventhsense.com/request-demo/";\nwindow.location.href = redirectUrl;</script></html>`;
  assert.equal(extractRedirectUrl(html), 'https://www.theseventhsense.com/request-demo/');
});

test('extractRedirectUrl decodes HTML entities and falls back to meta refresh / window.location', () => {
  assert.equal(
    extractRedirectUrl('var redirectUrl = "https://x.com/a?b=1&amp;c=2";'),
    'https://x.com/a?b=1&c=2',
  );
  assert.equal(
    extractRedirectUrl('<meta http-equiv="refresh" content="0;url=https://x.com/y">'),
    'https://x.com/y',
  );
  assert.equal(extractRedirectUrl('no url at all'), null);
  assert.equal(extractRedirectUrl(''), null);
});

// ── ctaNameFromEmbed: alt text ──────────────────────────────────────────────────

test('ctaNameFromEmbed reads the img alt for the matching guid', () => {
  assert.equal(ctaNameFromEmbed(EMBED, GUID), 'Schedule a Time Now');
  assert.equal(ctaNameFromEmbed('<span>no img</span>', GUID), null);
});

// ── resolveCtaEmbeds: embed -> portable styled <a> from inventory ────────────────

test('resolveCtaEmbeds rewrites a known CTA embed to a portable <a> (no guid, no portal)', () => {
  const inv = { [GUID]: { destinationHref: 'https://www.theseventhsense.com/meetings/mike860', name: 'Schedule a Time Now', tracked: false } };
  const { text, unresolved, notes } = resolveCtaEmbeds(`<p>before</p>${EMBED}<p>after</p>`, inv);

  assert.equal(unresolved.length, 0);
  assert.equal(notes.length, 0);
  // The whole embed block is gone — no per-account guid / portal / hs-cta markup.
  assert.ok(!text.includes(GUID), 'no per-account CTA guid survives');
  assert.ok(!text.includes('529456'), 'no portal id survives');
  assert.ok(!text.includes('hs-cta-wrapper'), 'no hs-cta embed markup survives');
  assert.ok(!text.includes('hbspt.cta.load'), 'no cta.load script survives');
  // Replaced by a styled link to the real destination, preserving the alt as label.
  assert.ok(
    text.includes('<a class="btn cta-btn" href="https://www.theseventhsense.com/meetings/mike860" target="_blank" rel="noopener">Schedule a Time Now</a>'),
    `got: ${text}`,
  );
  // surrounding content preserved
  assert.ok(text.startsWith('<p>before</p>') && text.endsWith('<p>after</p>'));
});

test('resolveCtaEmbeds PRESERVES an unknown CTA raw + emits a loud note (codex: never silently drop)', () => {
  const { text, unresolved, notes } = resolveCtaEmbeds(EMBED, {}); // empty inventory
  assert.deepEqual(unresolved, [GUID]);
  assert.equal(text, EMBED, 'raw embed HTML preserved verbatim');
  assert.ok(notes.some((n) => n.includes(GUID) && /not in inventory/i.test(n) && /⚠/.test(n)), `loud note expected, got: ${JSON.stringify(notes)}`);
});

test('resolveCtaEmbeds PRESERVES a still-tracked CTA raw + notes it (codex #5: avoid analytics loss)', () => {
  const inv = { [GUID]: { destinationHref: 'https://x.com/dest', name: 'Demo', tracked: true } };
  const { text, unresolved, notes } = resolveCtaEmbeds(EMBED, inv);
  assert.deepEqual(unresolved, [GUID]);
  assert.equal(text, EMBED, 'still-tracked CTA is preserved raw, NOT link-converted');
  assert.ok(notes.some((n) => /STILL-TRACKED/i.test(n) && n.includes(GUID)), `tracked note expected, got: ${JSON.stringify(notes)}`);
});

test('resolveCtaEmbeds is a no-op on content with no CTA embed (idempotent)', () => {
  const body = '<p>just text and <a class="btn cta-btn" href="/demo">Demo</a></p>';
  const { text, unresolved, notes } = resolveCtaEmbeds(body, {});
  assert.equal(text, body);
  assert.deepEqual(unresolved, []);
  assert.deepEqual(notes, []);
});

test('buildResolvedLink escapes the href/label and honors target=_blank', () => {
  assert.equal(
    buildResolvedLink('https://x.com/a?b=1&c=2', 'Click <me>', { targetBlank: true }),
    '<a class="btn cta-btn" href="https://x.com/a?b=1&amp;c=2" target="_blank" rel="noopener">Click &lt;me&gt;</a>',
  );
  assert.equal(
    buildResolvedLink('/demo', 'Go'),
    '<a class="btn cta-btn" href="/demo">Go</a>',
  );
});

// ── resolveCta: mocked fetch (interstitial body + clean 3xx Location) ─────────────

test('resolveCta extracts the destination from the interstitial body (mocked fetch)', async () => {
  const fetchFn = async () => ({
    status: 200,
    headers: { get: () => null },
    async text() {
      return `<script>var redirectUrl = "https://www.theseventhsense.com/request-demo/";</script>`;
    },
  });
  const r = await resolveCta('529456', GUID, { fetchFn });
  assert.equal(r.destinationHref, 'https://www.theseventhsense.com/request-demo/');
  assert.equal(r.tracked, false);
});

test('resolveCta uses a clean 3xx Location header when present', async () => {
  const fetchFn = async () => ({
    status: 302,
    headers: { get: (h) => (h.toLowerCase() === 'location' ? 'https://dest.example/x' : null) },
    async text() {
      return '';
    },
  });
  const r = await resolveCta('529456', GUID, { fetchFn });
  assert.equal(r.destinationHref, 'https://dest.example/x');
  assert.equal(r.tracked, false);
});

test('resolveCta flags tracked=true when no destination can be extracted (preserve, do not drop)', async () => {
  const fetchFn = async () => ({ status: 200, headers: { get: () => null }, async text() { return '<html>nope</html>'; } });
  const r = await resolveCta('529456', GUID, { fetchFn });
  assert.equal(r.destinationHref, null);
  assert.equal(r.tracked, true);
});

test('resolveCta treats a fetch error as still-tracked (read-only, never throws upward)', async () => {
  const fetchFn = async () => { throw new Error('network down'); };
  const r = await resolveCta('529456', GUID, { fetchFn });
  assert.equal(r.destinationHref, null);
  assert.equal(r.tracked, true);
  assert.match(r.error, /network down/);
});
