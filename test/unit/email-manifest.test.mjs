import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  pushEmailEntries,
  isCommittedEmailTemplatePath,
  effectiveEmailTemplatePath,
  blockKeysForEmail,
  manifestEmailBlockKeys,
} from '../../src/lib/email-manifest.mjs';

test('pushEmailEntries includes draft, draftCopy, and workflow', () => {
  const m = {
    emails: [
      { key: 'a', desiredState: 'draft' },
      { key: 'b', desiredState: 'draftCopy' },
      { key: 'c', desiredState: 'workflow', workflow: { sequence: 'onb', step: 1 } },
      { key: 'd', desiredState: 'pullOnly' },
    ],
  };
  assert.deepEqual(pushEmailEntries(m).map((e) => e.key), ['a', 'b', 'c']);
});

test('isCommittedEmailTemplatePath recognizes theme email-templates paths', () => {
  assert.equal(
    isCommittedEmailTemplatePath('seventh-sense-theme/email-templates/monthly-roundup.html'),
    true,
  );
  assert.equal(isCommittedEmailTemplatePath('@hubspot/email/dnd/Start_from_scratch.html'), false);
  assert.equal(isCommittedEmailTemplatePath('generated_layouts/123.html'), false);
});

test('effectiveEmailTemplatePath prefers manifest entry', () => {
  const canon = { content: { templatePath: '@hubspot/email/dnd/Start_from_scratch.html' } };
  const entry = { templatePath: 'seventh-sense-theme/email-templates/monthly-roundup.html' };
  assert.equal(
    effectiveEmailTemplatePath(canon, entry),
    'seventh-sense-theme/email-templates/monthly-roundup.html',
  );
});

test('blockKeysForEmail unions manifest and canon blocks', () => {
  const canon = { blocks: ['logo'] };
  const entry = { blocks: ['footer-can-spam', 'logo'] };
  assert.deepEqual(blockKeysForEmail(canon, entry).sort(), ['footer-can-spam', 'logo']);
});

test('manifestEmailBlockKeys collects global and per-email blocks', () => {
  const m = {
    emailBlocks: [{ key: 'logo' }],
    emails: [{ key: 'e1', blocks: ['footer-can-spam'] }],
  };
  assert.deepEqual([...manifestEmailBlockKeys(m)].sort(), ['footer-can-spam', 'logo']);
});