import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeEnv } from '../../src/lib/render.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const siteDir = join(repoRoot, 'examples', 'minimal-site');

test('base_url global exposes the build baseUrl for absolute URLs (e.g. og:image)', () => {
  const env = makeEnv(siteDir, { site: { posts: [] }, opts: { baseUrl: 'https://www2.7thsense.io' } });
  assert.equal(env.renderString('{{ base_url }}', {}), 'https://www2.7thsense.io');
  assert.equal(
    env.renderString("{{ base_url }}/assets/cover.jpg", {}),
    'https://www2.7thsense.io/assets/cover.jpg',
  );
});

test('base_url defaults to empty string when baseUrl is unset (HubSpot target → root-relative)', () => {
  const env = makeEnv(siteDir, { site: { posts: [] }, opts: {} });
  assert.equal(env.renderString('{{ base_url }}/assets/cover.jpg', {}), '/assets/cover.jpg');
});
