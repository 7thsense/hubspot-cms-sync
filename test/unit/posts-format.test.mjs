// Unit tests for the lossless blog-post frontmatter codec (src/lib/posts-format.mjs).
// The load-bearing guarantee: fileToWire(wireToFile(x)) deep-equals x. These cover
// the traps — ISO date string (must NOT become a Date), passthrough of HubSpot-only
// fields, status<->state transform, empty arrays, and HTML bodies with frontmatter
// look-alikes — so a regression fails in CI without needing the live corpus.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wireToFile, fileToWire } from '../../src/lib/posts-format.mjs';

const FULL = {
  authorName: 'Mike Donnelly',
  blogName: 'Seventh Sense Blog',
  blogSlug: 'blog',
  featuredImage: '@asset:cover.png',
  featuredImageAltText: 'Cover',
  htmlTitle: 'A Title — With Punctuation: & Symbols',
  metaDescription: 'Meta with a colon: and "quotes".',
  name: 'A Title',
  postBody: '<p>Body with a line that looks like a fence:</p>\n<p>--- not a real fence ---</p>\n',
  postSummary: '<p>Summary HTML</p>',
  publishDate: '2026-06-06T01:19:09.000Z',
  slug: 'blog/a-title',
  sourceId: '123456789',
  sourcePortal: '@portal',
  state: 'PUBLISHED',
  tagNames: ['Artificial Intelligence', 'HubSpot'],
  useFeaturedImage: true,
};

test('round-trips a full post losslessly', () => {
  assert.deepEqual(fileToWire(wireToFile(FULL)), FULL);
});

test('publishDate survives as a STRING, not a Date', () => {
  const back = fileToWire(wireToFile(FULL));
  assert.equal(typeof back.publishDate, 'string');
  assert.equal(back.publishDate, '2026-06-06T01:19:09.000Z');
});

test('HubSpot-only fields pass through verbatim', () => {
  const back = fileToWire(wireToFile(FULL));
  for (const k of ['blogName', 'blogSlug', 'sourceId', 'sourcePortal', 'useFeaturedImage']) {
    assert.deepEqual(back[k], FULL[k], `field ${k} lost`);
  }
});

test('empty tags and draft state round-trip', () => {
  const draft = { ...FULL, state: 'DRAFT', tagNames: [], postBody: '' };
  assert.deepEqual(fileToWire(wireToFile(draft)), draft);
});

test('pretty keys appear in the file; HubSpot enums do not leak as values', () => {
  const file = wireToFile(FULL);
  assert.match(file, /^title: A Title$/m);
  assert.match(file, /^author: Mike Donnelly$/m);
  assert.match(file, /^status: published$/m);
  assert.doesNotMatch(file, /PUBLISHED/);
});

test('malformed file throws rather than silently corrupting', () => {
  assert.throws(() => fileToWire('no frontmatter here'), /frontmatter/);
});
