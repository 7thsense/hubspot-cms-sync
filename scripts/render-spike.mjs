// scripts/render-spike.mjs — de-risking spike for the static render target.
//
// Renders ONE real blog post from the 7thsense-website repo through the HubL
// engine and writes it to dist/, proving the Nunjucks-on-HubL bet end to end:
// neutral view -> content shim -> include resolution -> slice/filter shims ->
// blog_recent_posts -> HTML. Not the product; the spike that says the product
// is buildable.
//
//   node scripts/render-spike.mjs [siteDir] [postSlug]

import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { loadSite } from '../src/lib/content-view.mjs';
import { renderPost, renderPage } from '../src/lib/render.mjs';

const siteDir = resolve(process.argv[2] || '../7thsense-website');
const outDir = resolve('dist');
const baseUrl = 'https://www2.7thsense.io';

const site = await loadSite(siteDir);

async function emit(route, html) {
  const rel = route === '/' ? 'index.html' : join(route.replace(/^\//, ''), 'index.html');
  const outFile = join(outDir, rel);
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, html, 'utf8');
  return outFile;
}

// One blog post (proves the post path).
const post = site.posts.find((p) => p.slug === 'blog/inverting-hubspot-cms-with-generative-ai') || site.posts[0];
const postHtml = renderPost(post, { siteDir, site, baseUrl });
console.log(`post : ${post.route}  ->  ${await emit(post.route, postHtml)}  (${postHtml.length}b)`);

// The home page (proves the {% module %} path: 13 modules).
const home = site.pages.find((p) => p.route === '/' || p.slug === '');
if (home) {
  const homeHtml = renderPage(home, { siteDir, site, baseUrl });
  console.log(`page : ${home.route || '/'}  ->  ${await emit('/', homeHtml)}  (${homeHtml.length}b)`);
  console.log(`       modules on page: ${Object.keys(home.modules).length}`);
}
