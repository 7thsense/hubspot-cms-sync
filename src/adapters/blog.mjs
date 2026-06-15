// sync/adapters/blog.mjs — blog adapter for the bidirectional sync framework.
//
// Refactors sync/blog-sync.mjs into the adapter interface (pull/push), wired to
// the Stage 1 foundation (sync/lib/hub.mjs, canonical.mjs, refs.mjs). It owns the
// blog container, authors, tags and posts of ONE account.
//
// What changed vs sync/blog-sync.mjs (codex findings #5/#6/#7):
//
//   #6 Identity by blogSlug, NOT blogName / blogs[0]. Pull records each post's
//      blogSlug, authorSlug and tagSlugs (slug-keyed, portable). Push selects the
//      EXACT container by slug via hub.resolveBlogBySlug (which matches by slug,
//      never objects[0]), and FAILS on an ambiguous / missing container — the stale
//      "Old" blog (slug blog-old-pages) can never win.
//
//   #5 URL-rewrite query-string bug. The old rewriteUrls() replaced the bare URL
//      first, so `orig?width=...` lost its prefix and the query-variant regex no
//      longer matched. Here canonicalize-on-pull (rawUrlToToken) rewrites the
//      `orig?query` form BEFORE the bare `orig`, so query-string variants collapse
//      onto the same @asset token. Unit-tested.
//
//   #7 Two-phase publish-date. Scheduling a post requires a FUTURE publishDate, but
//      that clobbers the real 2017–2026 date. So push (when publishing) schedules a
//      near-future date, polls the LIVE post until it goes PUBLISHED, then PATCHes
//      the ORIGINAL publishDate back to preserve chronology. publishPost() is the
//      pure-ish driver; the schedule/poll/patch hub calls are injected so it is
//      unit-testable without the network.
//
//   Assets. Post bodies embed hosted image URLs on legacy hosts (cdn2.hubspot.net,
//   *.hubspotusercontent*, googleusercontent, theseventhsense.com). Pull rewrites
//   each KNOWN asset URL (from content/blog/assets/manifest.json: originalUrl ->
//   localFile) into a logical @asset:<localFile> token and registers the asset key
//   in the refs registry. Push re-hosts each asset to the TARGET File Manager and
//   resolves @asset tokens to the target's hosted URLs (refs.resolve hard-fails on
//   any unmapped asset). Canonical post JSON therefore NEVER carries a hosted URL.
//
// Adapter contract:
//   pull(acct, { contentDir, registry }) -> { pulled, notes }
//   push(acct, { contentDir, registry }) -> { pushed, notes }
// PRODUCTION 529456 is READ-ONLY; this adapter never hardcodes a portal — the
// orchestrator passes `acct`, and push writes only to whatever acct it is given.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join, resolve as resolvePath, basename, extname } from 'node:path';
import { createHash } from 'node:crypto';

import { hub, getAll } from '../lib/hub.mjs';
import { stableStringify } from '../lib/canonical.mjs';
import { wireToFile, fileToWire } from '../lib/posts-format.mjs';
import { resolve as resolveRefs, canonicalize as canonicalizeRefs } from '../lib/refs.mjs';
import { resolveCtaEmbeds, loadInventory } from '../cta-inventory.mjs';

const API = 'https://api.hubapi.com';

export const name = 'blog';
// Blog posts embed asset refs; on push we re-host assets ourselves and populate
// the registry's asset map, so we do not depend on a separate assets adapter for
// blog imagery. Forms/CTAs are not referenced by blog posts in this corpus.
export const dependsOn = ['assets'];

// ── layout ──────────────────────────────────────────────────────────────────
// contentDir is the repo root content dir; the blog lives under content/blog.
const BLOG_SUBDIR = 'blog';
const POSTS_SUBDIR = 'posts';
const ASSETS_SUBDIR = 'assets';
const CONTAINER_FILE = 'container.json';

function blogDir(contentDir) {
  return join(resolvePath(contentDir), BLOG_SUBDIR);
}

// ── asset URL helpers ─────────────────────────────────────────────────────────

// Hosts that carry per-account / legacy imagery we want to canonicalize away.
const IMG_HOST = /(hubfs|hubspotusercontent|cdn\d*\.hubspot\.net|theseventhsense\.com|googleusercontent)/i;

// Deterministic local filename for an original asset URL (mirrors blog-sync.mjs so
// an existing assets/manifest.json keeps working). Same input -> same name.
export function localAssetName(url) {
  const h = createHash('sha1').update(url).digest('hex').slice(0, 10);
  let base = decodeURIComponent(basename(String(url).split('?')[0]))
    .replace(/[^\w.\-]/g, '_')
    .slice(-60);
  if (!extname(base)) base += '.img';
  return `${h}-${base}`;
}

// Escape a string for safe embedding in a RegExp.
function reEscape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * rawUrlToToken(text, assetMap) -> text with raw asset URLs replaced by tokens.
 *
 * assetMap: { originalUrl -> localFileName }. For each entry we replace BOTH the
 * query-string variant (`orig?...`) AND the bare `orig` with `@asset:<localFile>`.
 *
 * THE FIX (codex #5): the `orig?query` form is rewritten FIRST. The old code did
 * the bare replace first, which turned `orig?width=80` into `token?width=80` and
 * left a dangling query the later regex could no longer match. Order matters; this
 * is the function the unit test pins.
 *
 * Pure: no I/O. Returns the input unchanged when text is empty/non-string.
 */
export function rawUrlToToken(text, assetMap) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const [orig, file] of Object.entries(assetMap || {})) {
    if (!orig || !file) continue;
    const token = `@asset:${file}`;
    // 1. query-string variant FIRST: orig?<query> (up to a quote/space/paren).
    out = out.replace(new RegExp(reEscape(orig) + `\\?[^"'\\s)]*`, 'g'), token);
    // 2. then the bare URL.
    out = out.split(orig).join(token);
  }
  return out;
}

