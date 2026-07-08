// Unit tests for sync/manifest.mjs — NO real network, NO real disk writes.
// generateManifest's page lister (getAll) is injected; write is disabled so the
// repo's real site.manifest.json is never touched.
//
//   node --test test/unit/manifest.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateManifest,
  generateManifest,
  REDESIGN_TEMPLATES,
  BLOG_CONFIG,
  FORM_KEYS,
  THEME_NAME,
} from '../../src/manifest.mjs';

// ── helpers ────────────────────────────────────────────────────────────────

// A minimal, valid manifest we can mutate per-test.
function validManifest() {
  return {
    theme: { name: THEME_NAME },
    pages: [
      { slug: '', templatePath: `${THEME_NAME}/templates/home.html`, desiredState: 'publish' },
      { slug: 'about', templatePath: `${THEME_NAME}/templates/about.html`, desiredState: 'draft' },
    ],
    blog: { ...BLOG_CONFIG },
    forms: [...FORM_KEYS],
    uiGated: [],
  };
}

const acct = { name: 'dev', portalId: '246389711' };

// ── validateManifest: happy path ─────────────────────────────────────────────

test('validateManifest accepts a well-formed manifest', () => {
  assert.doesNotThrow(() => validateManifest(validManifest()));
});

// ── validateManifest: duplicate-slug rejection ───────────────────────────────

test('validateManifest rejects duplicate page slugs', () => {
  const m = validManifest();
  m.pages.push({
    slug: 'about', // duplicate of the existing 'about'
    templatePath: `${THEME_NAME}/templates/about.html`,
    desiredState: 'publish',
  });
  assert.throws(() => validateManifest(m), /duplicate page slug "about"/);
});

test('validateManifest rejects duplicate HOMEPAGE slug ("")', () => {
  const m = validManifest();
  m.pages.push({
    slug: '',
    templatePath: `${THEME_NAME}/templates/home.html`,
    desiredState: 'publish',
  });
  assert.throws(() => validateManifest(m), /duplicate page slug "\(home\)"/);
});

// ── validateManifest: bad-desiredState rejection ─────────────────────────────

test('validateManifest rejects an invalid desiredState', () => {
  const m = validManifest();
  m.pages[1].desiredState = 'published'; // not in publish|draft|archive|ignore
  assert.throws(() => validateManifest(m), /invalid desiredState "published"/);
});

test('validateManifest rejects a missing desiredState', () => {
  const m = validManifest();
  delete m.pages[1].desiredState;
  assert.throws(() => validateManifest(m), /invalid desiredState/);
});

test('validateManifest accepts every valid desiredState', () => {
  for (const ds of ['publish', 'draft', 'archive', 'ignore']) {
    const m = validManifest();
    m.pages[1].desiredState = ds;
    assert.doesNotThrow(() => validateManifest(m), `desiredState ${ds} should be valid`);
  }
});

// ── validateManifest: required fields ────────────────────────────────────────

test('validateManifest requires theme.name', () => {
  const m = validManifest();
  delete m.theme.name;
  assert.throws(() => validateManifest(m), /theme\.name is required/);
});

test('validateManifest requires a templatePath on every page', () => {
  const m = validManifest();
  delete m.pages[1].templatePath;
  assert.throws(() => validateManifest(m), /missing templatePath/);
});

test('validateManifest requires a string slug', () => {
  const m = validManifest();
  m.pages[1].slug = 42;
  assert.throws(() => validateManifest(m), /slug must be a string/);
});

test('validateManifest requires blog.itemTemplate / listingTemplate / slug', () => {
  for (const f of ['slug', 'itemTemplate', 'listingTemplate']) {
    const m = validManifest();
    delete m.blog[f];
    assert.throws(() => validateManifest(m), new RegExp(`blog\\.${f} is required`));
  }
});

