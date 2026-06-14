import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderPage } from '../../src/lib/render.mjs';

// @asset refs that live in the TEMPLATE (og:image, <img src>) must resolve on the
// static target — not only refs inside content fields. Pairs with the HubSpot side
// (theme adapter REF_BEARING now includes templates/*.html).
test('renderPage resolves @asset refs written directly in a template', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hcms-tpl-'));
  try {
    mkdirSync(join(dir, 'templates'));
    writeFileSync(
      join(dir, 'templates', 'p.html'),
      [
        '<meta property="og:image" content="{{ base_url }}@asset:cover.jpg" />',
        '<img src="@asset:photo.webp" />',
      ].join('\n'),
    );
    const page = {
      template: 'templates/p.html',
      route: '/x',
      title: 'X',
      htmlTitle: 'X',
      metaDescription: '',
      modules: {},
    };
    const html = renderPage(page, { siteDir: dir, site: { posts: [] }, baseUrl: 'https://www2.7thsense.io' });
    // absolute og:image (base_url + resolved asset path), relative <img> src
    assert.match(html, /content="https:\/\/www2\.7thsense\.io\/assets\/cover\.jpg"/);
    assert.match(html, /src="\/assets\/photo\.webp"/);
    assert.doesNotMatch(html, /@asset:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