/**
 * canonicalizeField(text, assetMap, registry) -> portable text.
 *
 * THE FIX (codex #4 — data loss / de-portability on a re-hosted pull):
 *
 * rawUrlToToken only knows the ORIGINAL (prod) URLs recorded in the blog asset
 * manifest. When we pull from a RE-HOSTED account (e.g. the dev sandbox), the post
 * body carries that account's OWN hosted URLs — which are NOT manifest keys — so the
 * manifest pass leaves them LITERAL, and a literal per-account URL would get committed
 * to git. That is the de-portability bug.
 *
 * So after the manifest pass we fold ANY remaining hosted image/CTA/form/menu/portal
 * ref through refs.canonicalize. That collapses every `…/hubfs/<portal>/<tail>` URL
 * into a portable `@asset:<tail>` token (host + portal discarded), and tokenizes any
 * lingering CTA/form GUID or bare portal id. After this, NO literal per-account hosted
 * URL or GUID can ever land in the committed canonical content.
 *
 * Idempotent: refs.canonicalize matches raw URLs/GUIDs only; the `@asset:` / `@cta:` /
 * `@portal` tokens it (and rawUrlToToken) emit are inert to it, so re-canonicalizing
 * already-canonical content is a no-op (it does not clobber existing tokens).
 *
 * Note the two token *flavours* both round-trip cleanly:
 *   • `@asset:<manifestLocalFile>` (from rawUrlToToken) — rehosted by THIS adapter.
 *   • `@asset:<hubfsPathTail>`      (from refs.canonicalize) — rehosted by the assets
 *     adapter (blog dependsOn ['assets']), which scans content/blog/** for exactly
 *     these tokens. Either way push's resolveRefs hard-fails on an unmapped token.
 */
export function canonicalizeField(text, assetMap, registry, ctaCtx) {
  if (typeof text !== 'string' || text.length === 0) return text;
  // CTAs FIRST (before asset/ref canonicalize): each legacy CTA embed carries a
  // per-account portal id + a CTA GUID + a cta/redirect & no-cache.hubspot.com image
  // URL. Resolving the whole embed to a portable styled <a href> here means NO @cta
  // token (no producer adapter, codex #3/#5) and NO per-account guid survives to be
  // mis-tokenized by canonicalizeRefs. Unknown / still-tracked CTAs are PRESERVED raw
  // and surfaced loudly via ctaCtx (never silently dropped).
  let s = text;
  if (ctaCtx && ctaCtx.inventory) {
    const r = resolveCtaEmbeds(s, ctaCtx.inventory);
    if (r.text !== s) ctaCtx.resolved = (ctaCtx.resolved || 0) + 1;
    s = r.text;
    for (const g of r.unresolved) ctaCtx.unresolved.add(g);
    for (const n of r.notes) ctaCtx.notes.add(n);
  }
  s = rawUrlToToken(s, assetMap);
  if (!registry) return s;
  // codex #5 (extended to re-hosted URLs): strip the ?<query> off any hosted hubfs
  // image URL BEFORE canonicalize folds it to @asset:<tail>. The refs.hubfsUrl regex
  // captures up to a quote/space/paren, so `…/img.png?width=80` would otherwise become
  // a SEPARATE `@asset:img.png?width=80` token (mismatching the bare `@asset:img.png`,
  // and registering a path with no committed bytes). Collapsing the query first makes
  // every width-variant land on the SAME @asset token — same guarantee the manifest
  // pass already gives for known URLs.
  s = stripHubfsQuery(s);
  // Fold any per-account ref the manifest didn't know about into logical tokens.
  return canonicalizeRefs(s, registry);
}