test('validateManifest requires forms to be an array of non-empty strings', () => {
  const m1 = validManifest();
  m1.forms = 'contact';
  assert.throws(() => validateManifest(m1), /forms must be an array/);

  const m2 = validManifest();
  m2.forms = ['contact', ''];
  assert.throws(() => validateManifest(m2), /each form must be a non-empty string/);
});

test('validateManifest requires uiGated to be an array', () => {
  const m = validManifest();
  m.uiGated = 'blogContainerCreate';
  assert.throws(() => validateManifest(m), /uiGated must be an array/);
});

// ── validateManifest: email templates, blocks, workflow ─────────────────────

test('validateManifest accepts emailTemplates, emailBlocks, and workflow emails', () => {
  const m = validManifest();
  m.emailTemplates = [{
    key: 'monthly-roundup',
    path: `${THEME_NAME}/email-templates/monthly-roundup.html`,
    verified: true,
  }];
  m.emailBlocks = [{ key: 'logo' }, { key: 'footer-can-spam' }];
  m.emails = [{
    key: 'inside-insights',
    desiredState: 'draft',
    templatePath: `${THEME_NAME}/email-templates/monthly-roundup.html`,
    blocks: ['logo', 'footer-can-spam'],
  }, {
    key: 'onboarding-1',
    desiredState: 'workflow',
    templatePath: `${THEME_NAME}/email-templates/monthly-roundup.html`,
    blocks: ['logo'],
    workflow: { sequence: 'onboarding', step: 1, attachManually: true },
  }];
  assert.doesNotThrow(() => validateManifest(m));
});

