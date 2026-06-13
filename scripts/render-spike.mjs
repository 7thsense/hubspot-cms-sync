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
import { renderPost } from '../src/lib/render.mjs';

const siteDir = resolve(process.argv[2] || '../7thsense-website');
const wantSlug = process.argv[3] || 'blog/inverting-hubspot-cms-with-generative-ai';
const outDir = resolve('dist');

const site = await loadSite(siteDir);
const post = site.posts.find((p) => p.slug === wantSlug) || site.posts[0];
if (!post) {
  console.error('No posts found under', siteDir);
  process.exit(1);
}

const html = renderPost(post, { siteDir, site, baseUrl: 'https://www.theseventhsense.com' });

// route "/blog/<slug>" -> dist/blog/<slug>/index.html
const outFile = join(outDir, post.route.replace(/^\//, ''), 'index.html');
await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, html, 'utf8');

console.log(`Rendered: ${post.title}`);
console.log(`  route:  ${post.route}`);
console.log(`  author: ${post.author?.name ?? '(none)'}`);
console.log(`  out:    ${outFile}`);
console.log(`  bytes:  ${html.length}`);