// Drop the `?<query>` from any hosted `…/hubfs/<portal>/<tail>?<query>` URL so the
// query-variant and the bare URL canonicalize onto the SAME @asset token. Matches the
// same host/portal shape refs.hubfsUrl uses; leaves non-hubfs URLs (and their queries)
// untouched.
const HUBFS_WITH_QUERY = /(https?:\/\/[a-z0-9.-]+\/hubfs\/\d{5,}\/[^"'\\\s)?]+)\?[^"'\s)]*/gi;
export function stripHubfsQuery(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text.replace(HUBFS_WITH_QUERY, '$1');
}

// ── container ──────────────────────────────────────────────────────────────────

// Legacy v2 endpoint lists blog containers (content groups) with id + slug.
async function listBlogs(acct) {
  const { ok, status, json } = await hub(acct, 'GET', '/content/api/v2/blogs?limit=100');
  if (!ok) {
    const msg = json?.message || json?.category || JSON.stringify(json).slice(0, 200);
    throw new Error(`GET /content/api/v2/blogs -> ${status}: ${msg}`);
  }
  return (json.objects || []).map((b) => ({
    id: String(b.id),
    name: b.name,
    slug: b.slug,
    url: b.absolute_url,
    itemTemplatePath: b.item_template_path,
    listingTemplatePath: b.listing_template_path,
    listingPageId: b.listing_page_id,
  }));
}

// ── PULL ─────────────────────────────────────────────────────────────────────

/**
 * pull(acct, { contentDir, registry }) -> { pulled, notes }
 *
 * Reads the account's blog (container + authors + tags + posts) and writes
 * canonical, slug-keyed files under <contentDir>/blog. Refs in post bodies are
 * logical-ized: asset URLs become @asset tokens (registered into `registry`), and
 * any other per-account ref (CTA/form/portal) is folded by refs.canonicalize via
 * the orchestrator's normal pass — here we own the asset rewrite because the asset
 * key is the blog manifest's local filename, which refs.mjs cannot know.
 *
 * Container identity is its SLUG. We pull EVERY non-"Old" container's posts, but
 * store each post keyed by slug with its blogSlug recorded so push can target the
 * exact container.
 */
export async function pull(acct, { contentDir, registry }) {
  const notes = [];
  const dir = blogDir(contentDir);
  const postsOut = join(dir, POSTS_SUBDIR);
  mkdirSync(postsOut, { recursive: true });

  const blogs = await listBlogs(acct);
  // Ignore the stale "Old" blog (codex #6): its slug is blog-old-pages and its
  // name carries an "| Old" marker. We never migrate it.
  const liveBlogs = blogs.filter(
    (b) => b.slug !== 'blog-old-pages' && !/\|\s*old\b/i.test(b.name || ''),
  );
  if (liveBlogs.length === 0) {
    throw new Error(`No live blog container found for portal ${acct.portalId} (all containers look stale/Old).`);
  }
  const blogBySlug = new Map(liveBlogs.map((b) => [b.slug, b]));
  const blogById = new Map(blogs.map((b) => [String(b.id), b]));

  const authors = await getAll(acct, '/cms/v3/blogs/authors');
  const tags = await getAll(acct, '/cms/v3/blogs/tags');
  const posts = await getAll(acct, '/cms/v3/blogs/posts');

  const authorById = new Map(authors.map((a) => [String(a.id), a]));
  const tagById = new Map(tags.map((t) => [String(t.id), t]));

  // Container config (one canonical file per live container, keyed by slug).
  for (const b of liveBlogs) {
    const container = {
      slug: b.slug,
      name: b.name,
      itemTemplatePath: b.itemTemplatePath || '',
      listingTemplatePath: b.listingTemplatePath || '',
      // Canonicalize the listing-page override to 0 so diffs stay clean and push
      // re-clears it (SYNC-NOTES §4: a non-zero listingPageId masks the template).
      listingPageId: 0,
    };
    writeFileSync(
      join(dir, containerFileFor(b.slug)),
      stableStringify(container),
    );
  }

  // Build the asset map (originalUrl -> localFile) from the committed manifest, so
  // the same physical bytes resolve to the same @asset key across accounts.
  const assetMap = loadAssetManifest(dir);
  // CTA inventory (guid -> { destinationHref, name, tracked }) for the SOURCE portal.
  // Built one-time, READ-ONLY, by `node sync/cta-inventory.mjs <account>`. Each blog
  // CTA embed is resolved to a portable styled <a href> so the committed body carries
  // NO @cta token and NO per-account guid. Unknown / still-tracked CTAs are preserved
  // raw and surfaced loudly below (codex #3/#5).
  const ctaCtx = { inventory: loadInventory(acct.portalId), unresolved: new Set(), notes: new Set(), resolved: 0 };
  // Register every known asset key into the registry so push can demand a mapping.
  for (const file of Object.values(assetMap)) {
    registry.assets[file] = registry.assets[file] ?? true;
  }
  delete registry.__rev_assets;

  // Authors are content: write the canonical, account-portable authors.json (bio +
  // profile + @asset-tokenized avatar), sorted by slug for a stable diff. push reads
  // this back, so a bio edited in git reaches HubSpot (and vice-versa).
  const portableAuthors = authors
    .map((a) => projectAuthor(a, assetMap, registry, ctaCtx))
    .sort((x, y) => String(x.slug || '').localeCompare(String(y.slug || '')));
  writeFileSync(authorsFile(dir), stableStringify(portableAuthors));

  let pulled = 0;
  for (const p of posts) {
    const container = blogById.get(String(p.contentGroupId));
    // Skip posts that belong to the stale/old container or to a container we are
    // not migrating.
    if (!container || !blogBySlug.has(container.slug)) continue;
    if (!p.slug) continue;

    const author = authorById.get(String(p.blogAuthorId));
    const portable = {
      slug: p.slug,
      blogSlug: container.slug,
      name: p.name,
      htmlTitle: p.htmlTitle || p.name,
      state: p.state,
      authorSlug: author?.slug || slugifyName(author?.displayName || author?.fullName) || null,
      authorName: author?.displayName || author?.fullName || null,
      tagSlugs: (p.tagIds || [])
        .map((id) => tagById.get(String(id)))
        .filter(Boolean)
        .map((t) => t.slug || slugifyName(t.name))
        .filter(Boolean)
        .sort(),
      tagNames: (p.tagIds || [])
        .map((id) => tagById.get(String(id))?.name)
        .filter(Boolean),
      metaDescription: p.metaDescription || '',
      featuredImage: canonicalizeField(canonUrl(p.featuredImage), assetMap, registry, ctaCtx),
      featuredImageAltText: p.featuredImageAltText || '',
      useFeaturedImage: p.useFeaturedImage ?? false,
      postBody: canonicalizeField(p.postBody || '', assetMap, registry, ctaCtx),
      postSummary: canonicalizeField(p.postSummary || '', assetMap, registry, ctaCtx),
      // publishDate is preserved verbatim — it IS the canonical chronology source
      // (codex #7). It is content here, not a volatile timestamp to strip.
      publishDate: p.publishDate || null,
    };
    // Canonical post format is frontmatter + HTML body (.md). Reshaping is lossless
    // to the wire object (lib/posts-format.mjs round-trip), so the push payload is
    // byte-identical to the old .json path. Drop any stale sibling .json from the
    // pre-frontmatter format so push never sees the same post twice.
    const base = join(postsOut, postFileFor(p.slug));
    writeFileSync(`${base}.md`, wireToFile(portable));
    if (existsSync(`${base}.json`)) rmSync(`${base}.json`);
    pulled++;
  }

  // Surface every CTA we could NOT resolve to a portable link — loud, never silent.
  for (const n of ctaCtx.notes) notes.push(n);
  if (ctaCtx.unresolved.size > 0) {
    notes.push(
      `⚠ ${ctaCtx.unresolved.size} CTA(s) preserved as raw embed HTML (unknown / still-tracked): ` +
        `${[...ctaCtx.unresolved].sort().join(', ')}. Run \`node sync/cta-inventory.mjs ${acct.name}\` ` +
        `to resolve them before pushing (the push preflight will fail-closed on any surviving @cta token).`,
    );
  }

  notes.push(
    `containers: ${liveBlogs.length} | authors: ${authors.length} | tags: ${tags.length} | posts: ${pulled} | CTA blocks resolved: ${ctaCtx.resolved || 0} | CTAs preserved: ${ctaCtx.unresolved.size}`,
  );
  return { pulled, notes };
}

// Featured-image URLs carry ?width= variants; strip the query so it matches the
// manifest key (which is stored bare).
function canonUrl(u) {
  if (!u) return u || '';
  return String(u);
}

// ── AUTHORS (bidirectional: content/blog/authors.json <-> HubSpot blog authors) ──
//
// Blog authors are CONTENT: their bio + profile render in author cards and the
// per-post byline. authors.json is the canonical, account-portable store — the
// mirror of a page's widgets, for the blog. pull() writes it from the account's
// authors; push() reads it and PATCHes each author's editable profile so the bio in
// git reaches HubSpot (an author the sandbox seeded with an empty bio was the
// spf-dkim fidelity divergence). Without this, ensureAuthor only ever set name+slug
// on CREATE, so bios silently never synced.

function authorsFile(dir) {
  return join(dir, 'authors.json');
}

// HubSpot read-only / per-account / volatile author fields — never committed (they
// would churn the diff and are not portable). Everything else (bio, social, email,
// avatar, names, language) is canonical content.
const AUTHOR_DROP = new Set(['id', 'created', 'updated', 'deletedAt']);

// The editable profile fields push writes onto a HubSpot author. avatar is handled
// separately (it carries an @asset token that must resolve on the target).
const AUTHOR_PROFILE_FIELDS = ['bio', 'fullName', 'email', 'facebook', 'linkedin', 'twitter', 'website'];

// Project a raw HubSpot author to its canonical, committed shape (drop volatile
// fields; tokenize the avatar URL to @asset where the bytes are in the blog asset
// manifest, exactly like featuredImage). Used on pull.
function projectAuthor(a, assetMap, registry, ctaCtx) {
  const out = {};
  for (const [k, v] of Object.entries(a)) {
    if (!AUTHOR_DROP.has(k)) out[k] = v;
  }
  if (typeof out.avatar === 'string' && out.avatar) {
    out.avatar = canonicalizeField(canonUrl(out.avatar), assetMap, registry, ctaCtx);
  }
  return out;
}

// Load authors.json into a lookup keyed by BOTH slug and displayName (lowercased),
// so push can match the author a post references however it was keyed.
function loadAuthorProfiles(dir) {
  const f = authorsFile(dir);
  const byKey = new Map();
  if (!existsSync(f)) return byKey;
  let list;
  try {
    list = JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return byKey;
  }
  for (const a of Array.isArray(list) ? list : []) {
    for (const k of [a.slug, a.displayName, a.fullName, a.name]) {
      if (k) byKey.set(String(k).toLowerCase(), a);
    }
  }
  return byKey;
}

// Build the PATCH body for a HubSpot author from its canonical profile. avatar is
// resolved (@asset -> target URL) DEFENSIVELY: if the asset isn't on the target,
// leave HubSpot's current avatar rather than hard-failing the whole blog push.
function authorPatchBody(profile, registry) {
  const body = {};
  for (const k of AUTHOR_PROFILE_FIELDS) {
    if (profile[k] != null) body[k] = profile[k];
  }
  if (typeof profile.avatar === 'string' && profile.avatar) {
    try {
      body.avatar = resolveRefs(profile.avatar, registry);
    } catch {
      /* avatar bytes not on the target account — keep the existing avatar */
    }
  }
  return body;
}

// ── PUSH ─────────────────────────────────────────────────────────────────────

/**
 * push(acct, { contentDir, registry }) -> { pushed, notes }
 *
 * Reads canonical post files, resolves their @asset (and any other logical) refs
 * to THIS account's ids/URLs, and creates-or-updates each post by slug. Asset
 * tokens are resolved by re-hosting every referenced asset to the target File
 * Manager and recording the hosted URL in the registry's asset map; refs.resolve
 * then swaps tokens for URLs and HARD-FAILS on any unmapped asset.
 *
 * Container is selected by slug (resolveBlogBySlug — never objects[0]); a missing
 * container throws the UI-gated "create the blog first" instruction.
 *
 * publish: when opts.publish is set, each post goes through the two-phase publish
 * (schedule future -> poll live -> PATCH original publishDate). Defaults to draft
 * (the orchestrator drives publishing separately in most flows).
 */
export async function push(
  acct,
  {
    contentDir,
    registry,
    publish = false,
    limit,
    // only: restrict the push to specific posts by file base name (no extension),
    // e.g. ['blog__hello']. Enables a scoped sample push without touching the rest
    // of the blog — used by verification harnesses; undefined means "all posts".
    only,
    dryRun = false,
    hubFn = hub,
    // Injectable clock + sleep so the "wait past every scheduled publish" gate
    // (codex #7 final-pass fix) is unit-testable WITHOUT actually waiting ~90s.
    now = () => Date.now(),
    sleep = defaultSleep,
  } = {},
) {
  const notes = [];
  const dir = blogDir(contentDir);
  const postsDir = join(dir, POSTS_SUBDIR);
  if (!existsSync(postsDir)) {
    throw new Error(`No posts at ${postsDir} — run blog.pull first.`);
  }

  // Assets are now uploaded by the `assets` adapter (blog dependsOn ['assets'],
  // so it runs first on push), which re-hosts every @asset under content/assets/
  // to the target File Manager and records the URLs in registry.assets — refs.resolve
  // then replaces @asset tokens below. (The old blog-local rehostAssets path is
  // retired: one upload location, no /blog-migrated vs /synced-assets split.)

  // Accept the canonical frontmatter format (.md) and the legacy .json. If both
  // exist for one post, .md wins; dedup by base name so a post is never pushed
  // twice during the transition.
  const byBase = new Map();
  for (const f of readdirSync(postsDir)) {
    const m = /^(.*)\.(md|json)$/.exec(f);
    if (!m) continue;
    const [, base, ext] = m;
    if (ext === 'md' || !byBase.has(base)) byBase.set(base, f);
  }
  let files = [...byBase.values()].sort();
  if (only) {
    const want = new Set(only);
    files = files.filter((f) => want.has(f.replace(/\.(md|json)$/, '')));
  }
  if (limit) files = files.slice(0, limit);

  // Group posts by their blogSlug and resolve each container exactly once. The
  // frontmatter codec yields the same wire object JSON.parse would have.
  const posts = files.map((f) => {
    const raw = readFileSync(join(postsDir, f), 'utf8');
    return f.endsWith('.md') ? fileToWire(raw) : JSON.parse(raw);
  });
  const containerCache = new Map();
  async function containerIdFor(blogSlug) {
    if (containerCache.has(blogSlug)) return containerCache.get(blogSlug);
    const blog = await resolveBlogObjBySlugVia(hubFn, acct, blogSlug);
    if (!blog) {
      throw new Error(
        `No blog container with slug "${blogSlug}" on portal ${acct.portalId}. ` +
          `Creating a blog is UI-gated — create it once in Settings → Website → Blog ` +
          `(SYNC-NOTES §4), then re-run.`,
      );
    }
    const id = String(blog.id);
    containerCache.set(blogSlug, id);
    // BLOG THEME (user: "make sure the blog theme gets set correctly"): set the
    // item/listing template paths from the committed container.json and clear the
    // listing_page_id override (a non-zero one masks listing_template_path —
    // SYNC-NOTES §4). Re-PUT busts the edge cache; idempotent (same values = skip).
    if (!dryRun) {
      const note = await applyContainerConfig(hubFn, acct, dir, blogSlug, blog);
      if (note) notes.push(note);
    }
    return id;
  }

  const authorCache = await nameIndex(hubFn, acct, '/cms/v3/blogs/authors', ['slug', 'displayName']);
  // Canonical author profiles (bio + social + avatar) keyed by slug/displayName, and
  // a per-run set so each author's profile is PATCHed at most once (not per post).
  const authorProfiles = loadAuthorProfiles(dir);
  const patchedAuthors = new Set();
  const tagCache = await nameIndex(hubFn, acct, '/cms/v3/blogs/tags', ['slug', 'name']);
  const existing = new Map(
    (await getAllVia(hubFn, acct, '/cms/v3/blogs/posts')).map((p) => [p.slug, String(p.id)]),
  );

  let created = 0,
    updated = 0,
    published = 0,
    failed = 0;
  // Posts to date-restore in a FINAL pass (after every schedule has fired), so a
  // not-yet-fired scheduled publish can't clobber the date set per-post (the race
  // that churned 33/68 dates to "today" — SYNC-NOTES §3 / codex #7).
  const toRestore = [];
  // Latest epoch-ms any post is scheduled to auto-publish. The final restore pass
  // must run AFTER this fires; otherwise a late schedule re-clobbers the date we
  // just restored. publishPost returns each post's scheduledMs; we keep the max.
  let latestScheduleMs = 0;

  for (const p of posts) {
    try {
      const contentGroupId = await containerIdFor(p.blogSlug);
      const blogAuthorId = await ensureAuthor(acct, p, authorCache, hubFn, {
        profiles: authorProfiles,
        registry,
        dryRun,
        patched: patchedAuthors,
      });
      const tagIds = [];
      for (const t of postTagPairs(p)) {
        tagIds.push(await ensureTag(acct, t, tagCache, hubFn));
      }

      const body = {
        contentGroupId,
        name: p.name,
        htmlTitle: p.htmlTitle || p.name,
        slug: p.slug,
        // Resolve @asset (and any other logical) tokens to THIS account's values.
        // refs.resolve hard-fails if any token is unmapped → push aborts loudly.
        postBody: resolveRefs(p.postBody || '', registry),
        postSummary: resolveRefs(p.postSummary || '', registry),
        metaDescription: p.metaDescription || '',
        featuredImage: resolveRefs(p.featuredImage || '', registry),
        featuredImageAltText: p.featuredImageAltText || '',
        useFeaturedImage: p.useFeaturedImage ?? false,
        blogAuthorId,
        tagIds,
        // Always send the original publishDate so a re-push restores the real
        // 2017–2026 chronology instead of leaving "now" from a prior schedule.
        publishDate: p.publishDate || undefined,
        state: publish ? 'PUBLISHED' : 'DRAFT',
      };

      if (dryRun) {
        notes.push(`would ${existing.has(p.slug) ? 'update' : 'create'}: ${p.slug}`);
        continue;
      }

      let id;
      if (existing.has(p.slug)) {
        id = existing.get(p.slug);
        await hubOk(hubFn, acct, 'PATCH', `/cms/v3/blogs/posts/${id}`, body);
        updated++;
      } else {
        const j = await hubOk(hubFn, acct, 'POST', '/cms/v3/blogs/posts', body);
        id = String(j.id);
        existing.set(p.slug, id);
        created++;
      }

      if (publish) {
        const r = await publishPost(acct, id, p.publishDate, { hubFn, now, sleep });
        if (r.scheduledMs > latestScheduleMs) latestScheduleMs = r.scheduledMs;
        if (p.publishDate) toRestore.push({ id, slug: p.slug, publishDate: p.publishDate });
        published++;
      }
    } catch (e) {
      failed++;
      notes.push(`✖ ${p.slug}: ${e.message}`);
    }
  }

  // FINAL date-restore pass (codex #7): re-PATCH each canonical publishDate and
  // VERIFY it stuck. CRITICAL: this pass must run AFTER every post's scheduled
  // publish (now+90s) has fired — otherwise a late schedule clobbers the date we
  // just restored (the race that churned 33/68 dates on the last full push). So we
  // WAIT past the LATEST schedule time (plus a settle margin) before restoring.
  // sleep/now are injectable so unit tests don't actually wait ~90s.
  let restored = 0;
  if (!dryRun && publish && toRestore.length) {
    await waitUntil(latestScheduleMs + SCHEDULE_SETTLE_MS, { now, sleep });
    for (const { id, slug, publishDate } of toRestore) {
      const ok = await restoreCanonicalDate(acct, id, publishDate, { hubFn, sleep });
      if (ok) restored++;
      else notes.push(`⚠ date-restore unconfirmed for ${slug} (verify chronology)`);
    }
  }

  notes.push(
    `created ${created} | updated ${updated} | published ${published} | restored ${restored} | failed ${failed}`,
  );

  // codex #9: a per-post failure must NOT report a clean push. The old code counted
  // `failed` and returned `done`, so a half-pushed blog (some posts silently lost)
  // looked successful to the orchestrator. Now any failure THROWS, surfacing every
  // offending slug; the partial writes already done are durable (re-run converges),
  // but the run is unambiguously a failure. dryRun never "fails" (no writes attempted).
  if (!dryRun && failed > 0) {
    const offenders = notes.filter((n) => n.startsWith('✖')).join('\n  ');
    throw new Error(
      `blog.push: ${failed} post(s) failed — push did NOT complete cleanly ` +
        `(no silent data loss):\n  ${offenders}`,
    );
  }

  return { pushed: created + updated, notes };
}

// ── two-phase publish (codex #7) ───────────────────────────────────────────────

/**
 * publishPost(acct, id, originalPublishDate, { hubFn, now, pollMs, maxPolls, sleep })
 *
 * Three phases, all idempotent:
 *   1. SCHEDULE a near-future publishDate (HubSpot rejects "now"/past — SYNC-NOTES
 *      §3). POST /cms/v3/blogs/posts/schedule { id, publishDate: now+90s .000Z }.
 *   2. POLL the LIVE (non-draft) post until state === PUBLISHED (the first publish
 *      via push-live no-ops; the schedule fires ~75–90s later).
 *   3. PATCH the ORIGINAL publishDate back so chronology survives (re-scheduling
 *      clobbered it to the scheduled time — SYNC-NOTES §3 / codex #7). Skipped when
 *      there is no original date.
 *
 * Side-effecting hub calls are injected (hubFn/sleep/now) so this is unit-testable
 * with a mock that walks DRAFT -> PUBLISHED and asserts the final PATCH date.
 */
export async function publishPost(
  acct,
  id,
  originalPublishDate,
  { hubFn = hub, now = () => Date.now(), pollMs = 5000, maxPolls = 40, sleep = defaultSleep } = {},
) {
  const scheduledMs = now() + 90_000;
  const future = toIso(scheduledMs);
  await hubOk(hubFn, acct, 'POST', '/cms/v3/blogs/posts/schedule', {
    id: String(id),
    publishDate: future,
  });

  // Poll the live post until it reports PUBLISHED.
  let live = false;
  for (let i = 0; i < maxPolls; i++) {
    const { ok, json } = await hubFn(acct, 'GET', `/cms/v3/blogs/posts/${id}`);
    const state = ok ? json?.state || json?.currentState : null;
    if (state === 'PUBLISHED') {
      live = true;
      break;
    }
    await sleep(pollMs);
  }
  if (!live) {
    throw new Error(`post ${id} did not reach PUBLISHED after scheduling (timeout).`);
  }

  // Restore the real publish date (preserves 2017–2026 order).
  if (originalPublishDate) {
    await hubOk(hubFn, acct, 'PATCH', `/cms/v3/blogs/posts/${id}`, {
      publishDate: normalizeDate(originalPublishDate),
    });
  }
  // scheduledMs is the epoch-ms of the future publish so the caller can WAIT past
  // the LATEST schedule before its final date-restore pass (codex #7 race fix).
  return {
    id: String(id),
    publishDate: originalPublishDate ? normalizeDate(originalPublishDate) : future,
    scheduledMs,
  };
}

/**
 * restoreCanonicalDate(acct, id, originalPublishDate, { hubFn, sleep, tries, settleMs })
 *   -> boolean
 *
 * FINAL-pass date restore (codex #7). PATCHes the canonical publishDate and VERIFIES
 * the live post reports it (day precision), retrying if a late scheduled publish has
 * clobbered it back to "now". Returns true once confirmed, false if it never sticks.
 * Run AFTER every post's schedule has fired so there is nothing left to clobber.
 */
export async function restoreCanonicalDate(
  acct,
  id,
  originalPublishDate,
  { hubFn = hub, sleep = defaultSleep, tries = 4, settleMs = 3000 } = {},
) {
  if (!originalPublishDate) return true;
  const want = normalizeDate(originalPublishDate);
  const wantDay = String(want).slice(0, 10);
  for (let i = 0; i < tries; i++) {
    await hubOk(hubFn, acct, 'PATCH', `/cms/v3/blogs/posts/${id}`, { publishDate: want });
    const { ok, json } = await hubFn(acct, 'GET', `/cms/v3/blogs/posts/${id}`);
    if (ok && String(json?.publishDate).slice(0, 10) === wantDay) return true;
    await sleep(settleMs);
  }
  return false;
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Extra settle margin (ms) added on top of the latest scheduled publish before the
// final date-restore pass runs, so the schedule has DEFINITELY fired (and can no
// longer clobber the restored date) — codex #7.
const SCHEDULE_SETTLE_MS = 10_000;

/**
 * waitUntil(targetMs, { now, sleep }) — block (via injectable sleep) until the
 * clock (injectable now) is at/after targetMs. Used to hold the final date-restore
 * pass back until every scheduled publish has fired. Returns immediately when the
 * target is already in the past (e.g. nothing was scheduled). Bounded-step sleeps
 * so a test's mock `now` that jumps forward terminates promptly.
 */
export async function waitUntil(targetMs, { now = () => Date.now(), sleep = defaultSleep } = {}) {
  let remaining = targetMs - now();
  while (remaining > 0) {
    // Cap each sleep so an advancing mock clock re-checks often; real sleep coalesces.
    await sleep(Math.min(remaining, 5000));
    remaining = targetMs - now();
  }
}

// Coerce epoch-ms / ISO variants to a single `.000Z` form.
function toIso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '.000Z');
}
function normalizeDate(d) {
  if (d == null) return d;
  const t = typeof d === 'number' ? d : Date.parse(d);
  if (Number.isNaN(t)) return d;
  return toIso(t);
}

// ── assets: re-host to the target File Manager, populate registry asset map ──────

function loadAssetManifest(dir) {
  // Assets now live in the unified content/assets/ tree (sibling of content/blog),
  // keyed by content-hash+slug. dir is content/blog, so ../assets.
  const f = join(dir, '..', 'assets', 'manifest.json');
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return {};
  }
}

