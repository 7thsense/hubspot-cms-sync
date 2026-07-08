import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  importBeefreeZipFromFile,
  refreshBeefreeCampaignContent,
} from '../../src/email-import.mjs';

const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures', 'beefree', 'pub-party-mini');

test('refreshBeefreeCampaignContent applies content.spec and materializes backgrounds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beefree-refresh-'));
  try {
    importBeefreeZipFromFile(FIXTURE_DIR, {
      key: 'pub-party-mini',
      root: dir,
      write: true,
      name: 'Super Bowl Party',
      subject: 'Get ready',
    });

    const specPath = join(dir, 'imports', 'beefree', 'pub-party-mini', 'content.spec.json');
    mkdirSync(join(dir, 'imports', 'beefree', 'pub-party-mini'), { recursive: true });
    writeFileSync(specPath, JSON.stringify({
      replacements: [{
        find: 'GET READY FOR',
        replace: 'INSIDE INSIGHTS FOR',
      }],
    }));

    const result = refreshBeefreeCampaignContent('pub-party-mini', {
      root: dir,
      write: true,
      name: 'Inside Insights',
      subject: 'July roundup',
    });

    const campaign = JSON.parse(readFileSync(result.campaignPath, 'utf8'));
    const html = campaign.content.widgets.hs_email_body.body.html;

    assert.match(html, /INSIDE INSIGHTS FOR/);
    assert.doesNotMatch(html, /background-image:/);
    assert.match(html, /class="image_block beefree-bg"/);
    assert.ok(existsSync(result.customizedHtmlPath));
    assert.match(readFileSync(result.customizedHtmlPath, 'utf8'), /INSIDE INSIGHTS FOR/);
    assert.ok(result.notes.some((n) => /content spec:/.test(n)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('importBeefreeZipFromFile preserves source.index.html separate from customized', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beefree-prov-'));
  try {
    const specPath = join(dir, 'imports', 'beefree', 'pub-party-mini', 'content.spec.json');
    mkdirSync(join(dir, 'imports', 'beefree', 'pub-party-mini'), { recursive: true });
    writeFileSync(specPath, JSON.stringify({
      replacements: [{ find: 'GET READY FOR', replace: 'BRANDED' }],
    }));

    importBeefreeZipFromFile(FIXTURE_DIR, {
      key: 'pub-party-mini',
      root: dir,
      write: true,
    });

    const source = readFileSync(
      join(dir, 'imports', 'beefree', 'pub-party-mini', 'source.index.html'),
      'utf8',
    );
    const customized = readFileSync(
      join(dir, 'imports', 'beefree', 'pub-party-mini', 'customized.index.html'),
      'utf8',
    );

    assert.match(source, /GET READY FOR/);
    assert.doesNotMatch(source, /BRANDED/);
    assert.match(customized, /BRANDED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});