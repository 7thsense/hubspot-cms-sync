# Marketing Email API Contract (v1 pull / draft-copy push)

HubSpot Marketing Email API v3 (`/marketing/v3/emails`). This document defines
what `hubspot-cms-sync` round-trips in v1 and what is intentionally dropped.

## Endpoints used

| Operation | Method | Path |
| --- | --- | --- |
| List | `GET` | `/marketing/v3/emails` (paginated) |
| Get one | `GET` | `/marketing/v3/emails/{id}` |
| Create (future push) | `POST` | `/marketing/v3/emails` |
| Update (future push) | `PATCH` | `/marketing/v3/emails/{id}` |
| Delete (tests cleanup) | `DELETE` | `/marketing/v3/emails/{id}` |

## Scopes

Current service keys work for list/get/create/patch/delete. Communication-
preferences (`/communication-preferences/v3/definitions`) returns 403 — subscription
IDs are **not** resolved in v1.

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
| `webversion.enabled` | Subset |
| `jitterSendTime` | Boolean |

## Pull — `unsupported.readOnly` (never pushed)

`to`, `activeDomain`, `businessUnitId`, `previewKey`, `subscriptionDetails`,
`createdById`, `updatedById`, timestamps, `publishDate`, `isAb`, `isPublished`,
`isTransactional`, `sendOnPublish`, `id`, `archived`, `stats`, folder ids,
full `webversion` domain/slug.

## Push v1 (planned) — allowed POST/PATCH body

```json
{
  "name": "…",
  "subject": "…",
  "from": { "fromName": "…", "replyTo": "…" },
  "content": {
    "templatePath": "@hubspot/email/dnd/…",
    "widgets": { }
  }
}
```

Omit: `to`, `subscriptionDetails`, `type` override, `activeDomain`, workflow state.

Create always yields `BATCH_EMAIL` / `DRAFT` on dev regardless of source `type`.

## Identity

- Git: `content/emails/<key>.json`
- Registry: `.sync-state/<portalId>.registry.json` → `emails[key] = hubspotId`
- Optional seed: `content/emails/keys.json` (id or name → key)

## Verification

Round-trip acceptance uses `semanticEmailFingerprint()` — not byte-identical JSON.