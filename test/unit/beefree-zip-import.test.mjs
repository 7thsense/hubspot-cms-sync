import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync,
  mkdtempSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  beefreeAssetPrefix,
  rewriteBeefreeImageRefs,
  extractBeefreeBodyFragment,
  extractBeefreeHeadFragment,
  beefreeHtmlToEmailBody,
  beefreeHtmlToStyleSettings,
  beefreeHtmlToWidgets,
  projectBeefreeZipImport,
  readBeefreeExport,
  stageBeefreeAssets,
  listBeefreeImageAssets,
} from '../../src/lib/beefree-zip-import.mjs';
import { importBeefreeZipFromFile } from '../../src/email-import.mjs';
import { HUBSPOT_DND_FALLBACK_TEMPLATE } from '../../src/lib/email-dnd.mjs';

const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures', 'beefree', 'pub-party-mini');
const FIXTURE_HTML = join(FIXTURE_DIR, 'index.html');
const REAL_ZIP = '/Users/erik/Downloads/new-email-2026-07-08-162648.zip';

function loadHtml() {
  return readFileSync(FIXTURE_HTML, 'utf8');
}

test('rewriteBeefreeImageRefs tokenizes src and background-image paths', () => {
  const html = '<img src="images/hero.png"><td style="background-image: url(\'images/bg.png\')">';
  const out = rewriteBeefreeImageRefs(html, 'beefree/demo');
  assert.match(out, /src="@asset:beefree\/demo\/hero\.png"/);
  assert.match(out, /url\('@asset:beefree\/demo\/bg\.png'\)/);
});

test('extractBeefreeHeadFragment and extractBeefreeBodyFragment preserve layout', () => {
  const html = loadHtml();
  const head = extractBeefreeHeadFragment(html);
  const body = extractBeefreeBodyFragment(html);
  assert.match(head, /<style>/);
  assert.match(body, /class="nl-container"/);
  assert.match(body, /<!-- End -->/);
});

test('beefreeHtmlToEmailBody rewrites all image refs in composed fragment', () => {
  const html = loadHtml();
  const out = beefreeHtmlToEmailBody(html, beefreeAssetPrefix('pub-party-mini'));
  assert.doesNotMatch(out, /src="images\//);
  assert.match(out, /@asset:beefree\/pub-party-mini\//);
});

test('beefreeHtmlToStyleSettings maps dark outer background', () => {
  const s = beefreeHtmlToStyleSettings(loadHtml());
  assert.equal(s.backgroundColor, '#0c0e19');
  assert.equal(s.bodyColor, '#0c0e19');
  assert.equal(s.bodyBorderWidth, 0);
});

test('beefreeHtmlToWidgets builds full-bleed hs_email_body', () => {
  const widgets = beefreeHtmlToWidgets(loadHtml(), beefreeAssetPrefix('pub-party-mini'));
  assert.ok(widgets.hs_email_body);
  assert.equal(widgets.hs_email_body.body.hs_enable_module_padding, false);
  assert.match(widgets.hs_email_body.body.html, /nl-container/);
});

test('projectBeefreeZipImport uses Start_from_scratch and DRAG_AND_DROP', () => {
  const { campaign, notes } = projectBeefreeZipImport({
    html: loadHtml(),
    key: 'pub-party-mini',
    name: 'Super Bowl Party',
    subject: 'Get ready for the big game',
  });
  assert.equal(campaign.key, 'pub-party-mini');
  assert.equal(campaign.emailTemplateMode, 'DRAG_AND_DROP');
  assert.equal(campaign.templatePath, HUBSPOT_DND_FALLBACK_TEMPLATE);
  assert.equal(campaign.content.styleSettings.backgroundColor, '#0c0e19');
  assert.ok(notes.some((n) => /full-bleed/.test(n)));
});

test('readBeefreeExport reads extracted directory', () => {
  const source = readBeefreeExport(FIXTURE_DIR);
  assert.equal(source.sourceType, 'dir');
  assert.ok(source.html.includes('nl-container'));
  assert.ok(existsSync(join(source.imagesDir, 'hero.png')));
});

test('importBeefreeZipFromFile dry-run reports paths without writing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beefree-zip-dry-'));
  try {
    const result = importBeefreeZipFromFile(FIXTURE_DIR, {
      key: 'pub-party-mini',
      root: dir,
      write: false,
    });
    assert.ok(result.campaignPath.includes('pub-party-mini.json'));
    assert.equal(result.assetCount, listBeefreeImageAssets(join(FIXTURE_DIR, 'images'), 'beefree/pub-party-mini').length);
    assert.ok(!existsSync(join(dir, 'content', 'emails', 'campaigns', 'pub-party-mini.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('importBeefreeZipFromFile --write creates campaign, assets, and provenance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beefree-zip-write-'));
  try {
    importBeefreeZipFromFile(FIXTURE_DIR, {
      key: 'pub-party-mini',
      root: dir,
      write: true,
      name: 'Super Bowl Party',
      subject: 'Get ready for the big game',
    });
    const campaign = JSON.parse(
      readFileSync(join(dir, 'content', 'emails', 'campaigns', 'pub-party-mini.json'), 'utf8'),
    );
    assert.equal(campaign.name, 'Super Bowl Party');
    assert.match(
      campaign.content.widgets.hs_email_body.body.html,
      /@asset:beefree\/pub-party-mini\//,
    );
    assert.ok(existsSync(join(dir, 'content', 'assets', 'beefree', 'pub-party-mini', 'hero.png')));
    assert.ok(existsSync(join(dir, 'imports', 'beefree', 'pub-party-mini', 'source.index.html')));
    assert.ok(existsSync(join(dir, 'imports', 'beefree', 'pub-party-mini', 'import.meta.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('importBeefreeZipFromFile reads real zip export when present', { skip: !existsSync(REAL_ZIP) }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'beefree-zip-real-'));
  try {
    const result = importBeefreeZipFromFile(REAL_ZIP, {
      key: 'pub-party-2026-07',
      root: dir,
      write: true,
      name: 'Super Bowl at Your Pub',
      subject: 'Get ready for the big game!',
    });
    assert.ok(result.assetCount >= 20, `expected at least 20 images, got ${result.assetCount}`);
    const campaign = JSON.parse(readFileSync(result.campaignPath, 'utf8'));
    assert.match(campaign.content.widgets.hs_email_body.body.html, /GET READY FOR/);
    assert.ok(existsSync(join(dir, 'imports', 'beefree', 'pub-party-2026-07', 'source.zip')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fixture zip round-trip via unzip', () => {
  const zipPath = join(tmpdir(), `pub-party-mini-${Date.now()}.zip`);
  execFileSync('zip', ['-qr', zipPath, '.'], { cwd: FIXTURE_DIR, stdio: 'pipe' });
  const source = readBeefreeExport(zipPath);
  assert.equal(source.sourceType, 'zip');
  assert.match(source.html, /nl-container/);
});