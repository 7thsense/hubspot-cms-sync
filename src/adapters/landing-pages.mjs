// sync/adapters/landing-pages.mjs — LANDING-PAGE definition adapter. Same shape as the
// site-pages adapter (shared page-sync core), against the landing-pages endpoint and
// the content/landing-pages tree, gated by the site.manifest.json "landingPages" list.
//
// Landing pages are conversion pages (demo requests, thank-you pages) that the original
// migration dropped entirely (no adapter) — a prod probe found 10 live ones. This makes
// them first-class: pull -> content/landing-pages/<slug>.json, push -> create/update +
// schedule publish, all ref-portable like site pages.

import { createPageAdapter } from '../lib/page-sync.mjs';

const adapter = createPageAdapter({
  name: 'landing-pages',
  endpoint: '/cms/v3/pages/landing-pages',
  subdir: 'landing-pages',
  manifestKey: 'landingPages',
  dependsOn: ['forms', 'assets'],
});

export const { name, dependsOn, pull, push } = adapter;
export const loadManifestLandingPages = adapter.loadManifest;
export default adapter;
