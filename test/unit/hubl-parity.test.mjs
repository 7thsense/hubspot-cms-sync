// Unit tests for the HubL-parity GUARD (src/lib/hubl-parity.mjs).
//
// The static build renders the SAME HubL templates HubSpot does, through render.mjs's
// Nunjucks env. A template that uses a filter/global that env doesn't implement crashes
// Nunjucks mid-render with a cryptic error (this broke the build for datetimeformat,
// escapejson, striptags, and the `request` global). The guard scans sources first and
// reports the unimplemented construct, the file, and that it must be added to render.mjs.
//
// These tests prove the core check WITHOUT the filesystem: registered name sets + template
// strings in, missing-construct report out. The real registered set is reflected off the
// actual makeEnv env so the "not flagged given the real env" cases stay honest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractFilters,
  extractGlobals,
  checkHublParity,
  formatParityError,
} from '../../src/lib/hubl-parity.mjs';
import { makeEnv } from '../../src/lib/render.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const siteDir = join(repoRoot, 'examples', 'minimal-site');

// The names the REAL static env registers (built-ins + makeEnv's HubL layer), reflected
// off a constructed env exactly as build-static does. Used to verify the guard does NOT
// flag constructs that ARE implemented now.
function realEnvNames() {
  const env = makeEnv(siteDir, { site: { posts: [] }, opts: {} });
  return { filters: Object.keys(env.filters), globals: Object.keys(env.globals) };
}

// ---------------------------------------------------------------------------
// Filter extraction
// ---------------------------------------------------------------------------
test('extractFilters: chained filters and filter args', () => {
  const f = extractFilters("{{ a|upper }} {{ b | trim | replace('x','y') }} {{ c|format_date('long') }}");
  assert.deepEqual([...f].sort(), ['format_date', 'replace', 'trim', 'upper']);
});

test('extractFilters: `||` (logical or) is not a filter', () => {
  assert.deepEqual([...extractFilters('{% if a || b %}')], []);
});

// ---------------------------------------------------------------------------
// (a) A template using |datetimeformat is flagged when datetimeformat is NOT in the
// registered set (simulate by stripping it), and NOT flagged given the real set.
// ---------------------------------------------------------------------------
test('missing filter: |datetimeformat flagged when absent, not flagged given the real env', () => {
  const src = `{{ content.publish_date|datetimeformat('%Y-%m-%dT%H:%M:%SZ') }}`;
  const { filters, globals } = realEnvNames();

  // Stripped set: datetimeformat removed -> must be reported as a missing filter.
  const stripped = filters.filter((n) => n !== 'datetimeformat');
  const absent = checkHublParity({ registeredFilters: stripped, registeredGlobals: globals, sources: [{ file: 'blog-post.html', src }] });
  assert.deepEqual(absent.missingFilters, [{ file: 'blog-post.html', name: 'datetimeformat' }]);

  // Real set: datetimeformat IS registered now -> not flagged.
  const present = checkHublParity({ registeredFilters: filters, registeredGlobals: globals, sources: [{ file: 'blog-post.html', src }] });
  assert.deepEqual(present.missingFilters, []);
});

// ---------------------------------------------------------------------------
// Global extraction
// ---------------------------------------------------------------------------
test('extractGlobals: catches call + member-access, ignores properties and locals', () => {
  const g = extractGlobals(
    `{{ get_asset_url('x') }} {{ request.path }} {% for item in contents %}{{ item.name }}{% endfor %}`,
  );
  // get_asset_url (call) and request (member root) are globals; item is a loop local,
  // content/contents are context locals, .path/.name are properties — none flagged.
  assert.deepEqual([...g].sort(), ['get_asset_url', 'request']);
});

test('extractGlobals: {% set %} targets are locals, not globals', () => {
  const g = extractGlobals(`{% set total = posts.length %}{{ total.foo }}`);
  assert.ok(!g.has('total'));
});

// ---------------------------------------------------------------------------
// (b) request.path flagged when `request` absent, NOT flagged when present.
// ---------------------------------------------------------------------------
test('missing global: request.path flagged when request absent, not flagged when present', () => {
  const src = `{% if request.path in topic_url %}active{% endif %}`;
  const { filters, globals } = realEnvNames();

  const stripped = globals.filter((n) => n !== 'request');
  const absent = checkHublParity({ registeredFilters: filters, registeredGlobals: stripped, sources: [{ file: 'shared-nav.html', src }] });
  // `request` is reported; `topic_url` is an undeclared identifier here too — guard reports
  // both, but the load-bearing assertion is that `request` is caught.
  assert.ok(absent.missingGlobals.some((m) => m.name === 'request' && m.file === 'shared-nav.html'));

  const present = checkHublParity({ registeredFilters: filters, registeredGlobals: globals, sources: [{ file: 'shared-nav.html', src }] });
  assert.ok(!present.missingGlobals.some((m) => m.name === 'request'));
});

// ---------------------------------------------------------------------------
// (c) NO false positives for legitimate context vars, loop locals, builtins, registered globals.
// ---------------------------------------------------------------------------
test('no false positives: content.name, for-loop with |upper, get_asset_url', () => {
  const { filters, globals } = realEnvNames();
  const sources = [{
    file: 'page.html',
    src: `{{ content.name }}
          {% for item in contents %}{{ item.x|upper }}{% endfor %}
          <link href="{{ get_asset_url('../css/main.css') }}">
          {{ module.heading }} {{ post.title }}`,
  }];
  const result = checkHublParity({ registeredFilters: filters, registeredGlobals: globals, sources });
  assert.deepEqual(result.missingFilters, [], 'no filter should be flagged');
  assert.deepEqual(result.missingGlobals, [], 'no global should be flagged');
});

// ---------------------------------------------------------------------------
// The REAL example-site templates render today, so the guard must pass on them
// (regression: the guard itself must not produce false positives on the live corpus).
// ---------------------------------------------------------------------------
test('real example-site templates pass the guard (reflecting off the real env)', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { relative } = await import('node:path');
  const { collectTemplateSources } = await import('../../src/lib/hubl-parity.mjs');
  const { preprocessHubl } = await import('../../src/lib/render.mjs');
  const { filters, globals } = realEnvNames();
  const sources = collectTemplateSources(
    [join(siteDir, 'templates'), join(siteDir, 'modules')],
    { readFileSync, readdirSync, statSync: null, join, relativeTo: (f) => relative(siteDir, f) },
  ).map(({ file, src }) => ({ file, src: preprocessHubl(src) }));
  assert.ok(sources.length > 0, 'should find example templates to scan');
  const result = checkHublParity({ registeredFilters: filters, registeredGlobals: globals, sources });
  assert.deepEqual(result.missingFilters, [], `unexpected missing filters: ${JSON.stringify(result.missingFilters)}`);
  assert.deepEqual(result.missingGlobals, [], `unexpected missing globals: ${JSON.stringify(result.missingGlobals)}`);
});

// ---------------------------------------------------------------------------
// Error message names the construct + file + render.mjs.
// ---------------------------------------------------------------------------
test('formatParityError names the construct, the file, and points at render.mjs', () => {
  const msg = formatParityError({
    missingFilters: [{ file: 'blog-post.html', name: 'datetimeformat' }],
    missingGlobals: [{ file: 'shared-nav.html', name: 'request' }],
  });
  assert.match(msg, /datetimeformat/);
  assert.match(msg, /blog-post\.html/);
  assert.match(msg, /request/);
  assert.match(msg, /shared-nav\.html/);
  assert.match(msg, /render\.mjs/);
});
