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
// Static ref resolution. @asset resolves to a LOCAL path under the deployed site
// (/assets/NAME). @form/@portal/@cta/@menu still point at HubSpot — embedded HubSpot
// forms POST to the HubSpot Forms API and CTAs link to HubSpot — so they resolve to a
// chosen HubSpot account's ids via its ref REGISTRY (the same map the push uses). When
// no registry is supplied these are left as-is (back-compat); without it, a form embed
// would carry literal @portal/@form:key and submit to an invalid URL.
// ---------------------------------------------------------------------------
export function resolveStaticRefs(value, { assetBase = '/assets', registry = null } = {}) {
  if (value == null) return value;
  let out = String(value).replace(/@asset:([^\s"'<>)]+)/g, (_m, nameRef) => `${assetBase}/${nameRef}`);
  if (registry) {
    out = out
      .replace(/@portal\b/g, () => (registry.portalId != null ? String(registry.portalId) : '@portal'))
      .replace(/@form:([A-Za-z0-9_-]+)/g, (m, k) => registry.forms?.[k] ?? m)
      .replace(/@cta:([A-Za-z0-9_-]+)/g, (m, k) => registry.ctas?.[k] ?? m)
      .replace(/@menu:([A-Za-z0-9_-]+)/g, (m, k) => registry.menus?.[k] ?? m);
  }
  return out;
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

// HubL's datetimeformat(value, '%Y-%m-%dT%H:%M:%SZ') — strftime-style formatting.
// Mirrors the HubL filter blog-post schema uses for an ISO-8601 datePublished, so
// the ONE template renders an identical datetime on the HubSpot and static targets.
// UTC for determinism. Unrecognized %-tokens pass through; everything else is literal.
function datetimeformat(value, fmt = '%Y-%m-%dT%H:%M:%SZ') {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const p2 = (n) => String(n).padStart(2, '0');
  const tokens = {
    Y: d.getUTCFullYear(),
    m: p2(d.getUTCMonth() + 1),
    d: p2(d.getUTCDate()),
    H: p2(d.getUTCHours()),
    M: p2(d.getUTCMinutes()),
    S: p2(d.getUTCSeconds()),
    '%': '%',
  };
  return String(fmt).replace(/%([YmdHMS%])/g, (m, t) => String(tokens[t]));
}

// HubL's escapejson — make a string safe to embed inside a JSON string literal
// (escapes quotes/backslashes/control chars) WITHOUT adding the surrounding quotes,
// so a template can write "{{ value|escapejson }}".
function escapejson(value) {
  return JSON.stringify(String(value ?? '')).slice(1, -1);
}

// HubL's striptags — remove HTML tags, leaving text content. On HubSpot, editable
// fields like content.name render wrapped in an hs_cos_wrapper <span> (for the in-page
// editor); striptags yields the clean title for JSON-LD/meta. On the static target the
// value is already clean, so this is a no-op there — keeping the ONE template valid for
// both renderers.
function striptags(value) {
  return String(value ?? '').replace(/<[^>]*>/g, '');
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
  env.addFilter('datetimeformat', datetimeformat);
  env.addFilter('escapejson', escapejson);
  env.addFilter('striptags', striptags);

  // get_asset_url rewrites css/js references to their content-hashed URLs when a build
  // manifest is present (static target); otherwise it falls back to the plain path.
  env.addGlobal('get_asset_url', (path) => {
    const key = String(path).replace(/^(\.\.\/)+/, '').replace(/^\/+/, '');
    return opts.assetManifest?.[key] || assetUrl(path);
  });
  // Absolute site origin from the build's baseUrl (e.g. https://www2.7thsense.io).
  // Templates need it for absolute URLs that relative paths can't satisfy —
  // og:image/twitter:image especially, which social scrapers reject when relative.
  // Empty string on the HubSpot target (where baseUrl is unset), so a template
  // that does `base_url ~ '/assets/x'` yields a root-relative path there.
  env.addGlobal('base_url', opts.baseUrl || '');
  env.addGlobal('html_lang', opts.lang || 'en');
  env.addGlobal('html_lang_dir', '');
  env.addGlobal('standard_header_includes', opts.headerIncludes || '');
  env.addGlobal('standard_footer_includes', opts.footerIncludes || '');
  // HubSpot's `request` object — the static target only knows the path of the page it is
  // rendering (templates use `request.path` for current-URL logic like active nav/topic
  // pills). path_and_query/query/query_dict are present-but-empty so `x in request.*`
  // checks never hit an undefined (the crash a missing `request` causes in nunjucks).
  env.addGlobal('request', {
    path: opts.requestPath || '',
    path_and_query: opts.requestPath || '',
    query: '',
    query_dict: {},
    referrer: '',
    search: '',
  });

  // blog_recent_posts('default', n) — HubL's recent-posts query. Backed by the
  // build-time neutral corpus, newest-first, projected to content shims.
  env.addGlobal('blog_recent_posts', (_group, count) =>
    (site?.posts || []).slice(0, count || 5).map((p) => postContent(p, opts)));
  // Default blog pagination link — renderBlogListing overrides this with the route-aware
  // version. Registered here so the HubL-parity guard (which reflects off makeEnv) sees
  // it as available, and any non-listing template using it still resolves.
  env.addGlobal('blog_page_link', (n) => (Number(n) <= 1 ? '/blog' : `/blog/page/${n}`));

  env.addExtension('ModuleExtension', new ModuleExtension(env, siteDir, opts));

  return env;
}

// Absolute URL helper: leave http(s) as-is, otherwise join onto baseUrl.
function absUrl(baseUrl, path) {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  return baseUrl + (String(path).startsWith('/') ? path : `/${path}`);
}

// NOTE: BlogPosting JSON-LD is NOT built here. It lives in templates/blog-post.html
// (HubL), rendered identically by HubSpot and the static env (datetimeformat/escapejson
// filters) — one source for both targets. A build-time builder here is exactly the
// static-only side-channel that left HubSpot's render without the structured data.

// ---------------------------------------------------------------------------
// Public: render one neutral post view to an HTML string.
// ---------------------------------------------------------------------------
export function renderPost(post, { siteDir, site, baseUrl = '', assetBase = '/assets', lang = 'en',
  headerIncludes = '', footerIncludes = '', assetManifest, registry = null, template = 'templates/blog-post.html' } = {}) {
  // The BlogPosting JSON-LD lives in the blog-post HubL template (rendered identically
  // on the HubSpot and static targets) — NOT injected here, which would double it on
  // the static side and leave HubSpot without it (the two-source divergence this fixes).
  const opts = { baseUrl, assetBase, lang, headerIncludes, footerIncludes, assetManifest, registry, requestPath: post.route };
  const env = makeEnv(siteDir, { site, opts });
  const context = {
    content: postContent(post, opts),
    nav_active: null,
    nav_hide_cta: false,
  };
  // Resolve @asset (-> /assets) and @form/@portal/@cta (-> HubSpot ids via registry)
  // across the TEMPLATE output too — e.g. a form embed's data-hs-form="@form:key".
  return resolveStaticRefs(env.render(template, context), { assetBase, registry });
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
  headerIncludes = '', footerIncludes = '', assetManifest, registry = null } = {}) {
  const opts = { baseUrl, assetBase, lang, headerIncludes, footerIncludes, assetManifest, registry, requestPath: page.route };
  const env = makeEnv(siteDir, { site, opts });
  const context = {
    content: pageContent(page, opts),
    __page_modules: page.modules || {},
    nav_active: null,
    nav_hide_cta: false,
  };
  return resolveStaticRefs(env.render(page.template, context), { assetBase, registry });
}

// ---------------------------------------------------------------------------
// Public: render the blog LISTING (templates/blog.html) for a set of posts —
// the main /blog index or a /blog/tag/<slug> page. HubSpot exposes the page's
// posts as `contents` (a list of content objects) plus pagination vars; we pass
// all posts on one page (no pagination), so the template's paginate block (guarded
// by contents.total_page_count > 1) is inert.
// ---------------------------------------------------------------------------
export function renderBlogListing(posts, { siteDir, site, baseUrl = '', assetBase = '/assets', lang = 'en',
  headerIncludes = '', footerIncludes = '', tagSlugFor, route = '/blog', assetManifest, registry = null,
  basePath = null, pageNum = 1, pageSize = 0 } = {}) {
  const opts = { baseUrl, assetBase, lang, headerIncludes, footerIncludes, tagSlugFor, assetManifest, registry, requestPath: route };
  const env = makeEnv(siteDir, { site, opts });
  // Pagination: pageSize <= 0 keeps the whole list on one page (back-compat). Otherwise
  // slice to the page window. blog_page_link mirrors HubSpot — page 1 is the listing
  // base (e.g. /blog), page N is <base>/page/N — and drives the template's paginator.
  const base = basePath || route;
  const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(posts.length / pageSize)) : 1;
  const pageItems = pageSize > 0 ? posts.slice((pageNum - 1) * pageSize, pageNum * pageSize) : posts;
  env.addGlobal('blog_page_link', (n) => (Number(n) <= 1 ? base : `${base}/page/${n}`));
  const contents = pageItems.map((p) => postContent(p, opts));
  contents.total_page_count = totalPages;
  const context = {
    contents,
    content: { absolute_url: baseUrl + route, canonical_url: baseUrl + route },
    current_page_num: pageNum,
    nav_active: null,
    nav_hide_cta: false,
  };
  return resolveStaticRefs(env.render('templates/blog.html', context), { assetBase, registry });
}

export { postContent, pageContent, assetUrl, localizeDate, makeEnv };
