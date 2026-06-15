// sync/adapters/pages.mjs — SITE-PAGE definition adapter. A thin instantiation of
// the shared page-sync core (src/lib/page-sync.mjs); the landing-pages adapter is the
// sibling instantiation. This adapter owns the page OBJECT/SEO definition (slug,
// templatePath, name, htmlTitle, metaDescription, language, headHtml/footerHtml,
// SEO/OG fields), NOT the per-page module content (the `content` adapter owns widgets).
//
// PULL: GET /cms/v3/pages/site-pages -> drop AB/archived/temp junk -> keep ONLY pages
// the manifest (site.manifest.json "pages") lists -> canonicalPage() -> canonicalize()
// refs -> write content/pages/<slug>.json with a manifest-driven desiredState.
// PUSH: resolve() refs to the target -> create/update by slug -> schedule publish.
// PRODUCTION (529456) is never targeted here; the orchestrator passes `acct`.

import {
  createPageAdapter,
  isABVariant,
  isArchived,
  isTempSlug,
  isPortablePage,
  buildPagePayload,
} from '../lib/page-sync.mjs';

const adapter = createPageAdapter({
  name: 'pages',
  endpoint: '/cms/v3/pages/site-pages',
  subdir: 'pages',
  manifestKey: 'pages',
  dependsOn: ['forms', 'assets'],
  strictManifest: true, // every site has pages — an empty manifest is a misconfig, not a no-op
});

export const { name, dependsOn, pull, push } = adapter;
// loadManifestPages kept for back-compat (the site-pages manifest loader).
export const loadManifestPages = adapter.loadManifest;
export { isABVariant, isArchived, isTempSlug, isPortablePage, buildPagePayload };
export default adapter;
