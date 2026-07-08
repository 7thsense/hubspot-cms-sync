# Beefree HTML+images zip import

Operator runbook for importing Beefree **Download HTML** exports into git-backed
HubSpot DnD marketing emails. Requires **hubspot-cms-sync ≥ 0.26.2**.

See also [`EMAIL_API_CONTRACT.md`](EMAIL_API_CONTRACT.md) for manifest layout,
push gates, and DnD editor requirements.

## Prerequisites

| Requirement | Notes |
| --- | --- |
| `hubspot-cms-sync` ≥ **0.26.2** | `npm install --save-dev hubspot-cms-sync@0.26.2` |
| `unzip` on PATH | Only when importing a `.zip` file (not an extracted directory) |
| HubSpot private app key | `$HUBSPOT_KEY_DIR/<portalId>.key` or `~/.hubspot/<portalId>.key` |
| Manifest entry | Add the campaign `key` to `site.manifest.json` `emails[]` before push |
| `templatePath` | Always `@hubspot/email/dnd/Start_from_scratch.html` for zip imports |

## What the importer produces

```text
content/
  assets/beefree/<key>/          # images from Beefree export
  emails/campaigns/<key>.json    # canonical DnD campaign
imports/beefree/<key>/
  source.index.html              # pristine Beefree HTML (never edited)
  customized.index.html          # branded HTML after content.spec (if used)
  source.zip                     # copy of zip export (when imported from zip)
  content.spec.json              # optional copy overlay (you author this)
  import.meta.json               # asset manifest + provenance
```

The campaign uses a **single full-bleed** `hs_email_body` widget. Visual design
lives in widget HTML + `content.styleSettings`, not in committed
`email-templates/*.html` shells (those force `DESIGN_MANAGER` on prod and break
the editor).

## Step 1 — Import the Beefree export

Dry-run first (reports paths, no writes):

```bash
hcms emails import beefree-zip /path/to/export.zip \
  --key my-campaign-2026-07 \
  --name "My Campaign — July 2026" \
  --subject "Subject line" \
  --preview-text "Inbox preview text"
```

Write to the repo:

```bash
hcms emails import beefree-zip /path/to/export.zip \
  --key my-campaign-2026-07 \
  --name "My Campaign — July 2026" \
  --subject "Subject line" \
  --preview-text "Inbox preview text" \
  --write
```

You can also point at an **extracted directory** containing `index.html` and
`images/` (no `unzip` needed).

### Import pipeline (automatic)

1. Unpack zip or read directory
2. Apply `imports/beefree/<key>/content.spec.json` if present (`columnPatches` +
   ordered `replacements`)
3. Copy `images/*` → `content/assets/beefree/<key>/`
4. Rewrite `images/foo.png` → `@asset:beefree/<key>/foo.png`
5. **Materialize** CSS `background-image` on layout `<table>` rows to explicit
   `<img>` blocks (`class="image_block beefree-bg"`). HubSpot's DnD visual
   editor ignores table backgrounds but renders `<img>` tags.
6. Compose widget HTML from `<head>` styles + `nl-container` body
7. Emit campaign JSON with `emailTemplateMode: DRAG_AND_DROP`

Skip the content spec on first import:

```bash
hcms emails import beefree-zip export.zip --key my-campaign --no-content-spec --write
```

## Step 2 — Customize copy (content.spec.json)

Author `imports/beefree/<key>/content.spec.json` after the first import. Anchor
replacements on **unique HTML fragments** from the Beefree template (not
paraphrased copy). Use `columnPatches` for three-column card rows:

```json
{
  "key": "my-campaign-2026-07",
  "description": "Super Bowl pub template → branded newsletter",
  "columnPatches": [
    {
      "imageFile": "4_Snacks.png",
      "titleFrom": "TACOS",
      "titleTo": "DELIVERABILITY",
      "body": "Short card body with <a href=\"…\">link</a>."
    }
  ],
  "replacements": [
    {
      "find": "<p>…exact Beefree HTML…</p>",
      "replace": "<p>…your copy…</p>"
    }
  ]
}
```

Re-apply without re-importing the zip:

