# Content Layout

`hcms` syncs a normal repository tree into HubSpot CMS records. The exact paths
are configurable in `hubspot-cms-sync.config.mjs`, but the default layout is:

```text
my-site/
|-- hubspot-cms-sync.config.mjs
|-- site.manifest.json
|-- sync/
|   |-- accounts.json
|   `-- redirects.csv
|-- content/
|   |-- pages/
|   |   |-- home.json
|   |   |-- home.widgets.json
|   |   `-- about.json
|   |-- forms/
|   |   |-- contact.json
|   |   `-- properties.json
|   |-- assets/
|   |   `-- hero.svg
|   |-- emails/
|   |   |-- campaigns/
|   |   |   `-- inside-insights-2026-07.json
|   |   |-- blocks/
|   |   |   |-- logo.json
|   |   |   `-- footer-can-spam.json
|   |   |-- template-paths.json
|   |   `-- subscriptions.json
|   `-- blog/
|       |-- container.json
|       `-- posts/
|           `-- blog__hello-world.json
|-- email-templates/
|   `-- monthly-roundup.html
|-- templates/
|   |-- home.html
|   |-- page.html
|   |-- blog.html
|   `-- blog-post.html
|-- modules/
|   `-- hero.module/
|       |-- fields.json
|       `-- module.html
|-- css/
|   `-- main.css
|-- js/
|   `-- hs-forms.js
|-- theme.json
`-- fields.json
```

A complete minimal fixture lives at [`examples/minimal-site/`](../examples/minimal-site/).
The unit test suite loads that fixture, validates its manifest and redirects,
runs the local push ref preflight, reads its canonical forms, and scans it with
the corpus scanner.

## What Can Be Pushed

`hcms push <account>` writes the content surfaces below. It is idempotent by
portable identity: page slug, form name/key, blog slug/post slug, theme path, and
redirect route.

| Surface | Repo source | HubSpot target |
| --- | --- | --- |
| Theme code | `templates/`, `modules/`, `css/`, `js/`, `images/`, `theme.json`, `fields.json` | CMS Source Code API |
| Site pages | `content/pages/*.json` plus `site.manifest.json` | CMS Pages API |
| Page module values | `content/pages/*.widgets.json` | CMS Pages draft widget carrier |
| Forms | `content/forms/<key>.json` | Forms API |
| Contact properties | `content/forms/properties.json` | CRM Properties API |
| File assets | `content/assets/**` and `content/blog/assets/**` | File Manager API |
| Blog container and posts | `content/blog/container.json`, `content/blog/posts/*.json` | Blog APIs |
| Marketing emails | `content/emails/campaigns/<key>.json` (or `content/emails/<key>.json`) | Marketing Email API (`/marketing/v3/emails`) |
| Email DnD shells | `email-templates/*.html` (manifest `emailTemplates[]`) | CMS Source Code API (theme path) |
| URL redirects | `sync/redirects.csv` or configured `redirectsFile` | CMS URL Redirects API |

See [`EMAIL_API_CONTRACT.md`](EMAIL_API_CONTRACT.md) for manifest allowlist, DnD
push requirements, and operator commands.

## Marketing emails

Campaigns live under `content/emails/campaigns/<key>.json`. Reusable widgets
(logo, footer) are `content/emails/blocks/<name>.json` and referenced from
manifest `emailBlocks` + per-email `blocks[]`.

Sidecars (not per-campaign records):

- `content/emails/template-paths.json` — verified `generated_layouts/*` remaps
- `content/emails/subscriptions.json` — subscription name reference
- `content/emails/keys.json` — optional name → key seed map

Committed DnD shells are theme HTML under `email-templates/` and listed in
manifest `emailTemplates[]`. Push uploads shells before campaigns
(`--only email-templates` then `--only emails`).

Pull writes manifest-listed `emails[]` keys unless `HCMS_EMAIL_PULL_ALL=1`.
HubSpot ids map through gitignored `.sync-state/<portalId>.registry.json` →
`emails[key]`.

## Deployment Surface

`site.manifest.json` is the allowlist for pages, forms, blog, theme, and
UI-gated prerequisites. A page file under `content/pages/` is not enough by
itself; the page must also be listed in the manifest.

```json
{
  "theme": { "name": "example-theme" },
  "pages": [
    {
      "slug": "",
      "templatePath": "example-theme/templates/home.html",
      "desiredState": "publish"
    },
    {
      "slug": "about",
      "templatePath": "example-theme/templates/page.html",
      "desiredState": "draft"
    }
  ],
  "blog": {
    "slug": "blog",
    "itemTemplate": "example-theme/templates/blog-post.html",
    "listingTemplate": "example-theme/templates/blog.html"
  },
  "forms": ["contact"],
  "uiGated": ["blogContainerCreate", "domainConnect"]
}
```

`desiredState` may be `publish`, `draft`, `archive`, or `ignore`.

## Portable References

Committed content should not contain raw portal IDs, form GUIDs, CTA GUIDs, or
HubSpot-hosted asset URLs. Use logical refs instead:

| Logical ref | Producer source |
| --- | --- |
| `@portal` | The target account's portal ID |
| `@form:contact` | `content/forms/contact.json` or `content/forms/guids.json` |
| `@asset:hero.svg` | `content/assets/hero.svg` or `content/blog/assets/hero.svg` |

`hcms push` runs a local preflight before network writes. If content references
`@form:contact`, the form producer source must exist. If content references
`@asset:hero.png`, committed bytes must exist. `@cta:*` and `@menu:*` currently
fail closed because there are no producer adapters for them yet.

## Redirects

Redirects are separate from the page manifest. Configure their path with
`redirectsFile`, then run:

```bash
hcms redirects dev          # dry-run
hcms redirects dev --apply  # create/update HubSpot redirects
```

CSV redirects need at least:

```csv
routePrefix,destination,redirectStyle,isOnlyAfterNotFound
/old-about,/about,301,false
```

`isOnlyAfterNotFound=false` makes a redirect take precedence over an existing
live page at the same route. Use it deliberately during cutovers.

## Not Fully Automated

Some portal state is still UI-gated or depends on HubSpot account setup:

- connecting domains;
- choosing system pages such as the default 404;
- creating the initial blog container in some portals;
- native menus until a menu producer exists;
- theme settings values if the theme relies on HubSpot UI-managed settings.

Track those prerequisites in `uiGated` and check them with
`hcms preflight <account>` before writing content.
