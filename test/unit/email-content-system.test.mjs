import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as nodeFs from 'node:fs';

import { validateManifest } from '../../src/manifest.mjs';
import { buildEmailPushPayload, canonicalEmail } from '../../src/lib/email-canonical.mjs';
import { emptyRegistry } from '../../src/lib/refs.mjs';
import { preflightRefs } from '../../src/push.mjs';
import { isThemePath } from '../../src/adapters/theme.mjs';
import { importBeefreeFromFile } from '../../src/email-import.mjs';
import { stableStringify } from '../../src/lib/canonical.mjs';

function fixture(name) {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'fixtures', name), 'utf8'),
  );
}

function scaffoldSite(dir, { withBlocks = true, withAssets = true } = {}) {
  const contentDir = join(dir, 'content');
  const blocksDir = join(contentDir, 'emails', 'blocks');
  const campaignsDir = join(contentDir, 'emails', 'campaigns');
  const assetsDir = join(contentDir, 'assets');
  mkdirSync(blocksDir, { recursive: true });
  mkdirSync(campaignsDir, { recursive: true });
  mkdirSync(join(dir, 'email-templates'), { recursive: true });
  if (withAssets) {
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, 'seventh-sense-logo.jpg'), 'fake-logo-bytes');
  }

  if (withBlocks) {
    writeFileSync(
      join(blocksDir, 'logo.json'),
      readFileSync(join(import.meta.dirname, '..', 'fixtures', 'emails', 'blocks', 'logo.json')),
    );
    writeFileSync(
      join(blocksDir, 'footer-can-spam.json'),
      readFileSync(join(import.meta.dirname, '..', 'fixtures', 'emails', 'blocks', 'footer-can-spam.json')),
    );
  }

  const manifest = {
    theme: { name: 'seventh-sense-theme' },
    pages: [{ slug: '', templatePath: 'seventh-sense-theme/templates/home.html', desiredState: 'publish' }],
    blog: { slug: 'blog', itemTemplate: 't.html', listingTemplate: 'b.html' },
    forms: [],
    uiGated: [],
    emailTemplates: [
      {
        key: 'monthly-roundup',
        path: 'seventh-sense-theme/email-templates/monthly-roundup.html',
        verified: true,
      },
    ],
    emailBlocks: [{ key: 'logo' }, { key: 'footer-can-spam' }],
    emails: [
      {
        key: 'inside-insights-2026-07',
        desiredState: 'draft',
        templatePath: 'seventh-sense-theme/email-templates/monthly-roundup.html',
        blocks: ['logo', 'footer-can-spam'],
        ctaPolicy: 'fail',
      },
      {
        key: 'onboarding-step-1',
        desiredState: 'workflow',
        templatePath: 'seventh-sense-theme/email-templates/monthly-roundup.html',
        blocks: ['logo'],
        workflow: { sequence: 'onboarding', step: 1, attachManually: true },
      },
    ],
  };
  writeFileSync(join(dir, 'site.manifest.json'), stableStringify(manifest));

  const schema = join(import.meta.dirname, '..', 'fixtures', 'beefree', 'inside-insights.simple.json');
  importBeefreeFromFile(schema, {
    key: 'inside-insights-2026-07',
    templateKey: 'monthly-roundup',
    root: dir,
    write: true,
  });

  writeFileSync(
    join(campaignsDir, 'onboarding-step-1.json'),
    stableStringify({
      key: 'onboarding-step-1',
      name: 'Onboarding Step 1',
      subject: 'Welcome',
      type: 'AUTOMATED_EMAIL',
      content: {
        templatePath: 'seventh-sense-theme/email-templates/monthly-roundup.html',
        widgets: { hs_email_body: { body: { html: '<p>Welcome {{ contact.firstname }}</p>' } } },
      },
      from: { fromName: 'Seventh Sense', replyTo: 'hello@example.com' },
    }),
  );

  return { contentDir, manifest };
}

test('validateManifest accepts emailTemplates, emailBlocks, workflow emails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'email-sys-'));
  try {
    const { manifest } = scaffoldSite(dir);
    assert.doesNotThrow(() => validateManifest(manifest));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateManifest rejects workflow without workflow object', () => {
  const m = {
    theme: { name: 't' },
    pages: [],
    blog: { slug: 'b', itemTemplate: 'a', listingTemplate: 'b' },
    forms: [],
    uiGated: [],
    emails: [{ key: 'x', desiredState: 'workflow' }],
  };
  assert.throws(() => validateManifest(m), /requires a workflow object/);
});