```bash
hcms emails import beefree-apply-content --key my-campaign-2026-07 --write
```

`source.index.html` stays pristine; `customized.index.html` holds the branded
result; `content/emails/campaigns/<key>.json` is regenerated.

Reference example: [`examples/beefree/content.spec.example.json`](../examples/beefree/content.spec.example.json).

## Step 3 — Manifest

Add to `site.manifest.json`:

```json
{
  "emails": [
    {
      "key": "my-campaign-2026-07",
      "desiredState": "draft",
      "templatePath": "@hubspot/email/dnd/Start_from_scratch.html",
      "blocks": [],
      "ctaPolicy": "fail"
    }
  ]
}
```

Use `blocks: []` for full-bleed Beefree imports (no logo/footer block merge).

## Step 4 — Push

Dev (write-capable portal):

```bash
hcms push dev --dry-run --only assets,emails
hcms push dev --only assets,emails
```

Prod (read-only by default):

```bash
HCMS_ALLOW_PROD_PUSH=1 hcms push prod --dry-run --only assets,emails
HCMS_ALLOW_PROD_PUSH=1 hcms push prod --only assets,emails
```

### Scoped prod push (recommended)

When the full manifest contains published emails that block push, use a
**minimal manifest** with only the campaign you are deploying. Override
`manifestPath` in a one-off config or point `loadConfig` at a scoped file:

```json
{
  "theme": { "name": "your-theme" },
  "pages": [],
  "forms": [],
  "emails": [
    {
      "key": "my-campaign-2026-07",
      "desiredState": "draft",
      "templatePath": "@hubspot/email/dnd/Start_from_scratch.html",
      "blocks": [],
      "ctaPolicy": "fail"
    }
  ]
}
```

Push order is always `assets` → `email-templates` → `emails`. Assets referenced
by `@asset:` tokens in the campaign JSON are uploaded automatically.

## Step 5 — Verify in HubSpot

1. Open the draft in the HubSpot email editor (hard-refresh if stale).
2. Confirm hero graphics, dividers, logos, and content images render.
3. Send a test email — `@asset:` tokens must resolve to hubfs URLs (no literal
   `@asset:` strings in the HTML).
4. Optional API check: `GET /marketing/v3/emails/{id}` →
   `content.widgets.hs_email_body.body.html` should contain `https://` image
   `src` values and zero `background-image:` styles.

## Re-import after Beefree edits

Re-export from Beefree, then:

```bash
hcms emails import beefree-zip new-export.zip --key my-campaign-2026-07 --write
hcms emails import beefree-apply-content --key my-campaign-2026-07 --write
hcms push <account> --only assets,emails
```

`content.spec.json` is preserved; re-apply content after re-import if Beefree
changed HTML fragments your replacements anchor on.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Colors show, no images in editor | Table `background-image` (pre-0.26.2) or stale draft | Upgrade to ≥ 0.26.2, re-apply import, re-push |
| Literal `@asset:…` in sent email | Asset bytes not committed or push skipped assets adapter | Commit `content/assets/…`, push `--only assets,emails` |
| Editor unchanged after push | Prod read-only guard or wrong registry id | Set `HCMS_ALLOW_PROD_PUSH=1`; confirm `.sync-state/<portal>.registry.json` `emails[key]` |
| Push 400 on unrelated email | Full manifest includes published campaigns | Use scoped manifest (see above) |
| `content spec skipped N missing fragment(s)` | Beefree re-export changed HTML | Update `find` strings in `content.spec.json` |
| `unzip: command not found` | Zip import without unzip | Install unzip or extract zip manually and pass directory path |
| `unknown command 'beefree-zip'` | Old hcms version | `npm install hubspot-cms-sync@0.26.2` |

## Using from another machine

```bash
git clone <repo>
cd <repo>
npm install                    # picks up hubspot-cms-sync from package.json
export HUBSPOT_KEY_DIR=~/.hubspot   # or your key directory
hcms doctor
# Import, customize, push as above
```

Minimum `package.json` devDependency:

```json
"hubspot-cms-sync": "0.26.2"
```

Local development from a sibling checkout:

```bash
npm install --save-dev ../hubspot-cms-sync
```