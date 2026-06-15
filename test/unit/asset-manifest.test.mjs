import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderPage } from '../../src/lib/render.mjs';

// get_asset_url rewrites css/js refs to their content-hashed URLs via the build manifest,
// and falls back to the plain path for anything not in the manifest (e.g. images).
test('get_asset_url rewrites to hashed URLs from the asset manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hcms-manifest-'));
  try {
    mkdirSync(join(dir, 'templates'));
    writeFileSync(
      join(dir, 'templates', 'p.html'),
      [
        '<link rel="stylesheet" href="{{ get_asset_url(\'../css/main.css\') }}" />',
        '<script src="{{ get_asset_url(\'../js/app.js\') }}"></script>',
        '<img src="{{ get_asset_url(\'../images/logo.svg\') }}" />',
      ].join('\n'),
    );
    const page = { template: 'templates/p.html', route: '/x', title: 'X', htmlTitle: 'X', metaDescription: '', modules: {} };
    const html = renderPage(page, {
      siteDir: dir,
      site: { posts: [] },
      assetManifest: { 'css/main.css': '/css/main.abc1234567.css', 'js/app.js': '/js/app.def8901234.js' },
    });
    assert.match(html, /href="\/css\/main\.abc1234567\.css"/);
    assert.match(html, /src="\/js\/app\.def8901234\.js"/);
    assert.match(html, /src="\/images\/logo\.svg"/); // not in manifest -> plain path
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
