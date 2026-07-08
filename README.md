# hubspot-cms-sync

Git-backed bidirectional HubSpot CMS sync for themes, site pages, page module
content, blogs, forms, marketing emails (pull + manifest-scoped DnD push), and
assets.

The package provides the `hcms` CLI. The long binary name
`hubspot-cms-sync` is also installed, but examples use `hcms` for consistency.
The tool reads account and site settings from `hubspot-cms-sync.config.mjs`,
stores per-account identity in a gitignored `.sync-state/` directory, and
refuses to write to configured read-only portal ids.

See [`docs/CONTENT_LAYOUT.md`](docs/CONTENT_LAYOUT.md) for the repository
layout, supported push surfaces, and a minimal example tree. A runnable fixture
lives in [`examples/minimal-site/`](examples/minimal-site/) and is validated by
the unit tests.

## Install

```bash
npm install --save-dev hubspot-cms-sync
```

For local development from a sibling checkout:

```bash
npm install --save-dev ../hubspot-cms-sync
```

## Commands

```bash
hcms doctor
hcms pull dev
hcms preflight dev
hcms push dev --dry-run
hcms push dev --publish
hcms redirects dev
hcms redirects dev --apply
hcms republish dev --all --blog
hcms corpus
hcms manifest validate
hcms emails inventory prod   # read-only spike → .sync-state/email-spike/
hcms push dev --only assets,email-templates,emails   # DnD campaign push
hcms emails import beefree …              # Beefree Simple Schema → campaign + shell scaffold
hcms emails import beefree-zip …          # Beefree HTML+images zip → DnD campaign + assets
hcms emails import beefree-apply-content …  # re-apply content.spec.json copy overlay
```

Marketing email **pull** and **manifest-scoped DnD push** are implemented.
Beefree zip import (≥ 0.26.2): [`docs/BEEFREE_ZIP_IMPORT.md`](docs/BEEFREE_ZIP_IMPORT.md).
See [`docs/EMAIL_API_CONTRACT.md`](docs/EMAIL_API_CONTRACT.md) for layout,
manifest allowlist, push gates, operator commands, and DnD editor requirements
(`emailTemplateMode`, `styleSettings`, `flexAreas`, `module_id`). Repository
tree: [`docs/CONTENT_LAYOUT.md`](docs/CONTENT_LAYOUT.md#marketing-emails).

`hcms redirects` is dry-run by default. Pass `--apply` to create or update
HubSpot URL redirects from the configured `redirectsFile`, or pass `--file` to
use a specific repo-stored CSV or JSON spec. Managed redirects
default to `301` and `isOnlyAfterNotFound: false`, so they can intentionally
take precedence over an existing live HubSpot page during a cutover.

## Configuration

Copy `examples/hubspot-cms-sync.config.mjs` into the consuming repo, then set
the theme name, manifest path, redirect spec path, read-only portal ids, and
account registry path. Account keys live outside git at
`$HUBSPOT_KEY_DIR/<portalId>.key` or `~/.hubspot/<portalId>.key`.

```js
export default {
  accountsFile: 'sync/accounts.json',
  contentDir: 'content',
  manifestPath: 'site.manifest.json',
  redirectsFile: 'content/redirects.csv',
  readOnlyPortalIds: ['529456'],
  theme: {
    name: 'seventh-sense-theme',
    dirs: ['templates', 'modules', 'css', 'js', 'images'],
    files: ['theme.json', 'fields.json']
  }
};
```

CSV redirects need at least these columns:

```csv
routePrefix,destination,redirectStyle
/old-page,/new-page,301
```

Optional columns accepted by the HubSpot URL Redirects API include
`isOnlyAfterNotFound`, `isMatchFullUrl`, `isMatchQueryString`, `isPattern`,
`isProtocolAgnostic`, `isTrailingSlashOptional`, and `precedence`.

## Tests

```bash
npm test
npm run lint
npm pack --dry-run
```

Live HubSpot round-trip tests are skipped by default and require
`RUN_INTEGRATION=1` plus sandbox credentials.
