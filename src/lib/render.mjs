// src/lib/render.mjs — HubL -> HTML rendering for the STATIC target.
//
// This is the deliberately HubSpot-FLAVORED part of the toolkit. HubSpot renders
// HubL server-side; a static target (Cloudflare Pages, plain dir) has no server,
// so the toolkit must render the same templates itself at build time. The engine
// is Nunjucks (Jinja2-flavored, like HubL) plus a small, finite compatibility
// layer for the handful of constructs HubL has that Nunjucks does not.
//
// Inputs are NEUTRAL views from lib/content-view.mjs — the renderer never reads a
// `widgets.x.body` carrier, a field GUID, or the string "PUBLISHED". It maps the
// neutral view onto the snake_case `content.*` variable contract the HubL
// templates reference (HubSpot exposes its model to HubL in snake_case), and
// shims the HubL-only globals/filters/tags.
//
// HubL constructs handled:
//   - {{ get_asset_url('../css/main.css') }}  -> root-relative "/css/main.css"
//   - {% include "../templates/shared-nav.html" %}  (path normalized in loader)
//   - blog_recent_posts(group, n)  -> recent neutral posts as content shims
//   - standard_header_includes / standard_footer_includes  -> injected strings
//   - x[:2] / x[1:] / x[1:3] Python-style slices  -> |hubslice() (preprocess)
//   - {% module %}  -> see module-tag extension (added for page rendering)
//
// Pure except for the loader's synchronous template file reads.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import nunjucks from 'nunjucks';

// ---------------------------------------------------------------------------
// HubL -> Nunjucks source preprocessing. Applied to every template the loader
// serves. Currently: Python/Jinja slice subscripts, which HubL supports and
// Nunjucks does not. `name[:2]` -> `name|hubslice(0,null)`-style rewrite. Only
// dotted identifier targets are matched (covers the corpus: author name initials).
// ---------------------------------------------------------------------------
const SLICE_RE = /([A-Za-z_][\w.]*)\[(\d*):(\d*)\]/g;

export function preprocessHubl(src) {
  return src.replace(SLICE_RE, (_m, expr, a, b) => {
    const start = a === '' ? '0' : a;
    const end = b === '' ? 'null' : b;
    return `${expr}|hubslice(${start},${end})`;
  });
}

// ---------------------------------------------------------------------------
// Loader: resolves HubSpot-style template-relative include paths against the
// theme root and preprocesses HubL source on the way out. "../templates/x.html"
// and "templates/x.html" both resolve to <siteDir>/templates/x.html — every
// include in the corpus is template-relative ("../templates/..."), so stripping
// leading ./ .. segments yields the theme-root-relative path.
// ---------------------------------------------------------------------------
function makeLoader(siteDir) {
  return {
    async: false,
    getSource(name) {
      const rel = name.split('/').filter((p) => p && p !== '.' && p !== '..').join('/');
      const full = join(siteDir, rel);
      const raw = readFileSync(full, 'utf8');
      return { src: preprocessHubl(raw), path: full, noCache: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Static ref resolution. The HubSpot target resolves @asset:/@portal to portal
// GUIDs + hosted hubfs URLs (lib/refs.mjs); the static target resolves them to
// local paths under the deployed site. Minimal for the spike: @asset:NAME ->
// /assets/NAME, applied to attribute values and rich-text bodies alike.
// ---------------------------------------------------------------------------
export function resolveStaticRefs(value, { assetBase = '/assets' } = {}) {
  if (value == null) return value;
  return String(value).replace(/@asset:([^\s"'<>)]+)/g, (_m, nameRef) => `${assetBase}/${nameRef}`);
}

// get_asset_url('../css/main.css') -> "/css/main.css". Theme assets live at the
// repo root (css/ js/ images/); HubL refs them template-relative with leading ../.
function assetUrl(path) {
  return '/' + String(path).replace(/^(\.\.\/)+/, '').replace(/^\/+/, '');
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function localizeDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// ---------------------------------------------------------------------------
// Neutral post view -> HubL `content` shim (snake_case, refs resolved for the
// static target). Reused for the page being rendered AND for related-post cards
// returned by blog_recent_posts().
// ---------------------------------------------------------------------------
function postContent(post, { baseUrl = '', assetBase = '/assets' } = {}) {
  const author = post.author || null;
  return {
    name: post.title,
    html_title: post.htmlTitle,
    meta_description: post.metaDescription,
    post_body: resolveStaticRefs(post.body, { assetBase }),
    post_summary: resolveStaticRefs(post.summary, { assetBase }),
    publish_date_localized: localizeDate(post.publishDate),
    featured_image: post.featuredImage ? resolveStaticRefs(post.featuredImage, { assetBase }) : '',
    featured_image_alt_text: post.featuredImageAlt,
    tag_list: post.tags.map((t) => ({ name: t })),
    blog_post_author: author ? { display_name: author.name, bio: resolveStaticRefs(author.bio, { assetBase }) } : null,
    absolute_url: baseUrl + post.route,
    canonical_url: baseUrl + post.route,
  };
}

// ---------------------------------------------------------------------------
// Environment factory. One env per render call keeps globals (blog_recent_posts
// closure, header/footer includes) bound to the current site + options.
// ---------------------------------------------------------------------------
function makeEnv(siteDir, { site, opts }) {
  const env = new nunjucks.Environment(makeLoader(siteDir), { autoescape: false, throwOnUndefined: false });

  env.addFilter('hubslice', (str, start, end) =>
    end === null || end === undefined ? String(str ?? '').slice(start) : String(str ?? '').slice(start, end));

  env.addGlobal('get_asset_url', assetUrl);
  env.addGlobal('html_lang', opts.lang || 'en');
  env.addGlobal('html_lang_dir', '');
  env.addGlobal('standard_header_includes', opts.headerIncludes || '');
  env.addGlobal('standard_footer_includes', opts.footerIncludes || '');

  // blog_recent_posts('default', n) — HubL's recent-posts query. Backed by the
  // build-time neutral corpus, newest-first, projected to content shims.
  env.addGlobal('blog_recent_posts', (_group, count) =>
    (site?.posts || []).slice(0, count || 5).map((p) => postContent(p, opts)));

  return env;
}

// ---------------------------------------------------------------------------
// Public: render one neutral post view to an HTML string.
// ---------------------------------------------------------------------------
export function renderPost(post, { siteDir, site, baseUrl = '', assetBase = '/assets', lang = 'en',
  headerIncludes = '', footerIncludes = '', template = 'templates/blog-post.html' } = {}) {
  const opts = { baseUrl, assetBase, lang, headerIncludes, footerIncludes };
  const env = makeEnv(siteDir, { site, opts });
  const context = {
    content: postContent(post, opts),
    nav_active: null,
    nav_hide_cta: false,
  };
  return env.render(template, context);
}

export { postContent, assetUrl, localizeDate, makeEnv };
