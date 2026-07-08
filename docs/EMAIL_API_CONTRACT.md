# Marketing Email API Contract (pull + DnD push)

HubSpot Marketing Email API v3 (`/marketing/v3/emails`). Defines what
`hubspot-cms-sync` round-trips and the **DnD editor requirements** discovered
from prod pushes (Inside Insights, July 2026).

## Endpoints used

| Operation | Method | Path |
| --- | --- | --- |
| List | `GET` | `/marketing/v3/emails` (paginated) |
| Get one / draft | `GET` | `/marketing/v3/emails/{id}` / `…/draft` |
| Create | `POST` | `/marketing/v3/emails` |
| Update | `PATCH` | `/marketing/v3/emails/{id}` |
| Delete (tests cleanup) | `DELETE` | `/marketing/v3/emails/{id}` |

## Scopes

Service keys work for list/get/create/patch/delete. Communication-preferences
(`/communication-preferences/v3/definitions`) returns 403 — subscription IDs are
**not** resolved in v1.

## Pull — fields kept (canonical)

| Field | Notes |
| --- | --- |
| `key` | Logical filename stem; collision-suffixed |
| `name`, `subject` | Display identity |
| `type`, `subcategory`, `emailTemplateMode`, `language` | Metadata |
| `from.fromName`, `from.replyTo` | Sender |
| `subscriptionName` | Label only (not id) |
| `templateMappingKey` | When mappable |
| `content.templatePath` | Portable path when verified mapping exists |
| `content.widgets` | Canonicalized; hosted URLs → `@asset:` |
| `content.styleSettings` | When present on HubSpot (DnD house style) |
| `webversion.enabled` | Subset |
| `jitterSendTime` | Boolean |

## Pull — `unsupported.readOnly` (never pushed)

`to`, `activeDomain`, `businessUnitId`, `previewKey`, `subscriptionDetails`,
`createdById`, `updatedById`, timestamps, `publishDate`, `isAb`, `isPublished`,
`isTransactional`, `sendOnPublish`, `id`, `archived`, `stats`, folder ids,
full `webversion` domain/slug.

## Push — POST/PATCH body (manifest-scoped DnD campaigns)

Minimum fields `buildEmailPushPayload()` sends:

```json
{
  "name": "…",
  "subject": "…",
  "from": { "fromName": "…", "replyTo": "…" },
  "emailTemplateMode": "DRAG_AND_DROP",
  "content": {
    "templatePath": "@hubspot/email/dnd/Start_from_scratch.html",
    "widgets": { },
    "styleSettings": {
      "backgroundColor": "#f2f2f2",
      "bodyColor": "#ffffff",
      "primaryFont": "Arial, sans-serif",
      "primaryFontColor": "#444444",
      "primaryFontSize": 15
    },
    "flexAreas": {
      "main": {
        "boxed": true,
        "boxFirstElementIndex": 0,
        "boxLastElementIndex": 1,
        "sections": []
      }
    }
  }
}
```

Omit: `to`, `subscriptionDetails`, `type` override, `activeDomain`, workflow
state.

Create always yields `BATCH_EMAIL` / `DRAFT` on dev regardless of source
`type`.

### DnD editor requirements (prod-verified)

All four are required for the HubSpot drag-and-drop editor to load content **and**
apply house styles (gray background, white body box, sans-serif fonts). Missing
any one produces empty units, serif defaults, or an unstyled white canvas.

| Requirement | Why |
| --- | --- |
| **`emailTemplateMode: "DRAG_AND_DROP"`** | `DESIGN_MANAGER` emails ignore `styleSettings` in the DnD editor preview. Push must set mode on every PATCH — HubSpot does not infer it from widgets. |
| **`content.styleSettings`** | Background, body box, fonts. Defaults: `DEFAULT_EMAIL_STYLE_SETTINGS` in `email-dnd.mjs`. |
| **`content.flexAreas.main` with `boxed: true`** | Logo section + single body column grouped; `boxFirstElementIndex: 0`, `boxLastElementIndex: 1`. One-widget-per-section / `boxed: false` does not apply styles. |
| **Widget `module_id` (+ `type: "module"`)** | Stable HubSpot DnD module type ids (`emailBody` 1155639, `emailLinkedImage` 1367093, `emailCanSpam` 2869621). `rich_text` carriers are converted to `module` on push. |

**Template guidance:** `@hubspot/email/dnd/Start_from_scratch.html` is the
proven shell (all Everything Email newsletters). Committed theme shells under
`email-templates/` work for slot structure but still require the four requirements
above.

**Push order:** `email-templates` adapter runs before `emails` so committed
shells exist on the portal. Use `--allow-template-fallback` on dev when Marketing
Pro blocks custom shell upload (falls back to `Start_from_scratch`).

**Prod writes:** gated by `readOnlyPortalIds` in config; set
`HCMS_ALLOW_PROD_PUSH=1` to clear the prod portal id for one-off pushes.

## Identity

- Git: `content/emails/campaigns/<key>.json` (or `content/emails/<key>.json`)
- Blocks: `content/emails/blocks/<name>.json`
- Registry: `.sync-state/<portalId>.registry.json` → `emails[key] = hubspotId`
- Optional seed: `content/emails/keys.json` (id or name → key)

## Verification

Round-trip acceptance uses `semanticEmailFingerprint()` — not byte-identical
JSON. Unit tests assert push payload shape (`emailTemplateMode`, `styleSettings`,
`flexAreas.main.boxed`, widget `module_id`).