# hubspot-cms-sync

Git-backed bidirectional HubSpot CMS sync for themes, site pages, page module
content, blogs, forms, marketing emails (pull v1), and assets.

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
```

Marketing email **pull** is implemented; **push** is not yet. Pull only manifest-
listed `emails[]` unless `HCMS_EMAIL_PULL_ALL=1`. See
[`docs/EMAIL_SYNC_PLAN.md`](docs/EMAIL_SYNC_PLAN.md).

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
