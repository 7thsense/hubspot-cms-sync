export default {
  accountsFile: 'sync/accounts.json',
  keyDirEnv: 'HUBSPOT_KEY_DIR',
  contentDir: 'content',
  syncStateDir: '.sync-state',
  manifestPath: 'site.manifest.json',
  redirectsFile: 'sync/redirects.csv',
  readOnlyPortalIds: ['999999'],
  knownPortalIds: ['123456'],
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
  uiGated: ['blogContainerCreate', 'domainConnect'],
  verification: {
    baseUrlEnv: 'SITE_BASE_URL',
    commands: {
      corpus: 'hcms corpus'
    }
  }
};
