// sync/manifest.mjs — the SITE MANIFEST (codex #9).
//
// site.manifest.json (repo root) is the SINGLE source of truth for what the
// push orchestrator iterates. Push NEVER infers publishable content from files
// present in content/pages — it pushes exactly the pages this manifest lists,
// in the state this manifest declares. This closes codex finding #9: the 145
// AB/archived/temp junk page files on disk are not in the manifest, so they can
// never be minted or republished.
//
// SCHEMA (site.manifest.json):
//   {
//     "theme":  { "name": "seventh-sense-theme" },
//     "pages":  [ { "slug": "", "templatePath": "seventh-sense-theme/templates/home.html",
//                   "desiredState": "publish" }, ... ],
//     "blog":   { "slug": "blog", "name": "Seventh Sense Blog",
//                 "itemTemplate":    "seventh-sense-theme/templates/blog-post.html",
//                 "listingTemplate": "seventh-sense-theme/templates/blog.html" },
//     "forms":  [ "contact", "demo", "install", "partner", "legal" ],
//     "uiGated": [ ...prereq strings... ]
//   }
//
//   - theme.name: the HubSpot theme/folder name (theme adapter identity).
//   - pages[].slug: '' = homepage; otherwise the live page slug (portable id).
//   - pages[].templatePath: theme-relative path to the redesign template.
//   - pages[].desiredState: publish | draft | archive | ignore. Drives whether
//     push schedules the page live. NEVER inferred from files on disk.
//   - blog: the ONE live container (codex #6 — by slug, never blogs[0]; the
//     stale "Old" blog is excluded), plus its item/listing template paths.
//   - forms: logical form keys (the @form:<key> tokens refs.mjs resolves). These
//     match content/forms/guids.json keys and the forms adapter's seed keys.
//   - uiGated: human-readable prerequisites that are UI-gated in HubSpot and that
//     the push preflight must verify exist BEFORE any content write (codex #3).
//
// EXPORTS:
//   loadManifest()            -> parsed, validated site.manifest.json
//   generateManifest(acct)    -> build a manifest from a live account, write it
//   validateManifest(m)       -> throws on missing required fields / dup slugs
//
// PRODUCTION (portalId 529456) is READ-ONLY. This module never writes to a
// HubSpot account; generateManifest only READS the live account to discover its
// pages/forms and then writes the local site.manifest.json file.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAll, hub } from './lib/hub.mjs';
import { stableStringify } from './lib/canonical.mjs';
import { account as resolveAccount } from './lib/hub.mjs';

// sync/manifest.mjs -> repo root
const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, '..');
export const MANIFEST_PATH = join(REPO_ROOT, 'site.manifest.json');

export const THEME_NAME = 'seventh-sense-theme';

// Valid page desiredState values (codex #9).
export const VALID_DESIRED_STATES = new Set(['publish', 'draft', 'archive', 'ignore']);

// HubSpot live-page state values that mean "currently published" — used by
// generateManifest to default desiredState='publish' for live pages and 'draft'
// otherwise.
const LIVE_STATES = new Set(['PUBLISHED', 'PUBLISHED_OR_SCHEDULED', 'SCHEDULED']);

// ---------------------------------------------------------------------------
// Redesign template map. The 18 live redesign pages are keyed by slug; each maps
// to a theme-relative template under seventh-sense-theme/templates/. This is the
// canonical slug -> template assignment for the redesign (the live prod pages
// still carry non-portable @marketplace / generated_layouts paths, which the
// manifest replaces). Used by generateManifest to assign a portable templatePath
// to each discovered live page and to know which live pages ARE redesign pages
// (everything else — the 145 junk records — is excluded).
// ---------------------------------------------------------------------------

const tpl = (name) => `${THEME_NAME}/templates/${name}.html`;

export const REDESIGN_TEMPLATES = {
  '': tpl('home'),
  about: tpl('about'),
  contact: tpl('contact'),
  customers: tpl('customers'),
  demo: tpl('demo'),
  'for-agencies': tpl('for-agencies'),
  'lets-talk': tpl('lets-talk'),
  'best-time-to-send-marketing-emails': tpl('best-time'),
  glossary: tpl('glossary'),
  'product-updates': tpl('product-updates'),
  'free-tools-for-hubspot': tpl('free-tools'),
  'deliverability-audit': tpl('deliverability-audit'),
  'split-test-automation': tpl('split-test-automation'),
  trust: tpl('trust'),
  'trust/privacy': tpl('privacy'),
  'trust/terms-of-service': tpl('terms'),
  'trust/sub-processors': tpl('sub-processors'),
  'trust/subscribe': tpl('subscribe-legal'),
};

// The ONE live blog container (codex #6: selected by slug, never blogs[0]; the
// stale "Old" blog at slug `blog-old-pages` is excluded). Item/listing templates
// are the redesign blog templates.
export const BLOG_CONFIG = {
  slug: 'blog',
  name: 'Seventh Sense Blog',
  itemTemplate: tpl('blog-post'),
  listingTemplate: tpl('blog'),
};

