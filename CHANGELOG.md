# Changelog

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