// Upload one local file to the target File Manager; return its hosted URL.
// overwrite:true + EXACT_FOLDER converges (no -1 duplicates — codex #4).
async function uploadAsset(acct, path, fileName) {
  const buf = readFileSync(path);
  const form = new FormData();
  form.append('file', new Blob([buf]), fileName);
  form.append('fileName', fileName);
  form.append('folderPath', '/blog-migrated');
  form.append(
    'options',
    JSON.stringify({
      access: 'PUBLIC_INDEXABLE',
      overwrite: true,
      duplicateValidationStrategy: 'NONE',
      duplicateValidationScope: 'EXACT_FOLDER',
    }),
  );
  const res = await fetch(`${API}/files/v3/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${acct.key}` },
    body: form,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`upload ${fileName} -> ${res.status}: ${j.message || ''}`);
  return j.url || j.objects?.[0]?.url;
}

/**
 * rehostAssets(acct, dir, registry) — upload every manifest asset to THIS account's
 * File Manager and record the hosted URL under registry.assets[localFile]. The
 * gitignored .sync-state/<portalId>.rehosted.json cache is consulted/updated so a
 * re-push reuses prior uploads (no duplicates). After this runs, refs.resolve can
 * turn @asset:<localFile> into the target's hosted URL.
 */
async function rehostAssets(acct, dir, registry) {
  const manifest = loadAssetManifest(dir);
  const adir = join(dir, ASSETS_SUBDIR);
  const entries = Object.entries(manifest); // [originalUrl, localFile]
  if (entries.length === 0) return registry;

  // gitignored per-portal rehost cache (localFile -> hosted URL).
  const cachePath = stateRehostPath(acct.portalId);
  const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};

  for (const [, file] of entries) {
    if (!file) continue;
    if (registry.assets[file] && typeof registry.assets[file] === 'string') continue;
    if (cache[file]) {
      registry.assets[file] = cache[file];
      continue;
    }
    const localPath = join(adir, file);
    if (!existsSync(localPath)) continue; // dead/unrecovered asset — left for resolve() to flag
    const url = await uploadAsset(acct, localPath, file);
    cache[file] = url;
    registry.assets[file] = url;
  }
  delete registry.__rev_assets;
  try {
    mkdirSync(resolvePath('.sync-state'), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  } catch {
    /* non-fatal: the .sync-state rehost cache is only an upload optimization */
  }
  return registry;
}

