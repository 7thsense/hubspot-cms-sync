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
//   blog/topic/<slug>/index.html  one listing per tag
//   css/ js/ images/ assets/   copied theme + @asset bytes (assets/ <- content/assets)
//   _redirects                 Cloudflare redirects from sync/redirects.csv
//   _headers                   cache + basic security headers

import { mkdir, writeFile, cp, readFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, basename, extname, relative } from 'node:path';

import { loadSite } from './lib/content-view.mjs';
import { renderPage, renderPost, renderBlogListing, slugify, resolveStaticRefs, makeEnv, preprocessHubl } from './lib/render.mjs';
import { checkHublParity, formatParityError, collectTemplateSources } from './lib/hubl-parity.mjs';
import { readRedirectSpecs } from './redirects.mjs';

// HubL-parity GUARD. Before rendering a single page, scan every template/module source
// for a filter or global the static render env (render.mjs::makeEnv) does NOT implement,
// and THROW an actionable error if any are missing — instead of the cryptic mid-render
// Nunjucks crash a missing construct otherwise causes (the failure mode that broke the
// build for datetimeformat/escapejson/striptags and the `request` global). The available
// filter/global names are reflected off a REAL env so they never drift from makeEnv.
export function assertHublParity(siteDir, site) {
  const env = makeEnv(siteDir, { site, opts: {} });
  const sources = collectTemplateSources(
    [join(siteDir, 'templates'), join(siteDir, 'modules')],
    { readFileSync, readdirSync, statSync: null, join, relativeTo: (f) => relative(siteDir, f) },
  ).map(({ file, src }) => ({ file, src: preprocessHubl(src) })); // scan the bytes Nunjucks compiles
  const result = checkHublParity({
    registeredFilters: Object.keys(env.filters),
    registeredGlobals: Object.keys(env.globals),
    sources,
  });
  if (result.missingFilters.length || result.missingGlobals.length) {
    throw new Error(formatParityError(result));
  }
}

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

// Build a `theme` context from the theme fields (fields.json) so HubL `{{ theme.* }}`
// expressions in CSS resolve to the field defaults. HubSpot resolves these server-side;
// the static target must do it at build time or brand colors — var(--brand) etc. — break
// (an invalid custom property silently drops the whole declaration that references it).
export function themeFromFields(fields) {
  const obj = {};
  for (const f of Array.isArray(fields) ? fields : []) {
    if (!f?.name) continue;
    obj[f.name] = f.type === 'group' ? themeFromFields(f.children) : f.default;
  }
  return obj;
}

async function loadThemeContext(siteDir) {
  try {
    return themeFromFields(JSON.parse(await readFile(join(siteDir, 'fields.json'), 'utf8')));
  } catch {
    return {};
  }
}

// Resolve `{{ theme.a.b.c }}` tokens against the theme context. Targeted to theme.* only,
// so it can't disturb CSS syntax; unknown paths are left untouched.
export function resolveThemeTokens(text, theme) {
  return String(text).replace(/\{\{\s*theme\.([\w.]+)\s*\}\}/g, (m, path) => {
    let v = theme;
    for (const k of path.split('.')) v = v == null ? v : v[k];
    return v == null ? m : String(v);
  });
}

// Emit css/js with CONTENT-HASHED filenames (e.g. main.<hash>.css) so they can be cached
// immutably AND every change gets a fresh URL — no stale edge cache, no manual purge. CSS
// theme tokens are resolved first (HubSpot does that server-side). Returns a manifest mapping
// the source-relative path (as get_asset_url requests it) to the hashed URL:
//   { 'css/main.css': '/css/main.<hash>.css', 'js/app.js': '/js/app.<hash>.js' }
// Non-hashable sibling files (e.g. a .map) are copied through unchanged.
const HASHABLE = new Set(['.css', '.js', '.mjs']);
async function emitHashedAssets(siteDir, outDir, theme, registry = null, assetBase = '/assets') {
  const manifest = {};
  async function walk(relDir) {
    const fromDir = join(siteDir, relDir);
    if (!existsSync(fromDir)) return;
    await mkdir(join(outDir, relDir), { recursive: true });
    for (const ent of await readdir(fromDir, { withFileTypes: true })) {
      const rel = `${relDir}/${ent.name}`;
      if (ent.isDirectory()) { await walk(rel); continue; }
      const ext = extname(ent.name);
      let bytes = await readFile(join(fromDir, ent.name));
      if (ext === '.css') bytes = Buffer.from(resolveThemeTokens(bytes.toString('utf8'), theme), 'utf8');
      // Theme JS (e.g. hs-forms.js) carries @portal/@form/@cta — the HubSpot forms script
      // builds its submit URL from them. Resolve to the chosen account's ids via registry.
      if ((ext === '.js' || ext === '.css') && registry) {
        bytes = Buffer.from(resolveStaticRefs(bytes.toString('utf8'), { assetBase, registry }), 'utf8');
      }
      if (!HASHABLE.has(ext)) { await writeFile(join(outDir, rel), bytes); continue; }
      const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 10);
      const hashedRel = `${relDir}/${basename(ent.name, ext)}.${hash}${ext}`;
      await writeFile(join(outDir, hashedRel), bytes);
      manifest[rel] = `/${hashedRel}`;
    }
  }
  await walk('css');
  await walk('js');
  return manifest;
}

