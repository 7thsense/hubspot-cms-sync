export default {
  accountsFile: 'sync/accounts.json',
  keyDirEnv: 'HUBSPOT_KEY_DIR',
  contentDir: 'content',
  syncStateDir: '.sync-state',
  manifestPath: 'site.manifest.json',
  readOnlyPortalIds: [],
  knownPortalIds: [],
  assetHosts: {
    canonicalizeHostPatterns: [
      'hubfs',
      'hubspotusercontent',
      'cdn\\d*\\.hubspot\\.net'
    ],
    legacySiteHosts: []
  },
  adapters: {
    externalDirs: []
  },
  theme: {
    name: 'example-theme',
    dirs: ['templates', 'modules', 'css', 'js', 'images'],
    files: ['theme.json', 'fields.json']
  },
  blog: {
    slug: 'blog',
    itemTemplate: 'example-theme/templates/blog-post.html',
    listingTemplate: 'example-theme/templates/blog.html'
  },
  uiGated: [
    'blogContainerCreate',
    'domainConnect',
    'homepageDesignation',
    'themeSettingsValues',
    'nativeMenus'
  ],
  verification: {
    baseUrlEnv: 'SITE_BASE_URL',
    commands: {
      unit: 'npm run test:unit',
      corpus: 'hcms corpus',
      playwright: 'npx playwright test verify/fidelity.spec.mjs verify/forms.spec.mjs verify/links.spec.mjs'
    }
  }
};
