// src/lib/content-view.mjs — NEUTRAL content projection.
//
// THE BOUNDARY. The on-disk canonical store is HubSpot's CMS WIRE FORMAT: pages
// carry `widgets.<name>.body.<field>` editor carriers (with load-bearing empty
// `css`/`child_css`/`label` objects that HubSpot's replace-not-merge PATCH
// requires — see lib/canonical.mjs), blog posts use HubSpot Blog API field names
// (`postBody`, `useFeaturedImage`, `blogSlug`, `state:"PUBLISHED"`), and module
// `fields.json` files carry server-assigned GUIDs and `content_types` enums.
//
// None of that belongs in a GENERIC publishing toolkit. This module projects the
// wire format into a small, target-agnostic VIEW that the renderer and any future
// non-HubSpot target consume. The renderer NEVER reaches into `.widgets.x.body`,
// reads a field GUID, or knows the string "PUBLISHED" — it sees only this view.
//
// Identity portability (@asset:/@portal/@form: refs) was already solved by
// lib/refs.mjs. This is the same idea extended to SCHEMA portability: the HubSpot
// blob is one target's codec output, not the canonical truth. Today the view is
// derived from the blob on read; later the view's shape could become the on-disk
// format and a HubSpot codec could reconstruct the blob — the seam is the same.
//
// PURE except for the explicit fs reads in load*(). The project*() transforms are
// pure functions over parsed JSON so they unit-test without a fixture tree.

import { readFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';

// ---------------------------------------------------------------------------
// Status vocabulary. HubSpot speaks `desiredState` (page) and `state` (post):
// publish|draft|archive|ignore / PUBLISHED|DRAFT. The view speaks one neutral
// enum so a target never branches on a HubSpot string.
// ---------------------------------------------------------------------------
const STATUS = { published: 'published', draft: 'draft', archived: 'archived' };

function neutralStatus(raw) {
  if (!raw) return STATUS.draft;
  const s = String(raw).toLowerCase();
  if (s === 'publish' || s === 'published') return STATUS.published;
  if (s === 'archive' || s === 'archived' || s === 'ignore') return STATUS.archived;
  return STATUS.draft;
}

// ---------------------------------------------------------------------------
// projectPost(raw, authorsByName) -> neutral post view
//
// Maps HubSpot Blog API field names onto neutral names and JOINS the author
// record by name. `body`/`summary` stay as raw HTML strings (still carrying
// @asset: refs for the target to resolve). `featuredImage` is left as its
// logical ref — ref resolution is the TARGET's job, not the view's.
// ---------------------------------------------------------------------------
export function projectPost(raw, authorsByName = {}) {
  const author = authorsByName[raw.authorName] || (raw.authorName ? { name: raw.authorName } : null);
  return {
    kind: 'post',
    // Routing: HubSpot stores `slug` as "blog/<slug>"; the route is absolute.
    slug: raw.slug,
    route: '/' + String(raw.slug || '').replace(/^\/+/, ''),
    status: neutralStatus(raw.state),
    title: raw.name,
    htmlTitle: raw.htmlTitle || raw.name,
    metaDescription: raw.metaDescription || '',
    body: raw.postBody || '',
    summary: raw.postSummary || '',
    publishDate: raw.publishDate || null,
    tags: Array.isArray(raw.tagNames) ? raw.tagNames.slice() : [],
    author,
    featuredImage: raw.useFeaturedImage ? raw.featuredImage || null : null,
    featuredImageAlt: raw.featuredImageAltText || '',
    blogSlug: raw.blogSlug || 'blog',
  };
}

// ---------------------------------------------------------------------------
// projectPage(raw) -> neutral page view
//
// The crux of the schema-portability argument. HubSpot nests per-module field
// values under `widgets.<instanceName>.body.<field>`, wrapped in editor cruft
// (`css`, `child_css`, `label`, `type:"module"`) that is inert at render time.
// The view flattens each carrier to `modules[instanceName] = {<field>: value}`
// and drops the cruft. The renderer keys modules by instance name; it never sees
// `body` or the empty style objects the HubSpot target round-trips.
// ---------------------------------------------------------------------------
export function projectPage(raw) {
  const modules = {};
  const widgets = raw.widgets || {};
  for (const [name, carrier] of Object.entries(widgets)) {
    if (!carrier || carrier.type !== 'module') continue;
    modules[name] = { ...(carrier.body || {}) };
  }
  // `templatePath` is "<theme>/templates/<file>.html"; the view keeps the file
  // path relative to the theme so the renderer's loader resolves it.
  const tpl = String(raw.templatePath || '');
  const templateRel = tpl.replace(/^[^/]+\//, ''); // drop leading "<theme>/"
  return {
    kind: 'page',
    slug: raw.slug ?? '',
    route: '/' + String(raw.slug ?? '').replace(/^\/+/, ''),
    status: neutralStatus(raw.desiredState),
    title: raw.name,
    htmlTitle: raw.htmlTitle || raw.name,
    metaDescription: raw.metaDescription || '',
    language: raw.language || 'en',
    template: templateRel,
    modules,
  };
}

// ---------------------------------------------------------------------------
// Loaders. The only I/O in this module.
// ---------------------------------------------------------------------------
async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

/** loadAuthors(blogDir) -> { [displayName|name]: neutralAuthor } */
export async function loadAuthors(blogDir) {
  const byName = {};
  try {
    const authors = await readJson(join(blogDir, 'authors.json'));
    for (const a of authors) {
      const neutral = {
        name: a.displayName || a.fullName || a.name,
        bio: a.bio || '',
        avatar: a.avatar || null,
        slug: a.slug || null,
      };
      for (const key of [a.displayName, a.fullName, a.name]) {
        if (key) byName[key] = neutral;
      }
    }
  } catch {
    /* authors.json optional */
  }
  return byName;
}

/** loadPosts(contentDir) -> neutralPostView[] (newest first) */
export async function loadPosts(contentDir) {
  const blogDir = join(contentDir, 'blog');
  const postsDir = join(blogDir, 'posts');
  const authorsByName = await loadAuthors(blogDir);
  const files = (await readdir(postsDir)).filter((f) => f.endsWith('.json'));
  const posts = [];
  for (const f of files.sort()) {
    posts.push(projectPost(await readJson(join(postsDir, f)), authorsByName));
  }
  posts.sort((a, b) => String(b.publishDate || '').localeCompare(String(a.publishDate || '')));
  return posts;
}

/** loadPages(contentDir) -> neutralPageView[] */
export async function loadPages(contentDir) {
  const pagesDir = join(contentDir, 'pages');
  const files = (await readdir(pagesDir)).filter((f) => f.endsWith('.json'));
  const pages = [];
  for (const f of files.sort()) {
    pages.push(projectPage(await readJson(join(pagesDir, f))));
  }
  return pages;
}

/** loadSite(siteDir) -> { posts, pages } against a theme repo root. */
export async function loadSite(siteDir, { contentDir = 'content' } = {}) {
  const cdir = join(siteDir, contentDir);
  const [posts, pages] = await Promise.all([loadPosts(cdir), loadPages(cdir)]);
  return { posts, pages };
}

export { basename, STATUS };
