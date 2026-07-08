# Changelog

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