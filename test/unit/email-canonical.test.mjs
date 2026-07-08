import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from 'node:fs';
import * as nodeFs from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  emailKeyForName,
  templateMappingKeyForPath,
  assignEmailKeys,
  canonicalEmail,
  computePushBlockedReasons,
  buildEmailPushPayload,
  resolvePushTemplatePath,
  semanticEmailFingerprint,
  populateEmailRegistry,
} from '../../src/lib/email-canonical.mjs';
import { emptyRegistry, saveRegistry, loadRegistry } from '../../src/lib/refs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, '..', 'fixtures', 'emails');

function loadFixture(name) {
  return JSON.parse(readFileSync(join(FIX, name), 'utf8'));
}

test('emailKeyForName slugifies deterministically', () => {
  assert.equal(
    emailKeyForName('HubSpot On-Boarding Email 3 - Analyze List & Sorting'),
    'hubspot-on-boarding-email-3-analyze-list-sorting',
  );
});

test('templateMappingKeyForPath handles generated_layouts', () => {
  assert.equal(
    templateMappingKeyForPath('generated_layouts/4622780893.html'),
    'generated-4622780893',
  );
});

test('assignEmailKeys disambiguates collisions', () => {
  const raw = [
    { id: '1', name: 'Hello World' },
    { id: '2', name: 'Hello-World' },
  ];
  const assigned = assignEmailKeys(raw);
  assert.equal(assigned[0].key, 'hello-world');
  assert.equal(assigned[1].key, 'hello-world-2');
  assert.ok(assigned[1].collisionNote);
});

test('canonicalEmail strips read-only fields and sets pushBlockedReasons', () => {
  const raw = loadFixture('raw-simple-draft.json');
  const registry = emptyRegistry('529456');
  const { canon } = canonicalEmail(raw, { registry });
  assert.equal(canon.key, 'sample-how-to-send-your-first-email-with-hubspot');
  assert.equal(canon.templateMappingKey, 'generated-2780957793');
  assert.ok(canon.unsupported?.readOnly?.to);
  assert.ok(canon.unsupported?.readOnly?.subscriptionDetails);
  assert.ok(!('id' in canon));
  assert.ok(canon.pushBlockedReasons?.length > 0);
});

test('committed email template shell skips template-paths.json verification', () => {
  const canon = {
    key: 'roundup',
    content: { templatePath: 'seventh-sense-theme/email-templates/monthly-roundup.html', widgets: {} },
  };
  const reasons = computePushBlockedReasons(canon, {
    manifestEntry: {
      desiredState: 'draft',
      templatePath: 'seventh-sense-theme/email-templates/monthly-roundup.html',
    },
    templatePaths: {},
  });
  assert.equal(reasons.length, 0);
});

test('draftCopy skips read-only to blocker and native @hubspot template mapping', () => {
  const canon = {
    key: 'nurture',
    name: 'Nurture',
    type: 'AUTOMATED_EMAIL',
    templateMappingKey: 'hubspot-start-from-scratch',
    content: { templatePath: '@hubspot/email/dnd/Start_from_scratch.html', widgets: {} },
    unsupported: { readOnly: { to: { contactLists: { include: [1] } } } },
  };
  const reasons = computePushBlockedReasons(canon, {
    manifestEntry: { desiredState: 'draftCopy' },
    templatePaths: {},
  });
  assert.equal(reasons.length, 0);
});

test('buildEmailPushPayload merges blocks when contentDir provided', () => {
  const dir = mkdtempSync(join(tmpdir(), 'email-payload-blocks-'));
  const contentDir = join(dir, 'content');
  const blocksDir = join(contentDir, 'emails', 'blocks');
  mkdirSync(blocksDir, { recursive: true });
  writeFileSync(
    join(blocksDir, 'logo.json'),
    JSON.stringify({ widgetName: 'logo_image', widget: { type: 'logo', body: { src: '@asset:logo.jpg' } } }),
  );
  try {
    const canon = {
      key: 'c',
      name: 'Campaign',
      subject: 'Subj',
      from: { fromName: '', replyTo: '' },
      content: {
        templatePath: 'seventh-sense-theme/email-templates/monthly-roundup.html',
        widgets: { hs_email_body: { body: { html: '<p>Body</p>' } } },
      },
    };
    const registry = emptyRegistry('246389711');
    registry.assets['logo.jpg'] = 'https://cdn.example/logo.jpg';
    const body = buildEmailPushPayload(canon, {
      templatePaths: {},
      registry,
      manifestEntry: { desiredState: 'draft', blocks: ['logo'] },
      contentDir,
      fs: nodeFs,
    });
    assert.ok(body.content.widgets.logo_image);
    assert.ok(body.content.widgets.hs_email_body);
    assert.equal(body.content.widgets.hs_email_body.type, 'module');
    assert.ok(body.content.widgets.hs_email_body.order > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildEmailPushPayload resolves verified generated_layouts mapping', () => {
  const raw = loadFixture('raw-simple-draft.json');
  const templatePaths = {
    'generated-2780957793': {
      sourcePath: 'generated_layouts/2780957793.html',
      targetPath: '@hubspot/email/dnd/Start_from_scratch.html',
      verified: true,
    },
  };
  const { canon } = canonicalEmail(raw, {
    templatePaths,
    registry: emptyRegistry('529456'),
    manifestEntry: { desiredState: 'draftCopy' },
  });
  const body = buildEmailPushPayload(canon, {
    templatePaths,
    registry: emptyRegistry('246389711'),
    manifestEntry: { desiredState: 'draftCopy' },
  });
  assert.equal(body.content.templatePath, '@hubspot/email/dnd/Start_from_scratch.html');
  assert.equal(resolvePushTemplatePath(canon, templatePaths), body.content.templatePath);
});

test('verified template mapping clears template blocker', () => {
  const raw = loadFixture('raw-simple-draft.json');
  const templatePaths = {
    'generated-2780957793': {
      sourcePath: 'generated_layouts/2780957793.html',
      targetPath: '@hubspot/email/dnd/Start_from_scratch.html',
      verified: true,
    },
  };
  const { canon } = canonicalEmail(raw, { templatePaths, registry: emptyRegistry('529456') });
  assert.equal(canon.content.templatePath, '@hubspot/email/dnd/Start_from_scratch.html');
  const reasons = computePushBlockedReasons(canon, { templatePaths });
  assert.ok(!reasons.some((r) => r.includes('template mapping')));
});

test('registry emails round-trip through saveRegistry', () => {
  const reg = emptyRegistry('529456');
  populateEmailRegistry(reg, [{ key: 'welcome', id: '12345' }]);
  const saved = saveRegistry(reg);
  const loaded = loadRegistry(saved);
  assert.equal(loaded.emails.welcome, '12345');
});

test('semanticEmailFingerprint is stable across re-parse', () => {
  const raw = loadFixture('raw-simple-draft.json');
  const a = canonicalEmail(raw, { registry: emptyRegistry('529456') }).canon;
  const b = canonicalEmail(raw, { registry: emptyRegistry('529456') }).canon;
  assert.equal(semanticEmailFingerprint(a), semanticEmailFingerprint(b));
});