// gitignored per-portal rehost cache lives at repo .sync-state/<portalId>.rehosted.json.
function stateRehostPath(portalId) {
  return join(resolvePath('.sync-state'), `${portalId}.rehosted.json`);
}

// ── authors / tags upsert (by slug, then display name) ──────────────────────────

// Build a {key -> id} index keyed by EACH of the given fields (slug preferred).
async function nameIndex(hubFn, acct, path, keys) {
  const items = await getAllVia(hubFn, acct, path);
  const idx = new Map();
  for (const it of items) {
    for (const k of keys) {
      const v = it[k];
      if (v != null && v !== '') idx.set(String(v).toLowerCase(), String(it.id));
    }
  }
  return idx;
}

// Resolve (or create) the HubSpot author for a post, then SYNC its canonical profile
// (bio + social + avatar) from authors.json so a bio edited in git reaches HubSpot.
// opts: { profiles, registry, dryRun, patched }. The profile PATCH runs at most once
// per author per push (patched set) and never during dryRun (no preflight writes).
async function ensureAuthor(acct, post, cache, hubFn, opts = {}) {
  const { profiles, registry, dryRun = false, patched } = opts;
  const slug = post.authorSlug;
  const display = post.authorName;
  if (!slug && !display) return null;

  const profile = profiles && (profiles.get(String(slug || '').toLowerCase())
    || profiles.get(String(display || '').toLowerCase()));

  let id = null;
  for (const k of [slug, display]) {
    if (k && cache.has(String(k).toLowerCase())) { id = cache.get(String(k).toLowerCase()); break; }
  }

  if (!id) {
    // CREATE with the full canonical profile (bio + social) so a new author lands
    // complete, not as a name-only stub.
    const j = await hubOk(hubFn, acct, 'POST', '/cms/v3/blogs/authors', {
      displayName: display || slug,
      fullName: (profile && profile.fullName) || display || slug,
      slug: slug || undefined,
      ...(profile ? authorPatchBody(profile, registry) : {}),
    });
    id = String(j.id);
    if (slug) cache.set(String(slug).toLowerCase(), id);
    if (display) cache.set(String(display).toLowerCase(), id);
    if (patched) patched.add(id);
    return id;
  }

  // EXISTING author: PATCH its editable profile to match the canonical authors.json
  // (this is what the old code skipped — bios never updated). Once per author, never
  // in dryRun.
  if (profile && !dryRun && !(patched && patched.has(id))) {
    const body = authorPatchBody(profile, registry);
    if (Object.keys(body).length) {
      await hubOk(hubFn, acct, 'PATCH', `/cms/v3/blogs/authors/${id}`, body);
    }
    if (patched) patched.add(id);
  }
  return id;
}