// Load the ref registry for the account the static site's forms/CTAs point at, so the
// build can resolve @form/@portal/@cta to real HubSpot ids (embedded forms POST to the
// HubSpot Forms API; CTAs link to HubSpot). It is the same .sync-state/<portal>.registry
// the push uses. null when no formsPortal is given (refs are then left as-is).
async function loadFormsRegistry(siteDir, formsPortal) {
  if (!formsPortal) return null;
  try {
    return JSON.parse(await readFile(join(siteDir, '.sync-state', `${formsPortal}.registry.json`), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * buildStatic({ siteDir, outDir, baseUrl, assetBase, trackingPortalId, formsPortal }) -> summary
 *
 * baseUrl is used for canonical/og absolute URLs (e.g. https://www2.7thsense.io).
 * trackingPortalId, if set, injects the HubSpot tracking script into the footer.
 * formsPortal, if set, is the HubSpot portal id whose ref registry resolves embedded
 * @form/@portal/@cta tokens — i.e. which account the static site's forms POST to. Returns counts.
 */
export async function buildStatic({ siteDir, outDir, baseUrl = '', assetBase = '/assets', trackingPortalId, formsPortal, blogPageSize = 10 } = {}) {
  const tagMap = await loadTagSlugs(siteDir);
  const tagSlugFor = (name) => tagMap[name] || slugify(name);
  const footerIncludes = trackingPortalId
    ? `<script type="text/javascript" id="hs-script-loader" async defer src="//js.hs-scripts.com/${trackingPortalId}.js"></script>`
    : '';

  const site = await loadSite(siteDir);
  // Fail fast on any template construct the static render env doesn't implement, BEFORE
  // rendering — turns a cryptic mid-render Nunjucks crash into a named, actionable error.
  assertHublParity(siteDir, site);
  const pages = site.pages.filter((p) => p.status === 'published');
  const posts = site.posts.filter((p) => p.status === 'published'); // already newest-first
  // Emit content-hashed css/js up front so get_asset_url() can rewrite references to the
  // hashed URLs as pages render. The registry resolves @form/@portal/@cta in both the
  // theme JS and the rendered pages.
  const theme = await loadThemeContext(siteDir);
  const registry = await loadFormsRegistry(siteDir, formsPortal);
  const assetManifest = await emitHashedAssets(siteDir, outDir, theme, registry, assetBase);
  const opts = { siteDir, site, baseUrl, assetBase, footerIncludes, tagSlugFor, assetManifest, registry };

  let fileCount = 0;
  const sitemapRoutes = []; // every canonical route emitted, for sitemap.xml
  async function emit(route, html) {
    const rel = route === '/' || route === '' ? 'index.html' : join(route.replace(/^\//, ''), 'index.html');
    const file = join(outDir, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, html, 'utf8');
    sitemapRoutes.push(route === '' ? '/' : route);
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
    // HubSpot serves blog tag listings at /blog/topic/<slug> (the blog's configured tag
    // base path); the static target must mirror that URL so links resolve on both.
    await emitListing(`/blog/topic/${slug}`, tagPosts);
  }

  // Assets. css/js were already emitted (content-hashed) above; copy the rest as bytes.
  // get_asset_url maps ../images -> /images; @asset:<p> -> /assets/<p>.
  for (const [src, dest] of [['images', 'images'],
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

  // sitemap.xml — HubSpot auto-generates one; the static target must too (SEO parity).
  // Absolute <loc> from baseUrl (the seo gate parses new URL(loc).pathname). Dedup +
  // sort; drop paginated /page/N listings (canonical listing is the base path).
  const seen = new Set();
  const sitemapLocs = sitemapRoutes
    .filter((r) => !/\/page\/\d+$/.test(r))
    .map((r) => `${baseUrl}${r}`)
    .filter((loc) => (seen.has(loc) ? false : seen.add(loc)))
    .sort();
  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + sitemapLocs.map((loc) => `  <url><loc>${loc}</loc></url>`).join('\n')
    + `\n</urlset>\n`;
  await writeFile(join(outDir, 'sitemap.xml'), sitemapXml, 'utf8');
  fileCount++;

  // robots.txt pointing at the sitemap (HubSpot serves one; parity + SEO).
  await writeFile(join(outDir, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${baseUrl}/sitemap.xml\n`, 'utf8');
  fileCount++;

  // assets, css, and js are all content-hashed now, so immutable caching is safe AND every
  // change ships a fresh URL (no stale edge cache, no manual purge). sitemap.xml gets an
  // explicit xml content-type (the seo gate asserts it).
  await writeFile(join(outDir, '_headers'),
    '/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n'
    + '/css/*\n  Cache-Control: public, max-age=31536000, immutable\n'
    + '/js/*\n  Cache-Control: public, max-age=31536000, immutable\n'
    + '/sitemap.xml\n  Content-Type: application/xml; charset=utf-8\n'
    + '/*\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: SAMEORIGIN\n  Referrer-Policy: strict-origin-when-cross-origin\n',
    'utf8');

  return { pages: pages.length, posts: posts.length, tags: byTag.size, files: fileCount, redirects: redirectCount, sitemap: sitemapLocs.length };
}
