import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderBlogListing } from '../../src/lib/render.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const siteDir = join(repoRoot, 'examples', 'minimal-site');

const posts = Array.from({ length: 5 }, (_, i) => ({
  route: `/blog/post-${i + 1}`,
  title: `Post ${i + 1}`,
  htmlTitle: `Post ${i + 1}`,
  metaDescription: '',
  summary: '',
  body: '',
  featuredImage: '',
  featuredImageAlt: '',
  tags: [],
  publishDate: '2026-01-01',
}));

const countArticles = (html) => (html.match(/<article>/g) || []).length;

test('renderBlogListing paginates to the page window (pageSize slices posts)', () => {
  const base = { siteDir, site: { posts }, basePath: '/blog', pageSize: 2 };
  // 5 posts @ 2/page -> 3 pages of 2, 2, 1
  assert.equal(countArticles(renderBlogListing(posts, { ...base, route: '/blog', pageNum: 1 })), 2);
  assert.equal(countArticles(renderBlogListing(posts, { ...base, route: '/blog/page/2', pageNum: 2 })), 2);
  assert.equal(countArticles(renderBlogListing(posts, { ...base, route: '/blog/page/3', pageNum: 3 })), 1);
});

test('renderBlogListing without pageSize keeps every post on one page (back-compat)', () => {
  assert.equal(countArticles(renderBlogListing(posts, { siteDir, site: { posts }, route: '/blog' })), 5);
});
