import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  beefreeSimpleToWidgets,
  beefreeShellHtml,
  emailTemplateAnnotation,
  projectBeefreeImport,
  paragraphModuleToHtml,
} from '../../src/lib/beefree-import.mjs';
import { importBeefreeFromFile } from '../../src/email-import.mjs';

function loadFixture(name) {
  return JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'beefree', name), 'utf8'));
}

test('paragraphModuleToHtml wraps plain text with default line-height', () => {
  assert.equal(
    paragraphModuleToHtml({ text: 'Hello' }),
    '<p style="line-height: 1.5;">Hello</p>',
  );
  assert.equal(paragraphModuleToHtml({ html: '<p>Hi</p>' }), '<p>Hi</p>');
});

test('beefreeSimpleToWidgets maps rows to hs_email_body widgets', () => {
  const raw = loadFixture('inside-insights.simple.json');
  const { widgets, metadata } = beefreeSimpleToWidgets(raw);
  assert.ok(widgets.hs_email_body);
  assert.ok(widgets.hs_email_body_2);
  assert.equal(metadata.subject, 'Inside Insights: your monthly marketing roundup');
});

test('emailTemplateAnnotation declares templateType email', () => {
  const ann = emailTemplateAnnotation({ label: 'Monthly Roundup' });
  assert.match(ann, /templateType: email/);
  assert.match(ann, /label: Monthly Roundup/);
  assert.match(ann, /isAvailableForNewContent: true/);
});

test('emailTemplateAnnotation collapses newlines in label', () => {
  const ann = emailTemplateAnnotation({ label: 'Line one\nLine two' });
  assert.match(ann, /label: Line one Line two/);
  assert.doesNotMatch(ann, /Line one\n/);
});

test('beefreeShellHtml emits annotated email DnD shell with module rows', () => {
  const html = beefreeShellHtml({ key: 'monthly-roundup', label: 'Monthly Roundup', bodyModuleCount: 2 });
  assert.match(html, /templateType: email/);
  assert.match(html, /@hubspot\/email_linked_image/);
  assert.match(html, /@hubspot\/email_can_spam/);
  assert.equal((html.match(/@hubspot\/email_body/g) || []).length, 2);
  assert.match(html, /dnd_area "main"/);
  assert.match(html, /dnd_area_stylesheet/);
  assert.match(html, /preview_text/);
});

test('projectBeefreeImport builds campaign + templatePath', () => {
  const raw = loadFixture('inside-insights.simple.json');
  const { campaign, shell, templatePath } = projectBeefreeImport(raw, {
    key: 'inside-insights-2026-07',
    templateKey: 'monthly-roundup',
    themeName: 'seventh-sense-theme',
  });
  assert.equal(campaign.key, 'inside-insights-2026-07');
  assert.equal(
    templatePath,
    'seventh-sense-theme/email-templates/monthly-roundup.html',
  );
  assert.match(shell, /dnd_area/);
  assert.ok(campaign.content.widgets.hs_email_body);
});

test('importBeefreeFromFile dry-run returns paths without writing', () => {
  const schema = join(import.meta.dirname, '..', 'fixtures', 'beefree', 'inside-insights.simple.json');
  const dir = mkdtempSync(join(tmpdir(), 'beefree-import-'));
  try {
    const result = importBeefreeFromFile(schema, {
      key: 'inside-insights-2026-07',
      templateKey: 'monthly-roundup',
      root: dir,
      write: false,
    });
    assert.ok(result.campaignPath.includes('inside-insights-2026-07.json'));
    assert.ok(result.shellPath.includes('monthly-roundup.html'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('importBeefreeFromFile --write creates campaign, shell, and provenance', () => {
  const schema = join(import.meta.dirname, '..', 'fixtures', 'beefree', 'inside-insights.simple.json');
  const dir = mkdtempSync(join(tmpdir(), 'beefree-import-write-'));
  try {
    importBeefreeFromFile(schema, {
      key: 'inside-insights-2026-07',
      templateKey: 'monthly-roundup',
      root: dir,
      write: true,
    });
    assert.ok(readFileSync(join(dir, 'content', 'emails', 'campaigns', 'inside-insights-2026-07.json'), 'utf8'));
    assert.ok(readFileSync(join(dir, 'email-templates', 'monthly-roundup.html'), 'utf8'));
    assert.ok(readFileSync(join(dir, 'imports', 'beefree', 'inside-insights-2026-07', 'source.simple.json'), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});