test('validateManifest rejects emailTemplates without email-templates/ path', () => {
  const m = validManifest();
  m.emailTemplates = [{ key: 'bad', path: 'templates/foo.html' }];
  assert.throws(() => validateManifest(m), /must include email-templates\//);
});

test('validateManifest rejects duplicate emailBlocks keys', () => {
  const m = validManifest();
  m.emailBlocks = [{ key: 'logo' }, { key: 'logo' }];
  assert.throws(() => validateManifest(m), /duplicate emailBlocks key "logo"/);
});

test('validateManifest rejects workflow email without workflow object', () => {
  const m = validManifest();
  m.emails = [{ key: 'wf', desiredState: 'workflow' }];
  assert.throws(() => validateManifest(m), /requires a workflow object/);
});

test('validateManifest rejects workflow metadata on non-workflow desiredState', () => {
  const m = validManifest();
  m.emails = [{
    key: 'wf',
    desiredState: 'draft',
    workflow: { sequence: 'onboarding', step: 1 },
  }];
  assert.throws(() => validateManifest(m), /workflow metadata but desiredState is not "workflow"/);
});

test('validateManifest rejects invalid email desiredState', () => {
  const m = validManifest();
  m.emails = [{ key: 'x', desiredState: 'published' }];
  assert.throws(() => validateManifest(m), /invalid desiredState "published"/);
});

// ── generateManifest: excludes the AB/archived/temp junk ─────────────────────

// A representative slice of the real account: a handful of REDESIGN pages mixed
// in with the kind of junk records the live account actually carries (AB
// variants, archived, temp slugs, bare-guid slugs, numeric-id slugs, *-old).
function liveAccountPages() {
  return [
    // --- redesign pages we WANT ---
    { slug: '', currentState: 'PUBLISHED_OR_SCHEDULED' },
    { slug: 'about', currentState: 'PUBLISHED_OR_SCHEDULED' },
    { slug: 'trust', currentState: 'PUBLISHED_OR_SCHEDULED' },
    { slug: 'trust/privacy', currentState: 'PUBLISHED_OR_SCHEDULED' },
    { slug: 'demo', currentState: 'DRAFT' }, // live page in draft state -> 'draft'

    // --- JUNK that must be excluded (codex #9) ---
    { slug: 'case_studies/-030776a9-dc33-4e61-962a-fb34be972930', currentState: 'LOSER_AB_VARIANT' },
    { slug: 'case_studies/', currentState: 'DRAFT_AB' },
    { slug: '-archived', currentState: 'DRAFT' },
    { slug: 'agency-partner-program-old', currentState: 'PUBLISHED_OR_SCHEDULED' },
    { slug: '-temporary-slug-0bd9fbff-812f-4635-837f-13002a8e9af8', currentState: 'DRAFT' },
    { slug: '194021001339', currentState: 'PUBLISHED_OR_SCHEDULED' },
    { slug: 'oldhomepage', currentState: 'DRAFT' },
    { slug: 'hubspot-pricing', currentState: 'PUBLISHED_OR_SCHEDULED' }, // legacy live, NOT a redesign slug
  ];
}

test('generateManifest keeps ONLY redesign pages and excludes all junk', async () => {
  const pages = liveAccountPages();
  const m = await generateManifest(acct, {
    getAll: async () => pages,
    write: false,
  });

  const slugs = m.pages.map((p) => p.slug);

  // Wanted redesign slugs are present.
  for (const want of ['', 'about', 'trust', 'trust/privacy', 'demo']) {
    assert.ok(slugs.includes(want), `expected redesign slug "${want || '(home)'}" to be kept`);
  }

  // No junk slug leaked in.
  for (const junk of [
    'case_studies/-030776a9-dc33-4e61-962a-fb34be972930',
    'case_studies/',
    '-archived',
    'agency-partner-program-old',
    '-temporary-slug-0bd9fbff-812f-4635-837f-13002a8e9af8',
    '194021001339',
    'oldhomepage',
    'hubspot-pricing', // legacy-but-live page that is not part of the redesign
  ]) {
    assert.ok(!slugs.includes(junk), `junk slug "${junk}" must be excluded`);
  }

  // Every kept page is a known redesign slug.
  for (const p of m.pages) {
    assert.ok(p.slug in REDESIGN_TEMPLATES, `kept slug "${p.slug}" must be in REDESIGN_TEMPLATES`);
    assert.equal(p.templatePath, REDESIGN_TEMPLATES[p.slug]);
  }

  // The generated manifest is itself valid (no dup slugs, valid desiredStates).
  assert.doesNotThrow(() => validateManifest(m));
});

test('generateManifest sets desiredState=publish for live pages, draft otherwise', async () => {
  const m = await generateManifest(acct, {
    getAll: async () => liveAccountPages(),
    write: false,
  });
  const byslug = Object.fromEntries(m.pages.map((p) => [p.slug, p.desiredState]));
  assert.equal(byslug['about'], 'publish'); // PUBLISHED_OR_SCHEDULED
  assert.equal(byslug['demo'], 'draft'); // DRAFT
});

test('generateManifest de-duplicates a slug appearing as master + AB variant', async () => {
  // HubSpot can return the same redesign slug for a live master AND a draft-AB
  // sibling. We must keep exactly one entry, preferring the published state.
  const pages = [
    { slug: 'about', currentState: 'DRAFT_AB' }, // variant seen first
    { slug: 'about', currentState: 'PUBLISHED_OR_SCHEDULED' }, // live master
  ];
  const m = await generateManifest(acct, { getAll: async () => pages, write: false });
  const about = m.pages.filter((p) => p.slug === 'about');
  assert.equal(about.length, 1, 'slug must appear exactly once');
  assert.equal(about[0].desiredState, 'publish');
  assert.doesNotThrow(() => validateManifest(m));
});

test('generateManifest emits blog config + form keys + uiGated', async () => {
  const m = await generateManifest(acct, { getAll: async () => [], write: false });
  assert.equal(m.theme.name, THEME_NAME);
  assert.deepEqual(m.blog, BLOG_CONFIG);
  assert.deepEqual(m.forms, FORM_KEYS);
  assert.ok(Array.isArray(m.uiGated) && m.uiGated.length > 0);
  // Empty live account -> zero pages, still a valid manifest.
  assert.equal(m.pages.length, 0);
  assert.doesNotThrow(() => validateManifest(m));
});
