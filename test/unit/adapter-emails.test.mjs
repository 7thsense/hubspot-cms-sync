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

test('push skips when manifest has no draftCopy emails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'emails-push-skip-'));
  try {
    const r = await push(ACCT, { contentDir: join(dir, 'content'), registry: emptyRegistry('1'), config: {} });
    assert.equal(r.pushed, 0);
    assert.ok(r.notes[0].includes('no manifest draftCopy'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});