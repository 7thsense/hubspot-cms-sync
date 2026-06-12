# Configuration Plan

The package should be driven by `hubspot-cms-sync.config.mjs` in the consuming
repo root.

Example:

```js
export default {
  accountsFile: 'sync/accounts.json',
  keyDirEnv: 'HUBSPOT_KEY_DIR',
  contentDir: 'content',
  syncStateDir: '.sync-state',
  manifestPath: 'site.manifest.json',
  redirectsFile: 'content/redirects.csv',
  readOnlyPortalIds: ['529456'],
  knownPortalIds: ['529456', '246389711'],
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
    name: 'seventh-sense-theme',
    dirs: ['templates', 'modules', 'css', 'js', 'images'],
    files: ['theme.json', 'fields.json']
  },
  blog: {
    slug: 'blog',
    itemTemplate: 'seventh-sense-theme/templates/blog-post.html',
    listingTemplate: 'seventh-sense-theme/templates/blog.html'
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
```

## Design Requirements

- Config paths are relative to `--root` / `process.cwd()`.
- The CLI resolves config once, derives absolute paths, and passes that object
  explicitly. Avoid hidden module-level global state.
- Package defaults are safe and minimal.
- No consumer-specific portal IDs are hardcoded in source.
- The config loader validates shape and prints remediation, not stack traces.
- `site.manifest.json` remains the deploy surface for content, pages, forms, and
  blog.
- Repo-stored redirects are a separate deploy surface. `redirectsFile` points to
  a CSV or JSON spec consumed by `hcms redirects <account> [--apply]`.
- `hubspot-cms-sync.config.mjs` controls environment policy and filesystem
  layout.
- Managed redirects default to `isOnlyAfterNotFound: false`, so a release can
  intentionally redirect an old live page path without a manual archive step.

## Open Config Questions

- Should the package support TypeScript configs or only ESM?
- Should CTA/menu adapters be optional plugins or built-in later?

## Decisions From Plan Review

- Project-specific adapters should be supported only after core extraction works.
  If supported, they should come from explicit `adapters.externalDirs` entries and
  participate in the same `dependsOn` validation as built-in adapters.
- `knownPortalIds` cannot remain hardcoded. For v1, require explicit config or
  derive from `accountsFile` plus any registry portal IDs; tests must cover both
  behaviors before generic publication.
- `readOnlyPortalIds` must be an array. Push/preflight checks use membership,
  not a single hardcoded production portal.
