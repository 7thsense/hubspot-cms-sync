# Marketing Email Sync — Implementation Plan

Bidirectional import/export of HubSpot **marketing email templates** (Marketing
Email API v3) for `hubspot-cms-sync` (`hcms`). Work happens in this package;
`7thsense-website` consumes a released (or linked) version and holds canonical
`content/emails/` plus manifest entries.

**Status:** Draft v3 — incorporates Codex review (2026-07-07) and adversarial
review pass #2 (2026-07-07). Claude Fable review blocked on monthly spend limit;
independent reviewer used same contract.

**Verdict:** Proceed with **pull-first only** (Phase 0–3). Do **not** implement
push (Phase 4+) until registry persistence, asset-tree policy, CTA pull pipeline,
and manifest-aware gates are specified at the file level below.

---

## Goal

1. **Prod (portal 529456, read-only):** pull marketing emails, iterate on
   canonical on-disk shape, build fixture corpus.
2. **Dev (portal 246389711, writable, 0 emails today):** round-trip a small
   manifest allowlist with **semantic** (not byte-identical) equality.
3. **Operator safety:** prod never written; fail-closed preflight before any
   network push; loud reporting of lossy/partial fields.

This is **not** CMS website `templates/*.html` (Source Code API). It is the
`/marketing/v3/emails` object model (campaign / workflow email definitions).

---

## Empirical baseline (live API probes)

| Metric | Prod (529456) | Dev (246389711) |
| --- | ---: | ---: |
| Non-archived emails | 311 | 0 |
| Archived emails | 31 | — |
| `AUTOMATED` state | 273 | — |
| `DESIGN_MANAGER` mode | 156 | — |
| `DRAG_AND_DROP` mode | 155 | — |
| Unique `content.templatePath` | 16 | — |
| `generated_layouts/*` paths | 144 emails | — |
| Bodies with hosted images | 216 | — |
| Bodies with CTA embeds | 18 | — |

**API facts (dev):**

- `POST /marketing/v3/emails` creates `BATCH_EMAIL` / `DRAFT` (works).
- `type: AUTOMATED_EMAIL` on create still yields `BATCH_EMAIL` / `DRAFT`.
- `PATCH` and `DELETE` work on dev.
- HubSpot auto-assigns `subscriptionDetails` on create when omitted.
- Communication-preferences API returns 403 with current scopes.

---

## Architecture

```text
Git canonical store                hubspot-cms-sync                 HubSpot
─────────────────                  ────────────────                 ───────
content/emails/<key>.json    ←──   adapters/emails.mjs (pull)  ←──  GET /marketing/v3/emails
content/emails/template-paths.json
content/emails/subscriptions.json (labels only, v1)
content/assets/**            ←──   adapters/assets.mjs (email images here in v1)
site.manifest.json emails[]  ──→   adapters/emails.mjs (push)  ──→  POST/PATCH /marketing/v3/emails
.sync-state/<portal>.registry.json (emails[key]=id)
```

**Adapter dependency:** `emails` `dependsOn: ['assets']`.

**Pull order:** reverse topo — `emails` before `assets` (tokenize `@asset:` before
byte download), same as blog.

**Push order:** forward topo — `assets` before `emails` (resolve `@asset:` to
hosted URLs).

---

## On-disk schema (v1)

### Per-email: `content/emails/<emailKey>.json`

```json
{
  "key": "onboarding-email-3-analyze-list-sorting",
  "name": "HubSpot On-Boarding Email 3 - Analyze List & Sorting",
  "subject": "…",
  "type": "AUTOMATED_EMAIL",
  "subcategory": "automated",
  "emailTemplateMode": "DESIGN_MANAGER",
  "language": "en",
  "from": {
    "fromName": "Seventh Sense",
    "replyTo": "hello@theseventhsense.com"
  },
  "subscriptionName": "Onboarding Emails",
  "templateMappingKey": "generated-4622780893",
  "content": {
    "templatePath": "@hubspot/email/dnd/Start_from_scratch.html",
    "widgets": { }
  },
  "webversion": { "enabled": false },
  "jitterSendTime": true,
  "unsupported": {
    "readOnly": {
      "to": { },
      "activeDomain": "www.theseventhsense.com",
      "businessUnitId": "0",
      "previewKey": "…",
      "subscriptionDetails": { "subscriptionId": "1244233" }
    }
  },
  "pushBlockedReasons": []
}
```

