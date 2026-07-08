import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyBeefreeReplacements,
  applyBeefreeContentSpec,
} from '../../src/lib/beefree-content.mjs';

test('applyBeefreeReplacements applies ordered find/replace pairs', () => {
  const { html, applied, skipped } = applyBeefreeReplacements('Hello WORLD and WORLD', [
    { find: 'WORLD', replace: 'HubSpot' },
    { find: 'MISSING', replace: 'nope' },
  ]);
  assert.equal(html, 'Hello HubSpot and HubSpot');
  assert.equal(applied, 1);
  assert.equal(skipped.length, 1);
});

test('applyBeefreeContentSpec reads replacements array from spec object', () => {
  const out = applyBeefreeContentSpec('<p>OLD</p>', {
    replacements: [{ find: 'OLD', replace: 'NEW' }],
  });
  assert.equal(out.html, '<p>NEW</p>');
});