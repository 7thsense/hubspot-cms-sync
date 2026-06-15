import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  stableStringify,
  stripVolatile,
  slugToFile,
  fileToSlug,
  canonicalPage,
  normalizeWidgets,
} from '../../src/lib/canonical.mjs';

// ── stableStringify ────────────────────────────────────────────────────────

test('stableStringify sorts object keys recursively', () => {
  const a = { b: 1, a: { z: 1, y: 2 }, c: [3, 2, 1] };
  const out = stableStringify(a);
  // Top-level keys sorted a,b,c; nested y before z.
  assert.equal(
    out,
    '{\n  "a": {\n    "y": 2,\n    "z": 1\n  },\n  "b": 1,\n  "c": [\n    3,\n    2,\n    1\n  ]\n}\n',
  );
});

test('stableStringify is deterministic regardless of input key order', () => {
  const a = { foo: 1, bar: { qux: 2, baz: 3 }, arr: [{ d: 1, c: 2 }] };
  const b = { arr: [{ c: 2, d: 1 }], bar: { baz: 3, qux: 2 }, foo: 1 };
  assert.equal(stableStringify(a), stableStringify(b));
});

test('stableStringify uses 2-space indent, LF, and a trailing newline', () => {
  const out = stableStringify({ a: 1 });
  assert.ok(out.endsWith('\n'), 'has trailing newline');
  assert.ok(!out.includes('\r'), 'no CR (LF only)');
  assert.ok(out.includes('\n  "a"'), '2-space indent');
});

test('stableStringify preserves array order (load-bearing)', () => {
  const out = stableStringify({ stats: [{ num: '1' }, { num: '2' }, { num: '3' }] });
  const idx1 = out.indexOf('"1"');
  const idx2 = out.indexOf('"2"');
  const idx3 = out.indexOf('"3"');
  assert.ok(idx1 < idx2 && idx2 < idx3, 'array order preserved');
});

// ── stripVolatile ──────────────────────────────────────────────────────────

test('stripVolatile removes id, *At, *ById, currentState, url, hash, folder, children', () => {
  const input = {
    id: '123',
    name: 'keep',
    createdAt: 't',
    updatedAt: 't',
    archivedAt: 't',
    publishDate: 't',
    createdById: '1',
    updatedById: '2',
    currentState: 'PUBLISHED',
    url: 'http://x',
    hash: 'abc',
    folder: true,
    children: [],
  };
  const out = stripVolatile(input);
  assert.deepEqual(out, { name: 'keep' });
});

test('stripVolatile recurses through nested objects and arrays', () => {
  const input = {
    keep: 'a',
    id: 'top',
    nested: { id: 'inner', value: 1, updatedAt: 't' },
    list: [
      { id: 'x', label: 'one', createdById: 'u' },
      { id: 'y', label: 'two' },
    ],
  };
  const out = stripVolatile(input);
  assert.deepEqual(out, {
    keep: 'a',
    nested: { value: 1 },
    list: [{ label: 'one' }, { label: 'two' }],
  });
});

test('stripVolatile honors extraKeys', () => {
  const out = stripVolatile({ id: '1', module_id: '999', name: 'x' }, ['module_id']);
  assert.deepEqual(out, { name: 'x' });
});

test('stripVolatile does NOT mutate its input', () => {
  const input = { id: '1', name: 'x', nested: { id: '2', v: 3 } };
  const copy = JSON.parse(JSON.stringify(input));
  stripVolatile(input);
  assert.deepEqual(input, copy, 'input untouched');
});

test('stripVolatile keeps empty objects/strings (targeted, not empty-omit)', () => {
  const input = { id: '1', css: {}, label: '', body: { section_id: '' } };
  const out = stripVolatile(input);
  assert.deepEqual(out, { css: {}, label: '', body: { section_id: '' } });
});

test('stripVolatile does not over-match keys that merely contain At/ById', () => {
  // "category"/"format"/"habit" must survive; only the *At / *ById families go.
  const input = { categoryId: 1, contentTypeCategory: 4, latitude: 5, name: 'x' };
  const out = stripVolatile(input);
  assert.deepEqual(out, { categoryId: 1, contentTypeCategory: 4, latitude: 5, name: 'x' });
});

// ── slug <-> file round-trip ───────────────────────────────────────────────

test('slugToFile maps empty slug to home', () => {
  assert.equal(slugToFile(''), 'home');
  assert.equal(slugToFile(null), 'home');
  assert.equal(slugToFile(undefined), 'home');
});

test('slugToFile escapes slashes to __', () => {
  assert.equal(slugToFile('blog/x'), 'blog__x');
  assert.equal(slugToFile('a/b/c'), 'a__b__c');
});