test('buildEmailPushPayload merges blocks and uses committed template shell', () => {
  const dir = mkdtempSync(join(tmpdir(), 'email-sys-'));
  try {
    const { contentDir, manifest } = scaffoldSite(dir);
    const entry = manifest.emails[0];
    const canon = JSON.parse(
      readFileSync(join(contentDir, 'emails', 'campaigns', 'inside-insights-2026-07.json'), 'utf8'),
    );
    const registry = emptyRegistry('246389711');
    registry.assets['seventh-sense-logo.jpg'] = 'https://example.com/logo.jpg';

    const body = buildEmailPushPayload(canon, {
      templatePaths: {},
      registry,
      manifestEntry: entry,
      contentDir,
      fs: nodeFs,
    });

    assert.equal(
      body.content.templatePath,
      'seventh-sense-theme/email-templates/monthly-roundup.html',
    );
    assert.ok(body.content.widgets.logo_image);
    assert.ok(body.content.widgets.email_can_spam);
    assert.ok(body.content.widgets.hs_email_body);
    assert.ok(body.content.flexAreas?.main?.sections?.length >= 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workflow email push is not blocked by AUTOMATED_EMAIL type', () => {
  const dir = mkdtempSync(join(tmpdir(), 'email-sys-'));
  try {
    const { contentDir, manifest } = scaffoldSite(dir);
    const entry = manifest.emails[1];
    const canon = JSON.parse(
      readFileSync(join(contentDir, 'emails', 'campaigns', 'onboarding-step-1.json'), 'utf8'),
    );
    const registry = emptyRegistry('246389711');
    registry.assets['seventh-sense-logo.jpg'] = 'https://example.com/logo.jpg';
    const body = buildEmailPushPayload(canon, {
      templatePaths: {},
      registry,
      manifestEntry: entry,
      contentDir,
      fs: nodeFs,
    });
    assert.equal(body.name, 'Onboarding Step 1');
    assert.ok(body.content.widgets.logo_image);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preflightRefs passes for manifest-scoped email site with blocks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'email-sys-'));
  try {
    const { contentDir } = scaffoldSite(dir);
    const config = {
      manifestFilePath: join(dir, 'site.manifest.json'),
    };
    const { scanned } = preflightRefs(contentDir, { fs: nodeFs, config, scope: 'manifest-emails' });
    assert.ok(scanned.length >= 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preflightRefs fails when referenced block file is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'email-sys-'));
  try {
    const { contentDir } = scaffoldSite(dir, { withBlocks: false });
    const config = { manifestFilePath: join(dir, 'site.manifest.json') };
    assert.throws(
      () => preflightRefs(contentDir, { fs: nodeFs, config, scope: 'manifest-emails' }),
      (err) => err.message.includes('push preflight') && err.message.includes('@email-block:logo'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preflightRefs fails when committed email shell file is missing on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'email-sys-'));
  try {
    const { contentDir } = scaffoldSite(dir);
    const shellPath = join(dir, 'email-templates', 'monthly-roundup.html');
    rmSync(shellPath, { force: true });
    const config = { manifestFilePath: join(dir, 'site.manifest.json') };
    assert.throws(
      () => preflightRefs(contentDir, { fs: nodeFs, config, scope: 'manifest-emails' }),
      (err) => err.message.includes('push preflight') && err.message.includes('@email-shell:'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preflightRefs fails when block asset bytes are missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'email-sys-'));
  try {
    const { contentDir } = scaffoldSite(dir, { withAssets: false });
    const config = { manifestFilePath: join(dir, 'site.manifest.json') };
    assert.throws(
      () => preflightRefs(contentDir, { fs: nodeFs, config, scope: 'manifest-emails' }),
      (err) => err.message.includes('push preflight') && err.message.includes('@asset:seventh-sense-logo.jpg'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isThemePath includes email-templates and email-modules', () => {
  assert.equal(isThemePath('email-templates/monthly-roundup.html'), true);
  assert.equal(isThemePath('email-modules/card.module/module.html'), true);
  assert.equal(isThemePath('content/emails/blocks/logo.json'), false);
});

test('AUTOMATED pull canonical + workflow manifest still builds push payload', () => {
  const raw = fixture('emails/raw-simple-draft.json');
  const registry = emptyRegistry('529456');
  const { canon } = canonicalEmail(raw, {
    registry,
    manifestEntry: { desiredState: 'workflow', workflow: { sequence: 'x', step: 1 } },
  });
  assert.equal(canon.type, 'BATCH_EMAIL');
  const body = buildEmailPushPayload(canon, {
    templatePaths: {
      'generated-2780957793': {
        targetPath: '@hubspot/email/dnd/Start_from_scratch.html',
        verified: true,
      },
    },
    registry: emptyRegistry('246389711'),
    manifestEntry: { desiredState: 'workflow', workflow: { sequence: 'x', step: 1 } },
  });
  assert.ok(body.content.widgets.hs_email_body);
});