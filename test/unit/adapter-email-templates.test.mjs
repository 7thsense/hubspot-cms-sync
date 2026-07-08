import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  name,
  dependsOn,
  localPathFromManifestTemplate,
  push,
} from '../../src/adapters/email-templates.mjs';
import { assertEmailTemplateAnnotated } from '../../src/lib/beefree-import.mjs';
import { beefreeShellHtml } from '../../src/lib/beefree-import.mjs';

test('email-templates adapter has no upstream dependencies', () => {
  assert.equal(name, 'email-templates');
  assert.deepEqual(dependsOn, []);
});

test('localPathFromManifestTemplate strips theme prefix', () => {
  assert.equal(
    localPathFromManifestTemplate('seventh-sense-theme/email-templates/monthly-roundup.html'),
    'email-templates/monthly-roundup.html',
  );
});

test('assertEmailTemplateAnnotated accepts annotated shells', () => {
  const html = beefreeShellHtml({ key: 'test', label: 'Test' });
  assert.doesNotThrow(() => assertEmailTemplateAnnotated(html, 'email-templates/test.html'));
});

test('assertEmailTemplateAnnotated rejects shells without templateType email', () => {
  assert.throws(
    () => assertEmailTemplateAnnotated('<html></html>', 'email-templates/bad.html'),
    /templateType: email/,
  );
});

test('push uploads manifest-listed email template shells', async () => {
  const root = mkdtempSync(join(tmpdir(), 'email-tpl-push-'));
  const manifestPath = join(root, 'site.manifest.json');
  mkdirSync(join(root, 'email-templates'), { recursive: true });
  writeFileSync(
    join(root, 'email-templates', 'monthly-roundup.html'),
    beefreeShellHtml({ key: 'monthly-roundup', label: 'Monthly Roundup' }),
  );
  writeFileSync(
    manifestPath,
    JSON.stringify({
      emailTemplates: [{
        key: 'monthly-roundup',
        path: 'seventh-sense-theme/email-templates/monthly-roundup.html',
        verified: true,
      }],
    }),
  );

  const uploads = [];
  const acct = { name: 'dev', portalId: '246389711', key: 'test-key' };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    uploads.push({ url, method: init.method });
    return { ok: true, status: 200, text: async () => '' };
  };

  try {
    const result = await push(acct, {
      config: { root, manifestFilePath: manifestPath, theme: { name: 'seventh-sense-theme' } },
    });
    assert.equal(result.pushed, 1);
    assert.equal(uploads.length, 1);
    assert.match(uploads[0].url, /seventh-sense-theme\/email-templates\/monthly-roundup\.html$/);
  } finally {
    globalThis.fetch = origFetch;
    rmSync(root, { recursive: true, force: true });
  }
});