test('fileToSlug inverts slugToFile', () => {
  assert.equal(fileToSlug('home'), '');
  assert.equal(fileToSlug('blog__x'), 'blog/x');
  assert.equal(fileToSlug('a__b__c'), 'a/b/c');
});

test('slug <-> file round-trips for representative slugs', () => {
  for (const slug of ['', 'about', 'blog/post-1', 'a/b/c', 'pricing']) {
    assert.equal(fileToSlug(slugToFile(slug)), slug, `round-trip ${JSON.stringify(slug)}`);
  }
});

// ── canonicalPage ──────────────────────────────────────────────────────────

test('canonicalPage projects exactly the definition fields and drops volatile', () => {
  const raw = {
    id: '194021001339',
    slug: 'about',
    name: 'About Seventh Sense',
    htmlTitle: 'About | Seventh Sense',
    metaDescription: 'Who we are',
    language: 'en',
    templatePath: 'templates/about.html',
    headHtml: '<script>1</script>',
    footerHtml: '',
    linkRelCanonicalUrl: 'https://x/about',
    featuredImage: 'https://cdn/og.png',
    featuredImageAltText: 'og',
    useFeaturedImage: true,
    url: 'https://theseventhsense.com/about',
    createdAt: '2025-08-05T23:29:04.222Z',
    currentState: 'PUBLISHED',
    publishDate: '2025-08-05T23:29:04.222Z',
    widgets: {},
  };
  const out = canonicalPage(raw);
  assert.deepEqual(out, {
    slug: 'about',
    name: 'About Seventh Sense',
    htmlTitle: 'About | Seventh Sense',
    metaDescription: 'Who we are',
    language: 'en',
    templatePath: 'templates/about.html',
    headHtml: '<script>1</script>',
    footerHtml: '',
    linkRelCanonicalUrl: 'https://x/about',
    featuredImage: 'https://cdn/og.png',
    featuredImageAltText: 'og',
    useFeaturedImage: true,
    widgets: {},
  });
  // No volatile keys leaked.
  for (const k of ['id', 'url', 'createdAt', 'currentState', 'publishDate']) {
    assert.ok(!(k in out), `${k} not in canonical page`);
  }
});

test('canonicalPage captures head/footer/SEO/OG fields with safe defaults (no silent drop)', () => {
  // The fields that were silently dropped before — default to '' / false, never undefined.
  const out = canonicalPage({ slug: 'x', name: 'X', templatePath: 't.html' });
  assert.equal(out.headHtml, '');
  assert.equal(out.footerHtml, '');
  assert.equal(out.linkRelCanonicalUrl, '');
  assert.equal(out.featuredImage, '');
  assert.equal(out.featuredImageAltText, '');
  assert.equal(out.useFeaturedImage, false);
});

test('canonicalPage defaults homepage empty slug and language', () => {
  const out = canonicalPage({ name: 'Home', templatePath: 'templates/home.html' });
  assert.equal(out.slug, '');
  assert.equal(out.language, 'en');
  assert.equal(out.metaDescription, '');
});

test('canonicalPage KEEPS empty css/child_css/label inside widget carriers (codex #8)', () => {
  const raw = {
    slug: '',
    templatePath: 'templates/home.html',
    widgets: {
      hero: {
        body: { section_id: '', eyebrow: 'hi' },
        name: 'hero',
        type: 'module',
        label: 'Hero',
        css: {},
        child_css: {},
        id: 'should-be-dropped',
      },
    },
  };
  const out = canonicalPage(raw);
  assert.deepEqual(out.widgets.hero, {
    body: { section_id: '', eyebrow: 'hi' },
    name: 'hero',
    type: 'module',
    label: 'Hero',
    css: {},
    child_css: {},
  });
  // Empties survive; stray volatile widget key dropped.
  assert.ok('css' in out.widgets.hero && 'child_css' in out.widgets.hero);
  assert.ok(!('id' in out.widgets.hero));
});

test('normalizeWidgets supplies explicit empties for missing carrier fields', () => {
  const out = normalizeWidgets({ foo: { body: { x: 1 } } });
  assert.deepEqual(out.foo, {
    body: { x: 1 },
    name: 'foo',
    type: 'module',
    label: '',
    css: {},
    child_css: {},
  });
});

test('canonicalPage output is stable-stringify deterministic', () => {
  const a = { slug: 'x', name: 'N', templatePath: 't', widgets: { w: { name: 'w', body: {}, css: {}, child_css: {}, label: '', type: 'module' } } };
  const b = { templatePath: 't', widgets: { w: { body: {}, child_css: {}, css: {}, label: '', name: 'w', type: 'module' } }, name: 'N', slug: 'x' };
  assert.equal(stableStringify(canonicalPage(a)), stableStringify(canonicalPage(b)));
});
