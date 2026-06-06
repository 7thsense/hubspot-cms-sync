# hubspot-cms-sync

Git-backed bidirectional HubSpot CMS sync for themes, site pages, page module
content, blogs, forms, and assets.

The package provides the `hubspot-cms-sync` CLI plus the short `hcms` alias.
It reads account and site settings from `hubspot-cms-sync.config.mjs`, stores
per-account identity in a gitignored `.sync-state/` directory, and refuses to
push to configured read-only portal ids.

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
hubspot-cms-sync pull prod
hubspot-cms-sync preflight dev
hubspot-cms-sync push dev --publish
hcms push dev --dry-run
hubspot-cms-sync republish dev --all --blog
hubspot-cms-sync corpus
hcms manifest validate
```

## Configuration

Copy `examples/hubspot-cms-sync.config.mjs` into the consuming repo, then set
the theme name, manifest path, read-only portal ids, and account registry path.
Account keys live outside git at `$HUBSPOT_KEY_DIR/<portalId>.key` or
`~/.hubspot/<portalId>.key`.

## Tests

```bash
npm test
npm run lint
npm pack --dry-run
```

Live HubSpot round-trip tests are skipped by default and require
`RUN_INTEGRATION=1` plus sandbox credentials.
