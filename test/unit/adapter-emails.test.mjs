import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { name, dependsOn, pull, push } from '../../src/adapters/emails.mjs';
import { canonicalEmail } from '../../src/lib/email-canonical.mjs';
import { emptyRegistry } from '../../src/lib/refs.mjs';
import { saveRegistry, loadRegistry } from '../../src/lib/refs.mjs';
import { persistAccountRegistry, loadAccountRegistry } from '../../src/lib/sync-state.mjs';
import { stableStringify } from '../../src/lib/canonical.mjs';

const ACCT = { name: 'prod', portalId: '529456', key: 'pat-test' };

function loadFixture(name) {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'fixtures', 'emails', name), 'utf8'),
  );
}

function mockHub(emails) {
  return async (acct, method, path) => {
    if (method === 'GET' && path.startsWith('/marketing/v3/emails')) {
      return { ok: true, status: 200, json: { results: emails, total: emails.length } };
    }
    return { ok: false, status: 404, json: {} };
  };
}

test('adapter exports expected contract', () => {
  assert.equal(name, 'emails');
  assert.deepEqual(dependsOn, ['assets']);
});

test('pull writes canonical files and persists registry.emails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'emails-pull-'));
  const syncDir = join(dir, '.sync-state');
  const config = {
    root: dir,
    contentDirPath: join(dir, 'content'),
    syncStateDirPath: syncDir,
    manifestFilePath: join(dir, 'site.manifest.json'),
  };
  const registry = emptyRegistry(ACCT.portalId);
  const raw = loadFixture('raw-simple-draft.json');

  try {
    const result = pull(ACCT, {
      contentDir: config.contentDirPath,
      registry,
      config,
      hub: mockHub([raw]),
      pullAllEmails: true,
    });
    return result.then((r) => {
      assert.equal(r.pulled, 1);
      const emailDir = join(config.contentDirPath, 'emails');
      const files = readdirSync(emailDir).filter((f) => f.endsWith('.json'));
      assert.ok(files.some((f) => f.includes('sample-how-to-send')));
      assert.equal(registry.emails[Object.keys(registry.emails)[0]], '2780958283');
      persistAccountRegistry(ACCT.portalId, registry, config);
      const reloaded = loadAccountRegistry(ACCT.portalId, config);
      assert.equal(
        reloaded.emails[Object.keys(registry.emails)[0]],
        '2780958283',
      );
      assert.ok(existsSync(join(emailDir, 'template-paths.json')));
      assert.ok(existsSync(join(emailDir, 'subscriptions.json')));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pull skips all emails when manifest has no emails[] and pullAll is false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'emails-skip-'));
  const config = {
    root: dir,
    contentDirPath: join(dir, 'content'),
    syncStateDirPath: join(dir, '.sync-state'),
    manifestFilePath: join(dir, 'site.manifest.json'),
  };
  writeFileSync(
    config.manifestFilePath,
    JSON.stringify({ theme: { name: 't' }, pages: [], blog: { slug: 'b', itemTemplate: 'a', listingTemplate: 'b' }, forms: [], uiGated: [] }),
  );
  const registry = emptyRegistry(ACCT.portalId);
  const raw = loadFixture('raw-simple-draft.json');
  try {
    const r = await pull(ACCT, {
      contentDir: config.contentDirPath,
      registry,
      config,
      hub: mockHub([raw]),
      pullAllEmails: false,
    });
    assert.equal(r.pulled, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('push creates manifest draftCopy emails and registers ids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'emails-push-'));
  const contentDir = join(dir, 'content');
  const emailsDir = join(contentDir, 'emails');
  const config = {
    root: dir,
    contentDirPath: contentDir,
    manifestFilePath: join(dir, 'site.manifest.json'),
  };
  const raw = loadFixture('raw-simple-draft.json');
  const registry = emptyRegistry('246389711');
  registry.assets = {};
  const created = [];

  const hub = async (acct, method, path, body) => {
    if (method === 'GET' && path.startsWith('/marketing/v3/emails')) {
      return { ok: true, status: 200, json: { results: created } };
    }
    if (method === 'POST' && path === '/marketing/v3/emails') {
      const id = '999001';
      created.push({ ...body, id, type: 'BATCH_EMAIL', state: 'DRAFT' });
      return { ok: true, status: 201, json: { id } };
    }
    return { ok: false, status: 404, json: {} };
  };

  try {
    mkdirSync(emailsDir, { recursive: true });
    writeFileSync(
      config.manifestFilePath,
      JSON.stringify({
        theme: { name: 't' },
        pages: [],
        blog: { slug: 'b', itemTemplate: 'a', listingTemplate: 'b' },
        forms: [],
        uiGated: [],
        emails: [{
          key: 'sample-how-to-send-your-first-email-with-hubspot',
          desiredState: 'draftCopy',
          ctaPolicy: 'fail',
          templateMappingKey: 'generated-2780957793',
        }],
      }),
    );
    writeFileSync(
      join(emailsDir, 'template-paths.json'),
      stableStringify({
        'generated-2780957793': {
          sourcePath: 'generated_layouts/2780957793.html',
          targetPath: '@hubspot/email/dnd/Start_from_scratch.html',
          verified: true,
        },
      }),
    );
    const templatePaths = JSON.parse(readFileSync(join(emailsDir, 'template-paths.json'), 'utf8'));
    const { canon } = canonicalEmail(raw, {
      key: 'sample-how-to-send-your-first-email-with-hubspot',
      registry,
      templatePaths,
      manifestEntry: { desiredState: 'draftCopy' },
    });
    writeFileSync(join(emailsDir, 'sample-how-to-send-your-first-email-with-hubspot.json'), stableStringify(canon));

    const r = await push(ACCT, { contentDir, registry, config, hub });
    assert.equal(r.pushed, 1);
    assert.equal(registry.emails['sample-how-to-send-your-first-email-with-hubspot'], '999001');
    assert.equal(created.length, 1);
    assert.equal(
      created[0].content.templatePath,
      '@hubspot/email/dnd/Start_from_scratch.html',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('push skips when manifest has no pushable emails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'emails-push-skip-'));
  try {
    const r = await push(ACCT, { contentDir: join(dir, 'content'), registry: emptyRegistry('1'), config: {} });
    assert.equal(r.pushed, 0);
    assert.ok(r.notes[0].includes('no manifest pushable emails'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('push creates manifest draft emails (not only draftCopy)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'emails-push-draft-'));
  const contentDir = join(dir, 'content');
  const emailsDir = join(contentDir, 'emails', 'campaigns');
  const config = {
    root: dir,
    contentDirPath: contentDir,
    manifestFilePath: join(dir, 'site.manifest.json'),
  };
  const registry = emptyRegistry('246389711');
  const created = [];

  const hub = async (acct, method, path, body) => {
    if (method === 'GET' && path.startsWith('/marketing/v3/emails')) {
      return { ok: true, status: 200, json: { results: created } };
    }
    if (method === 'POST' && path === '/marketing/v3/emails') {
      const id = '888001';
      created.push({ ...body, id, type: 'BATCH_EMAIL', state: 'DRAFT' });
      return { ok: true, status: 201, json: { id } };
    }
    return { ok: false, status: 404, json: {} };
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('source-code/published/content/')) {
      return { ok: true, status: 200 };
    }
    return origFetch(url);
  };

  try {
    mkdirSync(emailsDir, { recursive: true });
    writeFileSync(
      config.manifestFilePath,
      JSON.stringify({
        theme: { name: 't' },
        pages: [],
        blog: { slug: 'b', itemTemplate: 'a', listingTemplate: 'b' },
        forms: [],
        uiGated: [],
        emails: [{
          key: 'monthly-roundup',
          desiredState: 'draft',
          templatePath: 'seventh-sense-theme/email-templates/monthly-roundup.html',
        }],
      }),
    );
    writeFileSync(
      join(emailsDir, 'monthly-roundup.json'),
      stableStringify({
        key: 'monthly-roundup',
        name: 'Monthly Roundup',
        subject: 'July insights',
        content: {
          templatePath: 'seventh-sense-theme/email-templates/monthly-roundup.html',
          widgets: { hs_email_body: { body: { html: '<p>Hi</p>' } } },
        },
        from: { fromName: 'Seventh Sense', replyTo: 'hello@example.com' },
      }),
    );

    const r = await push(ACCT, { contentDir, registry, config, hub });
    assert.equal(r.pushed, 1);
    assert.equal(registry.emails['monthly-roundup'], '888001');
    assert.equal(
      created[0].content.templatePath,
      'seventh-sense-theme/email-templates/monthly-roundup.html',
    );
    assert.equal(created[0].content.widgets.hs_email_body.type, 'module');
  } finally {
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('push falls back to Start_from_scratch when committed shell missing on portal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'emails-push-fallback-'));
  const contentDir = join(dir, 'content');
  const emailsDir = join(contentDir, 'emails', 'campaigns');
  const config = {
    root: dir,
    contentDirPath: contentDir,
    manifestFilePath: join(dir, 'site.manifest.json'),
  };
  const registry = emptyRegistry('246389711');
  const created = [];
  const hub = async (acct, method, path, body) => {
    if (method === 'GET' && path.startsWith('/marketing/v3/emails')) {
      return { ok: true, status: 200, json: { results: created } };
    }
    if (method === 'POST' && path === '/marketing/v3/emails') {
      const id = '888002';
      created.push({ ...body, id });
      return { ok: true, status: 201, json: { id } };
    }
    return { ok: false, status: 404, json: {} };
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('source-code/published/content/')) {
      return { ok: false, status: 404 };
    }
    return origFetch(url);
  };

  try {
    mkdirSync(emailsDir, { recursive: true });
    writeFileSync(
      config.manifestFilePath,
      JSON.stringify({
        theme: { name: 'seventh-sense-theme' },
        pages: [],
        blog: { slug: 'b', itemTemplate: 'a', listingTemplate: 'b' },
        forms: [],
        uiGated: [],
        emails: [{
          key: 'fallback-email',
          desiredState: 'draft',
          templatePath: 'seventh-sense-theme/email-templates/monthly-roundup.html',
        }],
      }),
    );
    writeFileSync(
      join(emailsDir, 'fallback-email.json'),
      stableStringify({
        key: 'fallback-email',
        name: 'Fallback',
        subject: 'Subj',
        emailTemplateMode: 'DRAG_AND_DROP',
        content: {
          templatePath: 'seventh-sense-theme/email-templates/monthly-roundup.html',
          widgets: { hs_email_body: { type: 'rich_text', body: { html: '<p>x</p>' } } },
        },
        from: { fromName: '', replyTo: '' },
      }),
    );

    const r = await push(ACCT, { contentDir, registry, config, hub });
    assert.equal(r.pushed, 1);
    assert.match(created[0].content.templatePath, /Start_from_scratch/);
    assert.ok(r.notes.some((n) => n.includes('missing on portal')));
  } finally {
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});