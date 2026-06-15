// Unit tests for static-target ↔ HubSpot output parity helpers.
// buildBlogPostingLd replicates the BlogPosting JSON-LD HubSpot auto-injects, so the
// static target carries the same {BlogPosting, Person(author), Organization(publisher)}
// structured data the schema gate requires.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildBlogPostingLd, renderPost, resolveStaticRefs } from '../../src/lib/render.mjs';

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

test('buildBlogPostingLd: emits BlogPosting + Person author + Organization publisher (schema-gate types)', () => {
  const html = buildBlogPostingLd(POST, { baseUrl: 'https://www2.7thsense.io' });
  assert.match(html, /^<script type="application\/ld\+json">/);
  const ld = JSON.parse(html.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''));
  assert.equal(ld['@type'], 'BlogPosting');
  assert.equal(ld['@context'], 'https://schema.org');
  assert.equal(ld.author['@type'], 'Person');
  assert.equal(ld.author.name, 'Mike Donnelly');
  assert.equal(ld.author.url, 'https://www2.7thsense.io/blog/author/mike-donnelly');
  assert.equal(ld.publisher['@type'], 'Organization');
  assert.equal(ld.mainEntityOfPage['@id'], 'https://www2.7thsense.io/blog/spf-dkim');
  assert.equal(ld.headline, 'SPF, DKIM, and DMARC');
  assert.equal(ld.datePublished, '2026-06-03T14:00:00Z');
  assert.deepEqual(ld.image, ['https://www2.7thsense.io/assets/cover.png']);
});

test('buildBlogPostingLd: no author -> still valid BlogPosting (Organization publisher present)', () => {
  const ld = JSON.parse(
    buildBlogPostingLd({ route: '/blog/x', title: 'X' }, { baseUrl: 'https://x.io' })
      .replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''),
  );
  assert.equal(ld['@type'], 'BlogPosting');
  assert.equal(ld.publisher['@type'], 'Organization');
  assert.ok(!('author' in ld));
  assert.ok(!('image' in ld));
});

test('renderPost injects the BlogPosting JSON-LD into the head (standard_header_includes slot)', () => {
  // A minimal template that echoes the head-includes slot.
  const dir = mkdtempSync(join(tmpdir(), 'parity-'));
  try {
    mkdirSync(join(dir, 'templates'));
    writeFileSync(join(dir, 'templates', 'blog-post.html'), '<head>{{ standard_header_includes }}</head><body>{{ content.post_body }}</body>');
    const html = renderPost(POST, { siteDir: dir, site: { posts: [] }, baseUrl: 'https://www2.7thsense.io' });
    assert.match(html, /<script type="application\/ld\+json">/);
    assert.match(html, /"@type":"BlogPosting"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
