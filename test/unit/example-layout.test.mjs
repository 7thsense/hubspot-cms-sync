import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../src/config.mjs';
import { loadManifest } from '../../src/manifest.mjs';
import { preflightRefs } from '../../src/push.mjs';
import { readCanonicalForms } from '../../src/adapters/forms.mjs';
import { readRedirectSpecs } from '../../src/redirects.mjs';
import { scan } from '../../src/corpus-scan.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sampleRoot = join(repoRoot, 'examples', 'minimal-site');

function jsonFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) out.push(...jsonFiles(full));
    else if (name.name.endsWith('.json')) out.push(full);
  }
  return out;
}

test('examples/minimal-site is a valid content layout fixture', async () => {
  const config = await loadConfig({ root: sampleRoot });
  assert.equal(config.theme.name, 'example-theme');
  assert.equal(config.redirectsFilePath, join(sampleRoot, 'sync', 'redirects.csv'));

  const manifest = await loadManifest({ config });
  assert.deepEqual(manifest.pages.map((p) => p.slug), ['', 'about']);
  assert.deepEqual(manifest.forms, ['contact']);

  for (const page of manifest.pages) {
    const file = page.slug ? `${page.slug}.json` : 'home.json';
    assert.ok(existsSync(join(config.contentDirPath, 'pages', file)), `missing page file for ${page.slug || '(home)'}`);
    assert.ok(existsSync(join(sampleRoot, page.templatePath.replace(`${manifest.theme.name}/`, ''))));
  }
  assert.ok(existsSync(join(sampleRoot, manifest.blog.itemTemplate.replace(`${manifest.theme.name}/`, ''))));
  assert.ok(existsSync(join(sampleRoot, manifest.blog.listingTemplate.replace(`${manifest.theme.name}/`, ''))));

  for (const file of jsonFiles(sampleRoot)) {
    assert.doesNotThrow(() => JSON.parse(readFileSync(file, 'utf8')), `${file} should parse as JSON`);
  }

  const forms = readCanonicalForms(config.contentDirPath);
  assert.deepEqual(forms.map((f) => f.key), ['contact']);

  const redirects = readRedirectSpecs(config.redirectsFilePath);
  assert.deepEqual(redirects, [
    {
      routePrefix: '/old-about',
      destination: '/about',
      redirectStyle: 301,
      isOnlyAfterNotFound: false,
    },
  ]);

  const refs = preflightRefs(config.contentDirPath);
  assert.ok(refs.scanned.length > 0);

  const corpus = scan([
    config.contentDirPath,
    join(sampleRoot, 'templates'),
    join(sampleRoot, 'modules'),
    join(sampleRoot, 'js'),
    join(sampleRoot, 'css'),
  ]);
  assert.equal(corpus.findings.length, 0);
  assert.ok(corpus.scanned > 0);
});
