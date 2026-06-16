// Unit tests for static-target ↔ HubSpot output parity helpers.
// HubSpot is the PRIMARY target; the static renderer must mirror the HubL templates.
// BlogPosting JSON-LD therefore lives in templates/blog-post.html (one source, both
// targets) and is rendered via the datetimeformat/escapejson HubL filters — NOT a
// build-time side-channel. These tests cover the static render of that one source.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderPost, resolveStaticRefs } from '../../src/lib/render.mjs';

test('resolveStaticRefs: @asset -> path always; @form/@portal/@cta -> ids only with a registry', () => {
  const text = 'a=@asset:logo.png p=@portal f=@form:demo c=@cta:book';
  // No registry: assets resolve, the rest are left as-is (so the gap is visible, not silent).
  assert.equal(
    resolveStaticRefs(text, { assetBase: '/assets' }),
    'a=/assets/logo.png p=@portal f=@form:demo c=@cta:book',
  );
  // With a registry: form/portal/cta resolve to the account's ids (forms POST to HubSpot).
  const registry = { portalId: '246389711', forms: { demo: 'GUID-DEMO' }, ctas: { book: 'GUID-CTA' } };
  assert.equal(
    resolveStaticRefs(text, { assetBase: '/assets', registry }),
    'a=/assets/logo.png p=246389711 f=GUID-DEMO c=GUID-CTA',
  );
});

test('resolveStaticRefs: an unmapped @form key is left intact (never a wrong id)', () => {
  const registry = { portalId: '1', forms: { demo: 'G' } };
  assert.equal(resolveStaticRefs('@form:unknown', { registry }), '@form:unknown');
});

const POST = {
  route: '/blog/spf-dkim',
  title: 'SPF, DKIM, and DMARC',
  publishDate: '2026-06-03T14:00:00Z',
  featuredImage: '/assets/cover.png',
  author: { name: 'Mike Donnelly', slug: 'mike-donnelly' },
  tags: [],
};

test('renderPost emits BlogPosting JSON-LD FROM THE TEMPLATE (one source for both targets)', () => {
  // The JSON-LD now lives in the blog-post HubL template, rendered by the static env
  // via the datetimeformat/escapejson filters — NOT injected by renderPost. A template
  // mirroring the real one proves the static render produces valid, gate-shaped JSON-LD.
  const dir = mkdtempSync(join(tmpdir(), 'parity-'));
  try {
    mkdirSync(join(dir, 'templates'));
    writeFileSync(join(dir, 'templates', 'blog-post.html'),
      '<head><script type="application/ld+json">\n{'
      + '"@context":"https://schema.org","@type":"BlogPosting",'
      + '"mainEntityOfPage":{"@type":"WebPage","@id":"{{ content.absolute_url }}"},'
      + '"headline":"{{ content.name|escapejson }}",'
      + '"datePublished":"{{ content.publish_date|datetimeformat(\'%Y-%m-%dT%H:%M:%SZ\') }}",'
      + '"dateModified":"{{ content.publish_date|datetimeformat(\'%Y-%m-%dT%H:%M:%SZ\') }}",'
      + '"author":{"@type":"Person","name":"{{ content.blog_post_author.display_name|escapejson }}"},'
      + '"publisher":{"@type":"Organization","name":"Seventh Sense"}'
      + '}\n</script>{{ standard_header_includes }}</head><body>{{ content.post_body }}</body>');
    const html = renderPost(POST, { siteDir: dir, site: { posts: [] }, baseUrl: 'https://www2.7thsense.io' });
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">\s*([\s\S]*?)<\/script>/)[1]);
    assert.equal(ld['@type'], 'BlogPosting');
    assert.equal(ld.headline, 'SPF, DKIM, and DMARC');
    assert.match(ld.datePublished, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(ld.author['@type'], 'Person');
    assert.equal(ld.author.name, 'Mike Donnelly');
    assert.equal(ld.publisher['@type'], 'Organization');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
