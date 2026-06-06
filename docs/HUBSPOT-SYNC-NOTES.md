# HubSpot Sync — Gotchas & Operational Notes

_HubSpot CMS API gotchas hit while building the [seventh-sense](https://github.com/telepathdata/7thsense-website) reference site with this engine. Examples reference that site; the behaviors are general._

Hard-won notes from migrating the Seventh Sense site/blog onto a CMS sandbox.
**Read this before pointing `sync/*` at production.** Every item here cost real
debugging time; they are the difference between a sync script that works and one
that silently does the wrong thing.

---

## 1. Credentials & scopes — the #1 time sink

There are three credential types and they are **not** interchangeable:

| Type | Looks like | Use it for | Gotcha |
|---|---|---|---|
| **Personal Access Key (PAK)** | `CiRu…` (base64) or surfaced as a long token | the `hs` CLI (theme upload) | **Cannot grant the `content` scope** — so PAKs *cannot* create CMS pages/blog posts. PAK scopes are also **immutable**: "editing" = generating a new key. |
| **Service Key** (BETA) | `pat-na2-…` | our `sync/*` scripts (direct Bearer) | **Editable** scopes (no regen), but scope changes have **propagation lag** (~30–60s) — a call can still 401 right after you save. Retry before assuming failure. |
| **Private App token** | `pat-na1-…` | alternative to service key | Also grants `content`; heavier to manage. |

- Use service keys as `Authorization: Bearer <key>` directly — **no exchange**. (A `CiRu…` value is a PAK refresh token; it 401s as a Bearer and must be exchanged at `POST /localdevauth/v1/auth/refresh`.)
- **Read vs write are separate scopes.** `crm.schemas.contacts.write` does **not** include `.read`. The forms adapter must work write-only, so it create-or-patches instead of relying on list-then-decide behavior. Design sync scripts to not *require* the read scope.
- Per-operation scopes we actually needed:
  - Pages create/publish: **`content`**
  - Blog posts create/publish: **`content`**
  - File Manager (image re-host / recovery): **`files`**
  - Create HubSpot forms: **`forms`** (`forms-write`)
  - Create/patch custom contact properties: **`crm.schemas.contacts.write`**
  - Domains / business-units reads: a domains scope we never got on the sandbox key (blog-create needs it; see §4).

## 2. Account types — not all can host content

- **`DEVELOPER_TEST`** accounts (created from an app-developer account) include Design Manager (theme dev) but **cannot host CMS pages** — the `content`/`cms.pages.site_pages.write` scope is not grantable. Theme upload works, page creation never will.
- A **free CMS Developer Sandbox** (`accountType: STANDARD`, signup at `app.hubspot.com/signup-hubspot/cms-developers`) **can** host pages/blog. This is the right target for a staging mirror.
- Check `accountType` (via the PAK token exchange response `accountType`, or `/account-info/v3/details`) before assuming a portal can take content.

## 3. Publishing — the two big quirks

- **`POST …/draft/push-live` silently no-ops on first publish.** It returns `204` but the content stays `DRAFT`. **Use the schedule endpoint with a near-future date instead:**
  `POST /cms/v3/pages/site-pages/schedule` (and `/cms/v3/blogs/posts/schedule`) with `{"id", "publishDate": <now + 90s>}`. It fires ~75–90s later and the page goes live.
- **`publishDate` must be in the future** — "now" is rejected with `publishDate must be in the future`.
- **Pages/posts require a non-empty title** to publish (`CONTENT_TITLE_MISSING`). Set `htmlTitle`/`name` before scheduling.
- **Template changes do not re-render already-published content.** After editing a template, you must **re-publish every affected page/post** (schedule them again) to pick up the new template. This is why a dynamic blog-post template still showed old hardcoded content until all 68 posts were re-scheduled.
- **⚠️ Re-scheduling a post resets its `publishDate` to the scheduled time** — bulk re-scheduling 68 posts clobbered their original 2017–2026 dates to "today," wrecking chronological order. Fix: `PATCH /cms/v3/blogs/posts/{id}` with the original `publishDate` (keeps it `PUBLISHED`, restores the date). The blog adapter always sends `publishDate` from the snapshot so a re-push restores dates.
- **Invalidate a cached *blog listing*** by re-PUTting the blog (`PUT /content/api/v2/blogs/{id}`) — that flips the edge-cache tag from the old listing page (`CT-…`) to the blog (`B-…`) and serves the current `listing_template_path`.
- **Edge cache is aggressive:** blog listing/pages serve with `s-maxage=36000` (10h). Cache-busting query params do **not** bypass it. Publishing invalidates by `edge-cache-tag`; otherwise expect lag.

## 4. Blog specifics

- **Creating a blog is UI-gated.** `POST /content/api/v2/blogs` fails with `BLOG_HS_SITE_DOMAIN_WRITE_SCOPE_MISSING` ("publish blog on domain ''") even with `content` + a domain in the body — binding a blog to the `hs-sites` system domain needs UI-level permission a service key can't get. **Create the blog once in Settings → Website → Blog**, then automate everything else.
- **Updating a blog DOES work via API:** `PUT /content/api/v2/blogs/{id}` — use it to fix `slug`, `item_template_path`, `listing_template_path` after the UI creates it with wrong defaults (it defaults to `@hubspot/elevate` templates and a `seventh-sense-blog` slug).
- **`listing_page_id` overrides `listing_template_path`.** A blog auto-creates a listing *page* that renders `/blog` with its own (default) template, ignoring `listing_template_path`. That listing page is **not** reachable via the site-pages or legacy-pages API (404). **Fix that worked:** `PUT /content/api/v2/blogs/{id}` with `{"listing_page_id": 0}` to clear the override, then re-PUT the blog to bust the edge cache → `/blog` then renders `listing_template_path`.
- **Post slugs are full paths** (e.g. `blog/spf-dkim-…`), not relative to the blog root. Push them as-is.
- The legacy CMS blogs API can have a **stale "Old" blog** + many `DRAFT`/`SCHEDULED`/`-temporary-slug-` junk posts. Filter to `state == PUBLISHED`, non-`Old` blog, real slug, body length > 500 before migrating (see `blog-sync` pruning).

## 5. Images & File Manager

- Blog bodies reference images on **legacy hosts** (`cdn2.hubspot.net`, `f.hubspotusercontent00.net`) whose public URLs are often **404 / dead** — these images were deleted years ago and 404 on the live prod blog too. Don't expect 100% recovery (we got 50/172).
- Recover what's live via the current host; for dead URLs, fall back to **File Manager search** (`GET /files/v3/files/search?name=<stem>`) — needs the **`files`** scope.
- On push, **re-host** each image to the target File Manager (`POST /files/v3/files`, multipart, `options.access=PUBLIC_INDEXABLE`) and **rewrite** body/featured URLs to the new hosted URL. Never leave prod hotlinks.

## 6. Forms

- All redesign forms shipped as **static mockups** (`onsubmit="preventDefault(); alert(...)"`). Fix = keep the styled markup, POST to the **Forms Submission API**: `POST https://api.hsforms.com/submissions/v3/integration/submit/{portalId}/{formGuid}` (shared `js/hs-forms.js`). Don't use `{% form %}` embeds — they replace the custom design.
- **The submission API enforces the form's `required` fields.** A lighter entry point (e.g. the audit-cta email-only form) submitting to a fuller form gets `REQUIRED_FIELD` errors. Pattern: make forms **email-only-required at the API layer**, enforce richer UX with per-page HTML5 `required`. One form can then back multiple entry points.
- Custom fields must exist as **contact properties** first, and be on the form. The forms adapter upserts both.

## 7. Module fields & repeater defaults (refactor blocker)

- A field's **`name` cannot be a reserved word**: `name`, `label`, `id`, `type`, `body`, `children`, `default`, `required`, `locked`, etc. Upload fails with `field name cannot be 'X'`. Rename (e.g. `label`→`caption`, `name`→`title`, `body`→`body_html`) and update the `{{ item.X }}` HubL refs.
- **Theme deploys are per-file (Source Code API PUT), not transactional across files** — a mid-deploy failure (e.g. a bad field name) leaves some module files updated and others not, so a republish renders a *mixed/broken* page. Always re-run `sync:push` to completion (and re-verify fidelity) after fixing.
- **⚠️ HubSpot does NOT render repeater (group + `occurrence`) field DEFAULTS for `{% module %}` instances in coded templates** — neither for existing pages nor newly-created ones. Simple field defaults (text/richtext) render; **repeater loops come up empty**, so a page that relied on the repeater default loses all its repeated content (stats, cards, FAQ, pricing rows). This broke home-page fidelity in the Phase-2 module refactor.
  - **Fixes:** (a) write the content as **field VALUES on the page instance** via the Pages API `widgets` map (the correct content/theme model — content lives on the page, template is generic); or (b) pass the content as **template-level tag params** `{% module "x" path=… group=[{…}] %}` (HubSpot honors these at render, unlike `fields.json` repeater defaults); or (c) a conditional `{% if module.items %}…{% else %}<orig>{% endif %}` fallback. Do **not** rely on repeater `default` arrays alone.
  - **⚠️ Tag-param serialization (b) only works for SIMPLE content.** It worked for `big-stats` (`stats=[{"num":"+44%","caption":"…"}]`) but **broke for rich content** — repeater items containing inline SVG (`width="24"`) or quoted phrases (`"who's getting what"`) fail HubL param parsing (`Error parsing … encountered '24'`), because HubL string quoting in tag params doesn't cleanly accept JSON-escaped `\"`/apostrophes. **For rich/HTML repeater content, use the `widgets` API (page-instance JSON values), not tag params.** Pattern A is fine for plain-text repeaters; the `widgets` API is the universal path.

## 8. Transport / tooling environment

- **No CLI.** The entire sync runs on the HubSpot REST API via `fetch` with a service-key Bearer token (`~/.hubspot/<portalId>.key`). The theme uses the **CMS Source Code v3 API** (`GET/PUT /cms/v3/source-code/published/{metadata,content}/<theme>/<path>`); pages/blog/forms/content use their respective v3 APIs.
- We previously used the `hs` CLI for theme pull/push and **dropped it**: the whole-tree `hs cms upload` silently no-op'd (it mis-named the theme after the build dir), the per-dir form was unreliable, and the CLI dragged in `rollup` (which periodically broke on the npm optional-dependency bug). The per-file Source Code API PUT is deterministic and idempotent (create-or-replace by path).
- The CLI had **no page/blog content commands** anyway — content was always API-only; `hs cms` only managed theme assets. So every adapter is now uniform: one transport, one auth model.

## 9. Operational checklist for the unified sync

Production is currently read-only. The supported deployment target is the dev
sandbox `246389711`; the production portal `529456` is hard-blocked in `hcms push`.

1. Create service keys with the needed scopes:
   - Prod pull key at `~/.hubspot/529456.key` (`content` plus read scopes needed for the resources you pull).
   - Dev push key at `~/.hubspot/246389711.key` (`content`, `files`, `forms`, `crm.schemas.contacts.write`).
2. Confirm the target portal can host CMS content (§2).
3. Create the UI-gated resources once (§4): blog container, homepage designation,
   domain setup, theme setting values, and native menus.
4. Pull production into git:
   ```sh
   hcms pull -- prod
   ```
5. Review the diff and prove portability:
   ```sh
   git diff
   hcms corpus
   ```
6. Preflight the dev sandbox:
   ```sh
   hcms preflight -- dev
   ```
7. Push and publish to dev:
   ```sh
   hcms push -- dev --publish
   ```
8. Re-publish live pages/posts after template changes (§3):
   ```sh
   hcms republish --portal 246389711 --all
   hcms republish --portal 246389711 --all --blog
   ```
9. Verify the rendered site:
   ```sh
   npm test
   ```

For the complete operator flow and GitHub Actions deployment path, use
[`sync-runbook.md`](./sync-runbook.md). For the architectural rationale, use
[`deployment-architecture.md`](./deployment-architecture.md).
