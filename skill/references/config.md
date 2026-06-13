# Config And Manifest Reference

Read `hubspot-cms-sync.config.mjs` before selecting targets or commands.

Key fields:

- `accountsFile`: maps target names to HubSpot account details.
- `keyDirEnv`: environment variable pointing at hydrated credentials.
- `contentDir`: local CMS content directory.
- `syncStateDir`: local sync state directory; do not edit by hand.
- `manifestPath`: path to `site.manifest.json`.
- `redirectsFile`: optional CSV or JSON file for repo-managed URL redirects.
- `readOnlyPortalIds`: portals that must never receive writes.
- `knownPortalIds`: expected portal allowlist.
- `assetHosts`: host canonicalization policy for HubSpot assets.
- `adapters.externalDirs`: optional consumer-owned adapters.
- `theme`: theme directory and file layout.
- `blog`: blog slug and template mapping.
- `uiGated`: operations that require HubSpot UI action.
- `verification`: base URL environment variable and repo-specific test commands.

`site.manifest.json` is the deployment surface for theme, blog, forms, pages,
and UI-gated operations. Redirects are managed separately through
`redirectsFile`. If the manifest and config disagree, stop and ask for the
intended source of truth.

Use paths relative to the repo root unless the config explicitly says otherwise.
See `docs/CONTENT_LAYOUT.md` for the expected repository layout and minimal
sample tree.
