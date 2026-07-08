# Marketing Emails

Git-backed pull and manifest-scoped **drag-and-drop push** for HubSpot marketing
emails (`/marketing/v3/emails`). This is **not** CMS website `templates/*.html`
(Source Code API) — it is the Marketing Email object model (campaign / workflow
email definitions).

For repository tree placement see [`CONTENT_LAYOUT.md`](CONTENT_LAYOUT.md#marketing-emails).

## Architecture

```text
Git canonical store                hubspot-cms-sync                 HubSpot
─────────────────                  ────────────────                 ───────
content/emails/campaigns/*.json ←  adapters/emails.mjs (pull)  ←  GET /marketing/v3/emails
content/emails/blocks/*.json
content/emails/template-paths.json
email-templates/*.html       ←──  adapters/email-templates.mjs
site.manifest.json emails[]  ──→  adapters/emails.mjs (push)  ──→  POST/PATCH /marketing/v3/emails
.sync-state/<portal>.registry.json (emails[key] = hubspotId)
```

**Adapter order:** `assets` → `email-templates` → `emails` on push (resolve
`@asset:` refs, upload shells, then campaign content). Pull reverses dependency
order so emails tokenize before asset bytes download.

## Repository layout

| Path | Role |
| --- | --- |
| `content/emails/campaigns/<key>.json` | Canonical campaign (preferred) |
| `content/emails/<key>.json` | Legacy flat layout (still supported) |
| `content/emails/blocks/<name>.json` | Reusable widgets merged at push |
| `content/emails/template-paths.json` | Verified `generated_layouts/*` → DnD remaps |
| `content/emails/subscriptions.json` | Subscription labels (reference only) |
| `content/emails/keys.json` | Optional name → key seed map |
| `email-templates/<name>.html` | Committed DnD shells (theme-relative in manifest) |

## Manifest allowlist

`site.manifest.json` controls which emails are pulled and pushed:

```json
{
  "emailTemplates": [
    { "key": "monthly-roundup", "path": "seventh-sense-theme/email-templates/monthly-roundup.html" }
  ],
  "emailBlocks": [
    { "key": "logo" },
    { "key": "footer-can-spam" }
  ],
  "emails": [
    {
      "key": "inside-insights-2026-07",
      "desiredState": "draft",
      "templatePath": "@hubspot/email/dnd/Start_from_scratch.html",
      "blocks": ["logo", "footer-can-spam"],
      "ctaPolicy": "fail"
    }
  ]
}
```

| `desiredState` | Pull | Push |
| --- | --- | --- |
| `ignore` | Skipped | Skipped |
| `pullOnly` | Yes | No |
| `draft` / `draftCopy` | Yes | Yes — creates/updates `BATCH_EMAIL` / `DRAFT` |
| `workflow` | Yes | Yes — draft pushed; workflow wiring is manual in HubSpot |
| `unsupportedAutomated` | Yes | Blocked unless `pushBlockedReasons` cleared |

| `ctaPolicy` | Meaning |
| --- | --- |
| `fail` | Unresolved CTA embeds block push (default) |
| `linkify` | Rewrite to plain `<a>` links (lossy; explicit opt-in) |

## Canonical record

Per-email JSON (abbreviated):

```json
{
  "key": "inside-insights-2026-07",
  "name": "Inside Insights — July 2026",
  "subject": "…",
  "emailTemplateMode": "DRAG_AND_DROP",
  "from": { "fromName": "…", "replyTo": "…" },
  "content": {
    "templatePath": "@hubspot/email/dnd/Start_from_scratch.html",
    "styleSettings": { "backgroundColor": "#f2f2f2", "primaryFont": "Arial, sans-serif" },
    "widgets": { }
  },
  "previewText": "…",
  "pushBlockedReasons": []
}
```

**Identity:**

- `key` is the portable filename stem and registry logical key.
- Derived from display `name` via `emailKeyForName()` with collision suffixing.
- HubSpot numeric `id` lives **only** in gitignored `registry.emails[key]`.

**`pushBlockedReasons`:** unverified template mapping, unresolved CTA, etc. Push
fails closed when non-empty.

**`unsupported.readOnly`:** `to`, `subscriptionDetails`, `previewKey`, timestamps,
and other portal-assigned fields — preserved on pull, never pushed.

## Registry

```json
{ "emails": { "inside-insights-2026-07": "216737633288" } }
```

Upsert: `registry.emails[key]` → `PATCH` by id; on miss, create via `POST`.
A fresh clone without `.sync-state/` cannot map ids until pull or first push.

## API endpoints

| Operation | Method | Path |
| --- | --- | --- |
| List | `GET` | `/marketing/v3/emails` (paginated) |
| Get / draft | `GET` | `/marketing/v3/emails/{id}` / `…/draft` |
| Create | `POST` | `/marketing/v3/emails` |
| Update | `PATCH` | `/marketing/v3/emails/{id}` |
| Delete | `DELETE` | `/marketing/v3/emails/{id}` |

Communication-preferences (`/communication-preferences/v3/definitions`) returns
403 with current scopes — subscription IDs are not resolved.

## Pull

Pull writes manifest-listed keys unless `HCMS_EMAIL_PULL_ALL=1`.

| Field | Notes |
| --- | --- |
| `key`, `name`, `subject` | Identity |
| `type`, `subcategory`, `emailTemplateMode`, `language` | Metadata |
| `from`, `subscriptionName`, `jitterSendTime`, `webversion.enabled` | Subset |
| `content.templatePath`, `content.widgets` | Body; hosted URLs → `@asset:` |
| `content.styleSettings` | When present on HubSpot |

Inventory (read-only): `hcms emails inventory <account>` →
`.sync-state/email-spike/`.

## Push

Gates (all required for pushable manifest entries):

1. Manifest `desiredState` in `draft` / `draftCopy` / `workflow`
2. `pushBlockedReasons` empty
3. Verified `template-paths.json` entry when using `generated_layouts/*` source
4. No unresolved CTAs (unless `ctaPolicy: linkify`)
5. Committed shell on portal, or `--allow-template-fallback` (dev)

Payload from `buildEmailPushPayload()`:

```json
{
  "name": "…",
  "subject": "…",
  "from": { "fromName": "…", "replyTo": "…" },
  "emailTemplateMode": "DRAG_AND_DROP",
  "content": {
    "templatePath": "@hubspot/email/dnd/Start_from_scratch.html",
    "widgets": { },
    "styleSettings": { },
    "flexAreas": { "main": { "boxed": true } }
  }
}
```

Omit: `to`, `subscriptionDetails`, `type` override, `activeDomain`, workflow
enrollment state. Create always yields `BATCH_EMAIL` / `DRAFT`.

### DnD editor requirements (prod-verified)

All four are required for the HubSpot drag-and-drop editor to load content **and**
apply house styles. Missing any one produces empty units, serif defaults, or an
unstyled white canvas.

| Requirement | Why |
| --- | --- |
| **`emailTemplateMode: "DRAG_AND_DROP"`** | `DESIGN_MANAGER` ignores `styleSettings` in the editor. Push must set mode on every PATCH. |
| **`content.styleSettings`** | Background, body box, fonts. Defaults: `DEFAULT_EMAIL_STYLE_SETTINGS` in `email-dnd.mjs`. |
| **`content.flexAreas.main` with `boxed: true`** | Logo + body grouped; `boxFirstElementIndex: 0`, `boxLastElementIndex: 1`. |
| **Widget `module_id` (`type: "module"`)** | `emailBody` 1155639, `emailLinkedImage` 1367093, `emailCanSpam` 2869621. `rich_text` → `module` on push. |

**Templates:** Push campaigns with `@hubspot/email/dnd/Start_from_scratch.html`
for `DRAG_AND_DROP` editor mode. Committed `email-templates/*.html` shells upload
to the theme but HubSpot **forces `DESIGN_MANAGER`** on prod when a campaign uses
them — styles break in the editor. Keep Beefree visual design in **widget HTML +
`styleSettings`** (via `hcms emails import beefree`); use `monthly-roundup.html`
as a slot scaffold only, not as the live `templatePath`.

**Prod writes:** `readOnlyPortalIds` blocks prod by default; set
`HCMS_ALLOW_PROD_PUSH=1` for one-off prod pushes.

## Scope

**In scope:** pull; manifest-scoped DnD push; `@asset:` rehost; Beefree Simple
Schema import (`hcms emails import beefree`) — maps `title`, `divider`, `button`,
and styled `paragraph` modules to DnD widget HTML plus `styleSettings` from
`template.settings`; Beefree **HTML+images zip** import (`hcms emails import
beefree-zip`) — preserves full visual layout (hero backgrounds, galleries, row
styles) in a single full-bleed `hs_email_body` widget, copies `images/*` to
`content/assets/beefree/<key>/`, and pins `templatePath` to
`@hubspot/email/dnd/Start_from_scratch.html` for `DRAG_AND_DROP` editor mode;
reusable blocks; semantic round-trip fingerprint.

**Out of scope:** workflow enrollment recreation; `subscriptionDetails` ID
fidelity; `to` / segment targeting; published-sent campaign replay; byte-identical
DnD JSON; bulk pull of entire prod corpus without manifest filter.

## Operator commands

```bash
hcms emails inventory prod
hcms pull prod                                    # manifest-listed emails
HCMS_EMAIL_PULL_ALL=1 hcms pull prod              # full corpus (spike)
hcms push dev --dry-run --only assets,email-templates,emails
hcms push dev --only assets,email-templates,emails
hcms push dev --only emails --allow-template-fallback   # dev without Marketing Pro shells
HCMS_ALLOW_PROD_PUSH=1 hcms push prod --only emails   # prod (scoped manifest recommended)
hcms emails import beefree schema.json --key <campaign> --template <shell-key> --write
hcms emails import beefree-zip export.zip --key <campaign> --name "Display name" --write
```

### Beefree zip import (HTML export)

Beefree's **Download HTML** bundle (`index.html` + `images/`) is the path for
catalog templates with hero images, row backgrounds, and galleries. The importer:

1. Unpacks the zip (requires `unzip` on PATH) or reads an extracted directory
2. Copies images → `content/assets/beefree/<key>/`
3. Rewrites `images/foo.png` → `@asset:beefree/<key>/foo.png` in widget HTML
4. Composes widget HTML from `<head>` styles + `nl-container` body (keeps
   responsive `@media` rules)
5. Writes provenance under `imports/beefree/<key>/` (`source.index.html`,
   `import.meta.json`, and `source.zip` when imported from zip)
6. Emits `content/emails/campaigns/<key>.json` with `emailTemplateMode:
   DRAG_AND_DROP` and `templatePath: @hubspot/email/dnd/Start_from_scratch.html`

**Do not** point zip-imported campaigns at committed `email-templates/*.html`
shells — HubSpot forces `DESIGN_MANAGER` on prod and the editor loses
backgrounds/fonts. Visual design lives in widget HTML + `styleSettings`.

Re-import after editing in Beefree: re-export zip, run the same command with
`--write` (overwrites campaign + assets + provenance).

## Verification

- **Unit:** `buildEmailPushPayload` golden shape, `buildDnDFlexAreas`, `attachDnDModuleIds`
- **Semantic equality:** `semanticEmailFingerprint()` — not byte-identical JSON
- **Integration:** `RUN_INTEGRATION=1` dev round-trip (optional)
- **Manual:** HubSpot email editor preview after push

## Not yet implemented

- `hcms reconcile` surface for marketing emails (still listed as out of CMS scope)
- `@subscription:<key>` ref grammar
- Default CTA linkify (opt-in `linkify` only)