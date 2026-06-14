// src/build-static.mjs — STATIC TARGET build: render the whole canonical site to a
// directory of plain HTML + assets, deployable to any static host (Cloudflare Pages,
// etc.). The mirror of push.mjs (the HubSpot target): same canonical content, a
// different materialization. Output is build artifact — never committed; CI builds
// it fresh and deploys.
//
// Emits, under outDir:
//   <route>/index.html        for every published page (home slug "" -> index.html)
//   blog/<slug>/index.html     for every published post
//   blog/index.html            the blog listing (all posts)
//   blog/tag/<slug>/index.html  one listing per tag
//   css/ js/ images/ assets/   copied theme + @asset bytes (assets/ <- content/assets)
//   _redirects                 Cloudflare redirects from sync/redirects.csv
//   _headers                   cache + basic security headers

import { mkdir, writeFile, cp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { loadSite } from './lib/content-view.mjs';
import { renderPage, renderPost, renderBlogListing, slugify } from './lib/render.mjs';
import { readRedirectSpecs } from './redirects.mjs';

async function loadTagSlugs(siteDir) {
  const map = {};
  try {
    const raw = JSON.parse(await readFile(join(siteDir, 'content/blog/tags.json'), 'utf8'));
    for (const t of Array.isArray(raw) ? raw : raw.tags || []) {
      if (t?.name && t?.slug) map[t.name] = t.slug;
    }
  } catch {
    /* tags.json optional — fall back to slugify */
  }
  return map;
}

/**
 * buildStatic({ siteDir, outDir, baseUrl, assetBase, trackingPortalId }) -> summary
 *
 * baseUrl is used for canonical/og absolute URLs (e.g. https://www2.7thsense.io).
 * trackingPortalId, if set, injects the HubSpot tracking script into the footer so
 * forms keep de-anonymizing (`standard_footer_includes`). Returns counts.
 */
export async function buildStatic({ siteDir, outDir, baseUrl = '', assetBase = '/assets', trackingPortalId, blogPageSize = 10 } = {}) {
  const tagMap = await loadTagSlugs(siteDir);
  const tagSlugFor = (name) => tagMap[name] || slugify(name);
  const footerIncludes = trackingPortalId
    ? `<script type="text/javascript" id="hs-script-loader" async defer src="//js.hs-scripts.com/${trackingPortalId}.js"></script>`
    : '';

  const site = await loadSite(siteDir);
  const pages = site.pages.filter((p) => p.status === 'published');
  const posts = site.posts.filter((p) => p.status === 'published'); // already newest-first
  const opts = { siteDir, site, baseUrl, assetBase, footerIncludes, tagSlugFor };

  let fileCount = 0;
  async function emit(route, html) {
    const rel = route === '/' || route === '' ? 'index.html' : join(route.replace(/^\//, ''), 'index.html');
    const file = join(outDir, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, html, 'utf8');
    fileCount++;
  }

  for (const page of pages) await emit(page.route, renderPage(page, opts));
  for (const post of posts) await emit(post.route, renderPost(post, opts));

  // Cloudflare Pages serves /404.html for any unmatched route; without it, an unknown
  // path falls back to index.html. Render it flat at the output root.
  if (existsSync(join(siteDir, 'templates/404.html'))) {
    const html = renderPage(
      { template: 'templates/404.html', route: '/404', title: 'Page not found', htmlTitle: 'Page not found', metaDescription: '', modules: {} },
      opts,
    );
    await writeFile(join(outDir, '404.html'), html, 'utf8');
    fileCount++;
  }

  // Paginate listings to match HubSpot (20 posts/page; page 1 = base, page N = base/page/N).
  // Without this the static listing renders every post on one page.
  async function emitListing(basePath, items) {
    const totalPages = Math.max(1, Math.ceil(items.length / blogPageSize));
    for (let pageNum = 1; pageNum <= totalPages; pageNum += 1) {
      const route = pageNum === 1 ? basePath : `${basePath}/page/${pageNum}`;
      await emit(route, renderBlogListing(items, { ...opts, route, basePath, pageNum, pageSize: blogPageSize }));
    }
  }

  await emitListing('/blog', posts);

  // One listing per tag, posts grouped by tag slug (preserves newest-first order).
  const byTag = new Map();
  for (const post of posts) {
    for (const t of post.tags) {
      const slug = tagSlugFor(t);
      if (!byTag.has(slug)) byTag.set(slug, []);
      byTag.get(slug).push(post);
    }
  }
  for (const [slug, tagPosts] of byTag) {
    await emitListing(`/blog/tag/${slug}`, tagPosts);
  }

  // Assets. get_asset_url maps ../css|js|images -> /css|js|images; @asset:<p> -> /assets/<p>.
  for (const [src, dest] of [['css', 'css'], ['js', 'js'], ['images', 'images'],
    ['content/assets', 'assets'], ['content/blog/assets', 'assets']]) {
    const from = join(siteDir, src);
    if (existsSync(from)) await cp(from, join(outDir, dest), { recursive: true });
  }

  // _redirects (Cloudflare format: "<from> <to> <code>").
  let redirectCount = 0;
  const redirCsv = join(siteDir, 'sync/redirects.csv');
  if (existsSync(redirCsv)) {
    const specs = readRedirectSpecs(redirCsv);
    const lines = specs.map((s) => `${s.routePrefix} ${s.destination} ${s.redirectStyle || 301}`);
    await writeFile(join(outDir, '_redirects'), `${lines.join('\n')}\n`, 'utf8');
    redirectCount = lines.length;
  }

  await writeFile(join(outDir, '_headers'),
    '/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n'
    + '/css/*\n  Cache-Control: public, max-age=31536000, immutable\n'
    + '/js/*\n  Cache-Control: public, max-age=31536000, immutable\n'
    + '/*\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: SAMEORIGIN\n  Referrer-Policy: strict-origin-when-cross-origin\n',
    'utf8');

  return { pages: pages.length, posts: posts.length, tags: byTag.size, files: fileCount, redirects: redirectCount };
}