// Yield {slug, name} pairs for a post's tags, aligning tagSlugs with tagNames.
function postTagPairs(post) {
  const slugs = post.tagSlugs || [];
  const names = post.tagNames || [];
  // tagSlugs is sorted on pull; tagNames is source-order. Prefer slug, fall back
  // to name. We pair positionally only when lengths match; otherwise key by slug.
  if (slugs.length && slugs.length === names.length) {
    return slugs.map((slug, i) => ({ slug, name: names[i] }));
  }
  if (slugs.length) return slugs.map((slug) => ({ slug, name: slug }));
  return names.map((name) => ({ slug: slugifyName(name), name }));
}

async function ensureTag(acct, { slug, name }, cache, hubFn) {
  for (const k of [slug, name]) {
    if (k && cache.has(String(k).toLowerCase())) return cache.get(String(k).toLowerCase());
  }
  const j = await hubOk(hubFn, acct, 'POST', '/cms/v3/blogs/tags', {
    name: name || slug,
    slug: slug || undefined,
  });
  const id = String(j.id);
  if (slug) cache.set(String(slug).toLowerCase(), id);
  if (name) cache.set(String(name).toLowerCase(), id);
  return id;
}

// ── small helpers ──────────────────────────────────────────────────────────────

// hub() returns { ok, status, json }; throw on non-ok, else return json.
async function hubOk(hubFn, acct, method, path, body) {
  const { ok, status, json } = await hubFn(acct, method, path, body);
  if (!ok) {
    const msg = json?.message || json?.category || JSON.stringify(json).slice(0, 200);
    throw new Error(`${method} ${path} -> ${status}: ${msg}`);
  }
  return json;
}

