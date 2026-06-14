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
  return src
    // HubL's `{% module "name" path=... label=... %}` space-separates the name from
    // its kwargs; Nunjucks' parseSignature wants a comma there. Insert one after the
    // name literal so the remaining `key=value, ...` parses as keyword args.
    .replace(/(\{%-?\s*module\s+(?:"[^"]*"|'[^']*'))\s+(?=[A-Za-z_])/g, '$1, ')
    .replace(SLICE_RE, (_m, expr, a, b) => {
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

// HubSpot evaluates HubL functions embedded in rich-text bodies at render time; the
// static target passes bodies through as data, so any such macro must be resolved
// here. Currently the only one in the corpus is a Wistia video embed,
// `{{ script_embed('wistia', '<id>', ...) }}` -> Wistia's responsive inline embed.
const WISTIA_EMBED_RE = /\{\{\s*script_embed\(\s*['"]wistia['"]\s*,\s*['"]([A-Za-z0-9]+)['"][^}]*\)\s*\}\}/gi;
export function resolveHublEmbeds(value) {
  if (value == null) return value;
  return String(value).replace(WISTIA_EMBED_RE, (_m, id) =>
    `<script src="https://fast.wistia.com/embed/medias/${id}.jsonp" async></script>`
    + '<script src="https://fast.wistia.com/assets/external/E-v1.js" async></script>'
    + '<div class="wistia_responsive_padding" style="padding:56.25% 0 0 0;position:relative;">'
    + '<div class="wistia_responsive_wrapper" style="height:100%;left:0;position:absolute;top:0;width:100%;">'
    + `<div class="wistia_embed wistia_async_${id} videoFoam=true" style="height:100%;position:relative;width:100%;">&nbsp;</div>`
    + '</div></div>');
}

// get_asset_url('../css/main.css') -> "/css/main.css". Theme assets live at the
// repo root (css/ js/ images/); HubL refs them template-relative with leading ../.
function assetUrl(path) {
  return '/' + String(path).replace(/^(\.\.\/)+/, '').replace(/^\/+/, '');
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function localizeDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// Fallback tag slug when no authoritative tags.json mapping is supplied.
export function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// HubL's format_date(value, style). Mirrors HubSpot's en-US styles: medium uses an
// abbreviated month ("Jun 6, 2026"), long/full the full month, short is numeric.
// UTC so the build is deterministic regardless of the runner's timezone.
function formatDate(value, style = 'medium') {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const y = d.getUTCFullYear();
  if (style === 'short') return `${m + 1}/${day}/${String(y).slice(2)}`;
  if (style === 'long' || style === 'full') return `${MONTHS[m]} ${day}, ${y}`;
  return `${MONTHS_ABBR[m]} ${day}, ${y}`;
}

// ---------------------------------------------------------------------------
// Neutral post view -> HubL `content` shim (snake_case, refs resolved for the
// static target). Reused for the page being rendered AND for related-post cards
// returned by blog_recent_posts().
// ---------------------------------------------------------------------------
function postContent(post, { baseUrl = '', assetBase = '/assets', tagSlugFor } = {}) {
  const author = post.author || null;
  const tagSlug = tagSlugFor || slugify;
  return {
    name: post.title,
    html_title: post.htmlTitle,
    meta_description: post.metaDescription,
    post_body: resolveHublEmbeds(resolveStaticRefs(post.body, { assetBase })),
    post_summary: resolveHublEmbeds(resolveStaticRefs(post.summary, { assetBase })),
    publish_date: post.publishDate,
    publish_date_localized: localizeDate(post.publishDate),
    featured_image: post.featuredImage ? resolveStaticRefs(post.featuredImage, { assetBase }) : '',
    featured_image_alt_text: post.featuredImageAlt,
    tag_list: post.tags.map((t) => ({ name: t, slug: tagSlug(t) })),
    blog_post_author: author ? { display_name: author.name, bio: resolveStaticRefs(author.bio, { assetBase }) } : null,
    absolute_url: baseUrl + post.route,
    canonical_url: baseUrl + post.route,
  };
}

// Recursively resolve @asset refs inside any string value of a field tree.
function resolveDeep(val, opts) {
  if (typeof val === 'string') return resolveStaticRefs(val, opts);
  if (Array.isArray(val)) return val.map((v) => resolveDeep(v, opts));
  if (val && typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) out[k] = resolveDeep(v, opts);
    return out;
  }
  return val;
}

// fields.json -> { fieldName: default }. A group field (with `children`) yields a
// nested object of its children's defaults; leaf fields yield their `default`.
function moduleFieldDefaults(fields) {
  const out = {};
  if (!Array.isArray(fields)) return out;
  for (const f of fields) {
    if (!f || !f.name) continue;
    if (Array.isArray(f.children) && f.children.length) out[f.name] = moduleFieldDefaults(f.children);
    else if ('default' in f) out[f.name] = f.default;
  }
  return out;
}

// ---------------------------------------------------------------------------
// {% module "name" path="../modules/x.module" label="..." field=val %} — HubL's
// module instantiation tag. HubSpot renders the module's module.html with a
// `module` variable whose fields resolve by precedence: fields.json defaults <
// inline template args < the page's stored widget body (content-view's modules map,
// passed in context as __page_modules). The module bytes are read relative to the
// theme root (path's leading ../ stripped). Returns SafeString (no double-escape).
// ---------------------------------------------------------------------------
function ModuleExtension(env, siteDir, opts) {
  this.tags = ['module'];
  this.parse = function parse(parser, nodes) {
    const tok = parser.nextToken();
    const args = parser.parseSignature(null, true);
    parser.advanceAfterBlockEnd(tok.value);
    return new nodes.CallExtension(this, 'run', args);
  };
  this.run = function run(context, name, kwargs) {
    kwargs = kwargs && kwargs.__keywords ? kwargs : {};
    const { path = '', label: _label, ...inlineFields } = kwargs;
    const modDir = join(siteDir, String(path).replace(/^(\.\.\/)+/, ''));
    let defaults = {};
    try {
      defaults = moduleFieldDefaults(JSON.parse(readFileSync(join(modDir, 'fields.json'), 'utf8')));
    } catch {
      /* a module may ship no fields.json */
    }
    const pageVals = (context.lookup('__page_modules') || {})[name] || {};
    const merged = { ...defaults, ...inlineFields, ...pageVals };
    const html = env.renderString(preprocessHubl(readFileSync(join(modDir, 'module.html'), 'utf8')), {
      module: resolveDeep(merged, opts),
    });
    return new nunjucks.runtime.SafeString(html);
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
  env.addFilter('format_date', formatDate);

  env.addGlobal('get_asset_url', assetUrl);
  env.addGlobal('html_lang', opts.lang || 'en');
  env.addGlobal('html_lang_dir', '');
  env.addGlobal('standard_header_includes', opts.headerIncludes || '');
  env.addGlobal('standard_footer_includes', opts.footerIncludes || '');

  // blog_recent_posts('default', n) — HubL's recent-posts query. Backed by the
  // build-time neutral corpus, newest-first, projected to content shims.
  env.addGlobal('blog_recent_posts', (_group, count) =>
    (site?.posts || []).slice(0, count || 5).map((p) => postContent(p, opts)));

  env.addExtension('ModuleExtension', new ModuleExtension(env, siteDir, opts));

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

// ---------------------------------------------------------------------------
// Neutral page view -> HubL `content` shim. Pages reference content.* far less
// than posts (most copy lives in modules), but templates use name/title/meta and
// the canonical/absolute URL for SEO + social tags.
// ---------------------------------------------------------------------------
function pageContent(page, { baseUrl = '' } = {}) {
  return {
    name: page.title,
    html_title: page.htmlTitle,
    meta_description: page.metaDescription,
    absolute_url: baseUrl + page.route,
    canonical_url: baseUrl + page.route,
  };
}

// ---------------------------------------------------------------------------
// Public: render one neutral page view (with its module map) to an HTML string.
// ---------------------------------------------------------------------------
export function renderPage(page, { siteDir, site, baseUrl = '', assetBase = '/assets', lang = 'en',
  headerIncludes = '', footerIncludes = '' } = {}) {
  const opts = { baseUrl, assetBase, lang, headerIncludes, footerIncludes };
  const env = makeEnv(siteDir, { site, opts });
  const context = {
    content: pageContent(page, opts),
    __page_modules: page.modules || {},
    nav_active: null,
    nav_hide_cta: false,
  };
  return env.render(page.template, context);
}

// ---------------------------------------------------------------------------
// Public: render the blog LISTING (templates/blog.html) for a set of posts —
// the main /blog index or a /blog/tag/<slug> page. HubSpot exposes the page's
// posts as `contents` (a list of content objects) plus pagination vars; we pass
// all posts on one page (no pagination), so the template's paginate block (guarded
// by contents.total_page_count > 1) is inert.
// ---------------------------------------------------------------------------
export function renderBlogListing(posts, { siteDir, site, baseUrl = '', assetBase = '/assets', lang = 'en',
  headerIncludes = '', footerIncludes = '', tagSlugFor, route = '/blog' } = {}) {
  const opts = { baseUrl, assetBase, lang, headerIncludes, footerIncludes, tagSlugFor };
  const env = makeEnv(siteDir, { site, opts });
  const context = {
    contents: posts.map((p) => postContent(p, opts)),
    content: { absolute_url: baseUrl + route, canonical_url: baseUrl + route },
    current_page_num: 1,
    nav_active: null,
    nav_hide_cta: false,
  };
  return env.render('templates/blog.html', context);
}

export { postContent, pageContent, assetUrl, localizeDate, makeEnv };