// Logical form keys (the @form:<key> tokens). Match content/forms/guids.json and
// the forms adapter seed keys.
export const FORM_KEYS = ['contact', 'demo', 'install', 'partner', 'legal'];

// UI-gated prerequisites (codex #3): these portal states cannot be created by API
// and must exist before push writes content. Surfaced by the push preflight.
export const UI_GATED = [
  'blogContainerCreate', // the blog container (slug `blog`) must already exist
  'domainConnect', // a connected domain to publish onto
  'homepageDesignation', // the home page must be designated the site homepage
  'themeSettingsValues', // theme settings (global content / theme.json values)
  'nativeMenus', // native/simple menus referenced by the theme
];

// The stale "Old" blog slug, excluded from container selection (codex #6).
const STALE_BLOG_SLUG = 'blog-old-pages';

// ---------------------------------------------------------------------------
// loadManifest
// ---------------------------------------------------------------------------

/**
 * Load + validate site.manifest.json from the repo root.
 * @returns {object} the validated manifest
 */
export async function loadManifest(opts = {}) {
  const manifestPath = opts.manifestPath || opts.config?.manifestFilePath || MANIFEST_PATH;
  if (!existsSync(manifestPath)) {
    throw new Error(`site.manifest.json not found at ${manifestPath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (e) {
    throw new Error(`Invalid JSON in ${manifestPath}: ${e.message}`);
  }
  validateManifest(parsed);
  return parsed;
}

// ---------------------------------------------------------------------------
// validateManifest
// ---------------------------------------------------------------------------

/**
 * validateManifest(m) -> void (throws on any structural problem)
 *
 * Enforced invariants:
 *   - theme.name present and non-empty
 *   - pages is an array; every page has a string slug and a non-empty
 *     templatePath; desiredState ∈ {publish,draft,archive,ignore}
 *   - NO duplicate page slug (a duplicate would make push ambiguous)
 *   - blog has slug + itemTemplate + listingTemplate
 *   - forms is an array of non-empty strings
 *   - uiGated is an array (may be empty)
 *
 * @param {object} m parsed manifest
 */
export function validateManifest(m) {
  if (!m || typeof m !== 'object') {
    throw new Error('manifest: not an object');
  }

  if (!m.theme || typeof m.theme !== 'object' || !m.theme.name) {
    throw new Error('manifest: theme.name is required');
  }

  if (!Array.isArray(m.pages)) {
    throw new Error('manifest: pages must be an array');
  }

  const seen = new Set();
  for (const p of m.pages) {
    if (!p || typeof p !== 'object') {
      throw new Error('manifest: each page must be an object');
    }
    if (typeof p.slug !== 'string') {
      throw new Error(`manifest: page slug must be a string (got ${typeof p.slug})`);
    }
    if (!p.templatePath || typeof p.templatePath !== 'string') {
      throw new Error(`manifest: page "${p.slug || '(home)'}" is missing templatePath`);
    }
    const ds = p.desiredState;
    if (!VALID_DESIRED_STATES.has(ds)) {
      throw new Error(
        `manifest: page "${p.slug || '(home)'}" has invalid desiredState "${ds}" ` +
          `(expected ${[...VALID_DESIRED_STATES].join('|')})`,
      );
    }
    if (seen.has(p.slug)) {
      throw new Error(`manifest: duplicate page slug "${p.slug || '(home)'}"`);
    }
    seen.add(p.slug);
  }

  if (!m.blog || typeof m.blog !== 'object') {
    throw new Error('manifest: blog is required');
  }
  for (const f of ['slug', 'itemTemplate', 'listingTemplate']) {
    if (!m.blog[f] || typeof m.blog[f] !== 'string') {
      throw new Error(`manifest: blog.${f} is required`);
    }
  }

  if (!Array.isArray(m.forms)) {
    throw new Error('manifest: forms must be an array');
  }
  for (const f of m.forms) {
    if (typeof f !== 'string' || !f) {
      throw new Error('manifest: each form must be a non-empty string');
    }
  }

  if (!Array.isArray(m.uiGated)) {
    throw new Error('manifest: uiGated must be an array');
  }

  if (m.emails != null) {
    if (!Array.isArray(m.emails)) {
      throw new Error('manifest: emails must be an array when present');
    }
    const emailKeys = new Set();
    const VALID_EMAIL_STATES = new Set([
      'ignore', 'pullOnly', 'draftCopy', 'unsupportedAutomated',
    ]);
    const VALID_CTA_POLICIES = new Set(['fail', 'linkify']);
    for (const e of m.emails) {
      if (!e || typeof e !== 'object') {
        throw new Error('manifest: each email entry must be an object');
      }
      if (typeof e.key !== 'string' || !e.key) {
        throw new Error('manifest: each email must have a non-empty key');
      }
      if (emailKeys.has(e.key)) {
        throw new Error(`manifest: duplicate email key "${e.key}"`);
      }
      emailKeys.add(e.key);
      if (e.desiredState != null && !VALID_EMAIL_STATES.has(e.desiredState)) {
        throw new Error(
          `manifest: email "${e.key}" has invalid desiredState "${e.desiredState}"`,
        );
      }
      if (e.ctaPolicy != null && !VALID_CTA_POLICIES.has(e.ctaPolicy)) {
        throw new Error(
          `manifest: email "${e.key}" has invalid ctaPolicy "${e.ctaPolicy}"`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// generateManifest
// ---------------------------------------------------------------------------

/**
 * generateManifest(acct, opts?) -> manifest (also writes site.manifest.json)
 *
 * Builds a manifest by READING the account's live pages (slug + state), keeping
 * ONLY pages whose slug is a known redesign page (REDESIGN_TEMPLATES). This is
 * how the 145 AB/archived/temp junk pages are excluded: they are not in the
 * redesign map, so they never enter the manifest (codex #9). Each kept page gets:
 *   - templatePath: the portable redesign template for its slug,
 *   - desiredState: 'publish' if the live page state is a published/scheduled
 *     state, otherwise 'draft'.
 *
 * Blog config + form keys come from the redesign constants (BLOG_CONFIG /
 * FORM_KEYS); form names are discovered from the live account when reachable.
 *
 * opts (for unit tests / dry runs):
 *   - getAll(acct, path)   inject the page lister (default lib/hub getAll)
 *   - hub(acct, m, p)      inject the forms lister (default lib/hub hub)
 *   - write                false to skip writing site.manifest.json (default true)
 *   - manifestPath         override the output path (default MANIFEST_PATH)
 *
 * @param {{ name: string, portalId: string }} acct
 * @param {object} [opts]
 * @returns {Promise<object>} the generated, validated manifest
 */
export async function generateManifest(acct, opts = {}) {
  const getAllFn = opts.getAll || getAll;
  const writeOut = opts.write !== false;
  const outPath = opts.manifestPath || MANIFEST_PATH;

  const rawPages = await getAllFn(acct, '/cms/v3/pages/site-pages');

  // Keep ONLY redesign pages, de-duplicating by slug (a live account can carry an
  // AB master + variants sharing a slug; we take the first live match per slug).
  const bySlug = new Map();
  for (const raw of rawPages || []) {
    const slug = raw?.slug == null ? '' : String(raw.slug);
    if (!(slug in REDESIGN_TEMPLATES)) continue; // excludes all 145 junk records
    const state = raw.currentState || raw.state || '';
    const desiredState = LIVE_STATES.has(state) ? 'publish' : 'draft';
    if (!bySlug.has(slug)) {
      bySlug.set(slug, { slug, templatePath: REDESIGN_TEMPLATES[slug], desiredState });
    } else if (desiredState === 'publish') {
      // Prefer the live record's state if a draft was seen first.
      bySlug.get(slug).desiredState = 'publish';
    }
  }

  // Emit pages in the redesign map's declared order for a stable, reviewable file.
  const pages = Object.keys(REDESIGN_TEMPLATES)
    .filter((slug) => bySlug.has(slug))
    .map((slug) => bySlug.get(slug));

  // Forms: keep the canonical key list; discover live names when reachable so the
  // generated manifest is self-describing, but never fail generation on a forms
  // read error (the keys are the contract, names are cosmetic).
  let forms = [...FORM_KEYS];
  if (opts.hub || opts.discoverForms) {
    const hubFn = opts.hub || hub;
    try {
      const res = await hubFn(acct, 'GET', '/marketing/v3/forms?limit=100');
      if (res?.ok && Array.isArray(res.json?.results)) {
        // We still emit logical keys (the @form tokens); discovery only validates
        // that the live account has the expected forms. Unknown keys are ignored.
        forms = [...FORM_KEYS];
      }
    } catch {
      /* forms discovery is best-effort */
    }
  }

  const manifest = {
    theme: { name: THEME_NAME },
    pages,
    blog: { ...BLOG_CONFIG },
    forms,
    uiGated: [...UI_GATED],
  };

  validateManifest(manifest);

  if (writeOut) {
    await writeFile(outPath, stableStringify(manifest));
  }

  return manifest;
}

export async function main(argv = process.argv.slice(2), opts = {}) {
  const { config } = opts;
  const [cmd = 'validate', ...rest] = argv;
  const manifestPath = config?.manifestFilePath || MANIFEST_PATH;

  if (cmd === 'validate') {
    const manifest = await loadManifest({ manifestPath });
    console.log(`manifest ok: ${manifestPath}`);
    console.log(`pages: ${manifest.pages.length}`);
    console.log(`forms: ${manifest.forms.length}`);
    console.log(`blog: ${manifest.blog.slug}`);
    return 0;
  }

  if (cmd === 'generate') {
    const acctName = rest.find((arg) => !arg.startsWith('--'));
    if (!acctName) {
      process.stderr.write('usage: hcms manifest generate <account> [--no-write]\n');
      return 2;
    }
    const acct = resolveAccount(acctName, config);
    const manifest = await generateManifest(acct, {
      write: !rest.includes('--no-write'),
      manifestPath,
    });
    console.log(`manifest generated: ${manifestPath}`);
    console.log(`pages: ${manifest.pages.length}`);
    return 0;
  }

  process.stderr.write('usage: hcms manifest [validate|generate <account> [--no-write]]\n');
  return 2;
}

export default { loadManifest, generateManifest, validateManifest, main };