// Paginate via the injected hubFn (so push is fully mockable; mirrors hub.getAll).
async function getAllVia(hubFn, acct, path) {
  const out = [];
  let after;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${path}${sep}limit=100${after ? `&after=${after}` : ''}`;
    const json = await hubOk(hubFn, acct, 'GET', url);
    out.push(...(json.results || []));
    after = json.paging?.next?.after;
  } while (after);
  return out;
}

// Resolve the FULL legacy blog object (id + item_template_path +
// listing_template_path + listing_page_id) so we can both target the container AND
// diff its template config. Matches by slug (matchBlogSlug semantics), never [0]
// — the stale "Old" blog cannot win (codex #6).
async function resolveBlogObjBySlugVia(hubFn, acct, slug) {
  const json = await hubOk(hubFn, acct, 'GET', '/content/api/v2/blogs?limit=100');
  const want = slug == null ? '' : String(slug);
  for (const b of json.objects || []) {
    if (String(b.slug ?? '') === want) return b;
  }
  return null;
}

/**
 * applyContainerConfig(hubFn, acct, dir, blogSlug, liveBlog) -> note|null
 *
 * BLOG THEME fix: PUT /content/api/v2/blogs/{id} so the container points at the
 * seventh-sense-theme blog templates from the committed container.json, and clears
 * the listing_page_id override (a non-zero one masks listing_template_path —
 * SYNC-NOTES §4; re-PUT also busts the edge cache).
 *
 * Idempotent: when the live blog already has item_template_path +
 * listing_template_path matching the canon AND listing_page_id === 0, we SKIP the
 * PUT entirely (no churn). Otherwise we PUT and return a note naming the change.
 */
async function applyContainerConfig(hubFn, acct, dir, blogSlug, liveBlog) {
  const cfg = loadContainerConfig(dir, blogSlug);
  if (!cfg) return null; // no committed container.json for this slug — nothing to enforce.
  const wantItem = cfg.itemTemplatePath || '';
  const wantListing = cfg.listingTemplatePath || '';
  // If the canon carries no template paths there is nothing to enforce.
  if (!wantItem && !wantListing) return null;

  const haveItem = liveBlog.item_template_path || '';
  const haveListing = liveBlog.listing_template_path || '';
  const haveListingPageId = Number(liveBlog.listing_page_id || 0);

  const inSync =
    haveItem === wantItem &&
    haveListing === wantListing &&
    haveListingPageId === 0;
  if (inSync) return null; // idempotent: re-PUT of identical values is a no-op → skip.

  await hubOk(hubFn, acct, 'PUT', `/content/api/v2/blogs/${liveBlog.id}`, {
    item_template_path: wantItem,
    listing_template_path: wantListing,
    // Clear the listing-page override so /blog renders listing_template_path.
    listing_page_id: 0,
  });
  return `blog theme: set container "${blogSlug}" templates → item=${wantItem} listing=${wantListing} (listing_page_id cleared)`;
}

// Load the committed container.json for a blog slug (camelCase canon fields), or
// null when absent. Mirrors containerFileFor()'s slug→filename mapping.
function loadContainerConfig(dir, blogSlug) {
  const f = join(dir, containerFileFor(blogSlug));
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

function slugifyName(name) {
  if (!name) return null;
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Post slug -> filename stem (mirror of canonical.slugToFile but local to blog so
// the adapter is self-contained: 'blog/x' -> 'blog__x').
export function postFileFor(slug) {
  return String(slug).replace(/\//g, '__');
}

// Container slug -> "container[.<slug>].json". The primary blog (slug "blog")
// uses container.json; any extra container is suffixed by slug.
export function containerFileFor(slug) {
  if (slug === 'blog' || !slug) return CONTAINER_FILE;
  return `container.${String(slug).replace(/\//g, '__')}.json`;
}

export default { name, dependsOn, pull, push, publishPost, restoreCanonicalDate, waitUntil, rawUrlToToken, canonicalizeField, localAssetName };