**Identity (Codex #1 — collision-safe):**

- `emailKey` is the portable filename stem and registry logical key.
- Derive from name via `emailKeyForName(name)` **with forms-style collision
  suffixing** (`-2`, `-3`, …) and loud pull notes.
- Optional seed map `content/emails/keys.json` for known emails (name → key),
  analogous to forms `SEED_FORMS`.
- Source HubSpot `id` lives **only** in gitignored `registry.emails[key]`.
- Never key reconcile or push solely by display `name`.

**`unsupported.readOnly`:** fields preserved for audit but never pushed.

**`pushBlockedReasons`:** human-readable blockers (unverified template mapping,
unresolved CTA, AUTOMATED source without `draftCopy` override, etc.). Push
skips or fails closed per manifest policy.

### `content/emails/template-paths.json`

Verified remaps only. Each entry:

```json
{
  "generated-4622780893": {
    "sourcePath": "generated_layouts/4622780893.html",
    "emailTemplateMode": "DESIGN_MANAGER",
    "targetPath": "@hubspot/email/dnd/Start_from_scratch.html",
    "verified": true,
    "verifiedOn": "dev",
    "notes": "Manually confirmed create+render on dev 2026-07-07"
  }
}
```

Push **must not** use unverified mappings. Preflight checks `verified: true`.

### `content/emails/subscriptions.json` (v1 — labels only)

Records subscription **names** seen on prod for operator reference. **Not**
used for push ID resolution in v1 (no communication-preferences scope). Push
omits `subscriptionDetails`; HubSpot assigns dev default on create.

### Manifest: `site.manifest.json`

```json
{
  "emails": [
    {
      "key": "onboarding-email-3-analyze-list-sorting",
      "desiredState": "draftCopy",
      "ctaPolicy": "fail",
      "templateMappingKey": "generated-4622780893"
    }
  ]
}
```

| `desiredState` | Meaning |
| --- | --- |
| `ignore` | Not in git; not pulled to `content/emails/` |
| `pullOnly` | Pulled/canonicalized; never pushed |
| `draftCopy` | Push as `BATCH_EMAIL` / `DRAFT` content clone |
| `unsupportedAutomated` | Pulled for inventory; push blocked unless operator overrides |

| `ctaPolicy` | Meaning |
| --- | --- |
| `fail` | Unresolved CTA embeds block push (default) |
| `linkify` | Rewrite to plain `<a>` links (lossy; explicit opt-in) |

### Registry (gitignored)

```json
{
  "emails": { "onboarding-email-3-analyze-list-sorting": "4522675894" }
}
```

**Registry contract (blocking):** extend `emptyRegistry`, `loadRegistry`, and
`saveRegistry` in `src/lib/refs.mjs` to include `emails: {}`. Without this,
`persistAccountRegistry` drops `registry.emails` after every adapter — breaking
upsert, reconcile, and idempotency. Unit-test persist round-trip.

Unlike forms (`content/forms/guids.json`), email HubSpot ids live **only** in
registry. A fresh clone without `.sync-state/` cannot map ids until pull runs.

No `registry.subscriptions` in v1 — deferred until `@subscription:<key>` ref
grammar exists.

---

## Explicit v1 scope

### In scope

- Pull from prod (read-only) into canonical JSON
- Draft-copy push for manifest allowlist with **verified** template mappings
- `@asset:` tokenization + rehost via `assets` adapter (bytes under
  `content/assets/`, not a third `content/emails/assets/` tree in v1)
- Semantic round-trip equality via `canonicalEmail()` fingerprint
- Reconcile surface keyed by `emailKey`
- Push preflight scan of `content/emails/**`
- Loud `unsupported` + `pushBlockedReasons` reporting (forms pattern)

### Out of scope (v1)

- Recreating `AUTOMATED` / workflow enrollment state
- `subscriptionDetails.subscriptionId` fidelity
- `to` list / segment targeting
- Published/sent campaign recreation
- Byte-identical JSON round-trip for DnD widget trees
- Bulk commit of all 311 prod emails
- `@subscription:<key>` tokens
- Default CTA linkify (opt-in only)

**AUTOMATED emails:** may be `draftCopy` as **content clones** (subject +
widgets) with loud notes that workflow wiring is manual.

---

## Implementation phases

### Phase 0 — Spike + inventory (1–2 days)

**Deliverables:**

1. `src/spike/email-inventory.mjs` (or `hcms emails inventory <account>`)
2. Raw prod snapshots → `.sync-state/email-spike/prod-raw/` (gitignored)
3. `docs/EMAIL_API_CONTRACT.md` — allowed POST/PATCH fields, explicit drop list
4. `test/fixtures/emails/` — 10-email corpus (simple draft, DESIGN_MANAGER,
   DnD 34-widget, image-heavy, CTA embed, system `PUBLISHED`, etc.)
5. Draft `content/emails/template-paths.json` with `verified: false` until
   manually validated on dev
6. Prototype `src/lib/email-canonical.mjs` + unit tests

**Exit criteria:** 5+ canonical fixtures; template-path **candidates** drafted
for all 16 unique prod paths (verification is manual per mapping); API contract
doc reviewed; CTA inventory run for email bodies (`cta-inventory.mjs` extended
or `--content` includes `content/emails/` after spike pull).

### Phase 1 — Pull-only adapter (2–3 days)

| File | Change |
| --- | --- |
| `src/adapters/emails.mjs` | `pull()` only |
| `src/lib/email-canonical.mjs` | `canonicalEmail`, `emailKeyForName`, `detectUnsupported`, collision guard |
| `src/lib/refs.mjs` | Add `emails: {}` to registry load/save (required) |
| `src/cta-inventory.mjs` | Email body scan + `resolveCtaEmbeds` on pull path |
| `test/unit/adapter-emails.test.mjs` | Fixture-based tests |

**Pull behavior:**

- Default: pull only manifest-listed keys (or `--all` for spike)
- Collision-safe key assignment
- **CTA pipeline (blog parity):** `resolveCtaEmbeds()` before
  `canonicalizeRefs()` — default `ctaPolicy: fail` preserves raw embeds and sets
  `pushBlockedReasons`; `linkify` rewrites to plain `<a>`. Never emit `@cta:`
  tokens into canonical email JSON.
- `refs.canonicalize()` on widget HTML/JSON strings and structured widget bodies
- Register `registry.emails[key] = sourceId`
- **Populate `pushBlockedReasons` on pull** (unverified mapping, unresolved CTA,
  AUTOMATED without manifest override)
- Emit notes for unsupported fields and unverified template paths
- Do **not** write ignored emails to `content/emails/` (avoids asset scan bloat)

### Phase 2 — Manifest + reconcile (1 day, before push)

| File | Change |
| --- | --- |
| `src/manifest.mjs` | Validate `emails[]` schema |
| `src/reconcile.mjs` | Add `marketing-emails` surface; remove from `UNSUPPORTED_SURFACES` |
| `docs/CONTENT_LAYOUT.md` | Document email layout |

**Reconcile (deferred until registry + manifest subset exist):**

- `fetch`: paginated `getAll('/marketing/v3/emails')`
- `live(e)`: exclude archived; define predicate for draft junk vs inventory-worthy
  (document explicitly — do not use `live: () => true` or ~300 prod orphans
  appear against a 10-key git tree)
- `keyOf(e)`: reverse-lookup `registry.emails` by HubSpot `id` → `emailKey`;
  name-slug fallback only with loud ambiguity warning
- `reconcile()` must `loadAccountRegistry(portalId)` — git index alone cannot
  map numeric email ids to filename stems
- Optional **manifest-scoped** mode: only classify emails listed in manifest

### Phase 3 — Preflight + assets (1–2 days)

| File | Change |
| --- | --- |
| `src/push.mjs` | Add `content/emails/*.json` to `preflightRefs` scan (exclude sidecar JSON) |
| `src/adapters/assets.mjs` | Extend `collectReferencedAssetPaths` to walk `content/emails/*.json` after pull |

**Two-layer preflight (do not conflate):**

1. **`preflightRefs` (account-independent, in `push.mjs`):** scan
   `content/emails/<key>.json` carriers for `@asset:` / `@portal`; `@cta` must
   **not** appear (pull pipeline prevents it). `@asset` → bytes at
   `content/assets/<path>` only (v1 — no third asset tree).

2. **`preflightEmails` or emails `push()` preamble (manifest-aware):** verify
   manifest `draftCopy` entries, `pushBlockedReasons` empty, `template-paths.json`
   entry `verified: true`, target template probe. `hcms preflight` (bootstrap
   scopes/blog) does **not** replace this — document `hcms push --dry-run` or
   dedicated `hcms emails preflight`.

### Phase 4 — Draft-only push (2–3 days)

**Push gates (all required for `draftCopy`):**

1. Manifest allowlist
2. `pushBlockedReasons` empty
3. `template-paths.json` entry `verified: true`
4. No unresolved CTAs (unless `ctaPolicy: linkify`)
5. Target template preflight (probe create or documented known-good list)

**Upsert:** `registry.emails[key]` → `PATCH` by id. If registry miss: fail with
`pushBlockedReasons` unless exactly one HubSpot search-by-name match (prove
uniqueness; never silent overwrite on name collision).

**Payload (v1):** `name`, `subject`, `from`, `content` (resolved templatePath +
widgets). Omit `to`, `subscriptionDetails`, `activeDomain`, `type` override.

**Always result:** `BATCH_EMAIL` / `DRAFT` on target.

### Phase 5 — Dev round-trip tests (2 days)

**Unit:** collision, canonicalization, preflight, push payload builder, semantic
equality helper.

**Integration** (`RUN_INTEGRATION=1`, dev only):

1. `zz-roundtrip-scratch-email` create → push → pull → semantic equal
2. Second push idempotent (no duplicate)
3. Subject mutation round-trips
4. Image-heavy email with asset rehost
5. `finally` delete scratch emails

**Acceptance:** `canonicalEmail(pulledDev) ≈ canonicalEmail(gitSource)` — not
raw byte identity. Define `canonicalEmail()` to strip HubSpot-assigned volatiles
(`subscriptionDetails`, `previewKey`, timestamps), normalize widget key order,
and ignore `unsupported.readOnly` for comparison.

### Phase 6 — Website integration (1 day)

In `7thsense-website`:

1. Link or bump `hubspot-cms-sync`
2. Add `content/emails/` subset (5–10 emails)
3. Extend `site.manifest.json`
4. Update `CUTOVER.md` — emails move from unsupported to manifest-driven

---

## PR stack

| PR | Scope |
| --- | --- |
| PR1 | Phase 0 spike + fixtures + `EMAIL_API_CONTRACT.md` + `email-canonical` unit tests |
| PR2 | Registry `emails` namespace in `refs.mjs` + manifest schema + persist tests |
| PR3 | Pull-only `emails` adapter + CTA pull pipeline |
| PR4 | Assets scan + `preflightRefs` extension |
| PR5 | Manifest-aware email preflight + draft-only push (1–2 verified emails) |
| PR6 | Reconcile surface (manifest-scoped) + integration round-trip |
| PR7 | `7thsense-website` small subset |

---

## Testing matrix

| Layer | What |
| --- | --- |
| Unit | Key collision, `detectUnsupported`, template mapping, preflight tokens, semantic equality |
| Fixture | 10 prod-derived JSON files in `test/fixtures/emails/` |
| Integration | Dev scratch round-trip, idempotent re-push, cleanup |
| Manual | HubSpot email preview UI on dev after push |
| Reconcile | `hcms reconcile prod dev` reports email synced/orphan/missing |

---

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| `generated_layouts/*` invalid on dev | Verified mapping table; push blocked until verified |
| DnD JSON normalization drift | Semantic equality, not byte compare |
| 216 image-heavy emails | Assets adapter before email push |
| 18 CTA embeds | Default `ctaPolicy: fail`; linkify opt-in |
| Name collisions | Suffix disambiguation + loud notes |
| Pull-all asset bloat | Only manifest keys written to `content/emails/` |
| Mid-push preflight miss | Extend `push.mjs` scan before enabling push |

---

## Acceptance criteria

1. `hcms pull prod` writes canonical files with zero portal IDs and zero hosted
   URLs (only `@asset:` tokens).
2. `hcms push dev` creates exactly N manifest `draftCopy` emails on empty dev.
3. `hcms pull dev` after push yields semantic equality with git source.
4. Second `hcms push dev` creates zero new emails.
5. Prod push still hard-blocked.
6. `hcms reconcile prod dev` classifies email orphans/missing/synced by `emailKey`.
7. Unit tests pass in CI; integration passes with `RUN_INTEGRATION=1`.

---

## Review history

| Date | Reviewer | Verdict |
| --- | --- | --- |
| 2026-07-07 | Codex (gpt-5.5) | Proceed with changes — identity, preflight, CTA, template mapping |
| 2026-07-07 | Claude Fable (`claude-fable-5[1m]`) | **Blocked** — monthly spend limit; review not executed |
| 2026-07-07 | Independent adversarial (Fable contract) | Pull-first OK; **block push** until registry `emails` in `refs.mjs`, CTA pull pipeline, two-layer preflight, reconcile registry lookup |

### v3 changes from review #2

- Registry: mandatory `emails: {}` in `refs.mjs` load/save
- Assets: v1 uses `content/assets/` only (no third tree)
- CTA: blog-parity `resolveCtaEmbeds` on pull; no `@cta` in canonical JSON
- Preflight: split account-independent (`preflightRefs`) vs manifest-aware gates
- Reconcile: deferred; requires registry reverse-lookup + manifest-scoped mode
- Upsert: registry-primary; name match only with uniqueness proof
- Phase 0 exit: mapping candidates, not 95% verified in 1–2 days
- Push v1 cap: 1–2 manually verified emails before scaling allowlist

---

## Operator commands (target)

```bash
# Inventory (read-only)
hcms emails inventory prod

# Pull subset
hcms pull prod

# Preflight before push
hcms preflight dev

# Push allowlisted draft copies
hcms push dev

# Reconcile
hcms reconcile prod dev
```