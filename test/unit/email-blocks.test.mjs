import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import * as nodeFs from 'node:fs';

import {
  widgetsFromBlock,
  mergeEmailWidgets,
  mergeBlocksIntoCampaign,
  campaignFileCandidates,
  blockFilePath,
} from '../../src/lib/email-blocks.mjs';

test('widgetsFromBlock supports widgetName and widgets map', () => {
  assert.ok(widgetsFromBlock({ widgetName: 'logo_image', widget: { type: 'logo' } }).logo_image);
  assert.ok(widgetsFromBlock({ widgets: { a: { type: 'x' } } }).a);
});

test('mergeEmailWidgets lets campaign override blocks', () => {
  const merged = mergeEmailWidgets(
    { logo_image: { body: { src: '@asset:old.jpg' } }, footer: { body: {} } },
    { logo_image: { body: { src: '@asset:new.jpg' } } },
  );
  assert.equal(merged.logo_image.body.src, '@asset:new.jpg');
  assert.ok(merged.footer);
});

test('mergeBlocksIntoCampaign loads block files from disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'email-blocks-'));
  const contentDir = join(dir, 'content');
  const blocksDir = join(contentDir, 'emails', 'blocks');
  try {
    mkdirSync(blocksDir, { recursive: true });
    writeFileSync(
      join(blocksDir, 'logo.json'),
      JSON.stringify({ widgetName: 'logo_image', widget: { type: 'logo', body: { src: '@asset:x.jpg' } } }),
    );
    const { widgets, loaded, missing } = mergeBlocksIntoCampaign({
      contentDir,
      blockKeys: ['logo', 'missing'],
      campaignWidgets: { hs_email_body: { body: { html: '<p>Hi</p>' } } },
      fs: nodeFs,
    });
    assert.deepEqual(loaded, ['logo']);
    assert.deepEqual(missing, ['missing']);
    assert.ok(widgets.logo_image);
    assert.ok(widgets.hs_email_body);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('campaignFileCandidates prefers campaigns/ subdir', () => {
  const contentDir = '/site/content';
  const paths = campaignFileCandidates(contentDir, 'demo');
  assert.equal(paths[0], join(contentDir, 'emails', 'campaigns', 'demo.json'));
  assert.equal(paths[1], join(contentDir, 'emails', 'demo.json'));
});

test('blockFilePath resolves blocks directory', () => {
  assert.equal(
    blockFilePath('/site/content', 'logo'),
    join('/site/content', 'emails', 'blocks', 'logo.json'),
  );
});