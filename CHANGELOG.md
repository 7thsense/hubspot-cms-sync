# Changelog

## 0.26.5 — 2026-10-16

### Fixed

- **One transient 5xx failed a whole `hcms republish`.** `republish.mjs` made its
  requests through a local `fetch` wrapper with no retries, so a single push-live 500
  on 1 of 90 posts failed a deploy (telepathdata/7thsense-website PR #16, run
  38855144603). republish now goes through `lib/hub.mjs`, which retries each request
  individually. A post that still fails after the retries counts as one failure and
  the rest of the run continues.
- **`lib/hub.mjs` retried POST creates.** `hub()` retried every method on 5xx and on
  network errors, including `POST` creates (pages, posts, emails, forms, redirects,
  tags, authors, contact properties). A 500 does not prove HubSpot did nothing, so a
  retry could create a duplicate. Retries on 5xx and network errors now apply only to
  idempotent-safe requests (`isRetrySafe`): GET/HEAD, PUT/PATCH/DELETE, and the POST
  actions that end in the same state when repeated (`…/schedule`,
  `…/draft/push-live`, `…/batch/read`, `…/search`). A 429 is retried for every
  method, because HubSpot rejects it before processing it.
- **republish read a failed listing as an empty one.** Its `getAll` ignored non-2xx
  pages, so a failing site-pages or posts listing republished nothing and exited 0.
  The listing now throws once its retries run out.
- `Retry-After` now accepts an HTTP-date as well as delta-seconds. The wait is capped
  at 30s. Without the header, the backoff is 0.5s, 1s, 2s, 4s (5 attempts, capped at
  8s per wait). Each retry logs one stderr line (`hub: POST … -> HTTP 500; retry 2/5
  in 500ms`).
- The blog adapter's File Manager upload (`overwrite: true`, so a repeated upload
  writes the same bytes to the same path) and the email DnD committed-template check
  (where a transient 5xx read as "template missing") now retry as well.

### Added

- `fetchWithRetry`, `isRetrySafe`, `retryDelayMs`, `HUB_MAX_ATTEMPTS` exported from
  `lib/hub.mjs`. `getAll()` takes an `opts` argument that it passes to `hub()`.
- Unit tests with mocked fetch: 500→204 succeeds, a persistent 500 fails after
  `HUB_MAX_ATTEMPTS`, 429 waits for `Retry-After`, a POST create is never resent after
  a 5xx or network error, and a republish post failure or listing failure is handled.

## 0.26.4 — 2026-10-16

### Fixed

- **`hcms republish --blog` failed on every post.** It rescheduled each live post at
  its original publishDate via `/cms/v3/blogs/posts/schedule`, and HubSpot rejects a
  past date with 400 (90/90 posts on the dev sandbox). Live posts are now re-rendered
  with `POST /cms/v3/blogs/posts/{id}/draft/push-live`, the call the blog adapter
  already uses for live posts, which leaves publishDate untouched. As with the page
  republish, this publishes the post's current draft.

### Added

- Unit tests: `republish.test.mjs` (blog republish requests, draft/temporary-slug
  skips, non-zero exit on a failed push-live)

## 0.26.2 — 2026-07-08

### Fixed

- **Beefree zip import:** materialize CSS `background-image` on layout `<table>`
  rows to explicit `<img>` blocks (`beefree-bg`). HubSpot's DnD visual editor
  renders colors from `background-color` but ignores table backgrounds; images
  now appear in the editor and in sent email.

### Added

- `materializeBeefreeBackgroundImages()`, `beefreeBackgroundImageBlock()` in
  `beefree-zip-import.mjs`
- Operator runbook: [`docs/BEEFREE_ZIP_IMPORT.md`](docs/BEEFREE_ZIP_IMPORT.md)
- Example `examples/beefree/content.spec.example.json`
- Unit tests: `email-import-beefree.test.mjs` (content.spec refresh + provenance)

## 0.26.1 — 2026-07-08

### Added

- `hcms emails import beefree-apply-content` — re-apply
  `imports/beefree/<key>/content.spec.json` without re-importing the zip
- `beefree-content.mjs`: `columnPatches`, ordered `replacements`, spec loader
- Provenance split: `source.index.html` (pristine export) vs
  `customized.index.html` (branded overlay)

## 0.26.0 — 2026-07-08

### Added

- `hcms emails import beefree-zip` — Beefree HTML+images zip export → DnD
  campaign + `content/assets/beefree/<key>/`
- `beefree-zip-import.mjs`: unzip, asset staging, `@asset:` rewrite,
  full-bleed `hs_email_body`, `Start_from_scratch` template pin
- Fixture `test/fixtures/beefree/pub-party-mini/` and unit tests
- Documentation in `EMAIL_API_CONTRACT.md`