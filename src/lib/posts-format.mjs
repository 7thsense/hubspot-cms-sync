// src/lib/posts-format.mjs — lossless codec between a blog post's HubSpot WIRE
// JSON and a human-readable frontmatter+body FILE.
//
// HubSpot stays the PRIMARY target, so this reshaping must never lose a field the
// blog push depends on. The contract is strict: fileToWire(wireToFile(x)) deep-
// equals x for every post in the corpus (proven by scripts/posts-roundtrip.mjs and
// the unit test). Losslessness is by CONSTRUCTION — known fields get pretty,
// neutral names; every other field passes through verbatim, so nothing is ever
// silently dropped. The pretty layer is cosmetic; the passthrough layer is the
// safety net.
//
// Why frontmatter: every post in the corpus is flat scalars + one array + two HTML
// blobs, the textbook frontmatter shape. The body becomes readable HTML; the diff
// becomes prose instead of an escaped JSON string; and Git-CMS tools (Keystatic /
// Tina / Decap) can later edit it directly. Templates and the page format are
// untouched — this is the light-touch slice.
//
// YAML note: js-yaml's DEFAULT_SCHEMA coerces ISO timestamps to Date objects, which
// would corrupt `publishDate` on round-trip. CORE_SCHEMA has no timestamp type, so
// every scalar stays the string it was. lineWidth:-1 disables line folding so long
// HTML/strings survive byte-for-byte.

import yaml from 'js-yaml';

const SCHEMA = yaml.CORE_SCHEMA;
const DUMP_OPTS = { schema: SCHEMA, lineWidth: -1, noRefs: true, quotingType: '"' };

// Wire field -> pretty frontmatter key (bijective). `state` and `postBody` are
// handled specially (status transform / body extraction); everything NOT listed
// here passes through under its own wire name, so the codec can never drop a field.
const TO_PRETTY = {
  name: 'title',
  authorName: 'author',
  tagNames: 'tags',
  featuredImageAltText: 'featuredImageAlt',
  postSummary: 'summary',
};
const TO_WIRE = Object.fromEntries(Object.entries(TO_PRETTY).map(([w, p]) => [p, w]));

const STATE_TO_STATUS = { PUBLISHED: 'published', DRAFT: 'draft' };
const STATUS_TO_STATE = Object.fromEntries(Object.entries(STATE_TO_STATUS).map(([s, t]) => [t, s]));

// Frontmatter key order: authored fields first (readability), passthrough/sync
// metadata last. Keys not listed keep insertion order after these.
const KEY_ORDER = ['title', 'htmlTitle', 'slug', 'status', 'publishDate', 'author',
  'tags', 'featuredImage', 'featuredImageAlt', 'useFeaturedImage', 'metaDescription', 'summary'];

function orderKeys(obj) {
  const out = {};
  for (const k of KEY_ORDER) if (k in obj) out[k] = obj[k];
  for (const k of Object.keys(obj)) if (!(k in out)) out[k] = obj[k];
  return out;
}

/**
 * wireToFile(post) -> string  (frontmatter + HTML body)
 * `postBody` becomes the body; every other field becomes frontmatter, renamed to
 * its pretty key when one exists, otherwise passed through verbatim.
 */
export function wireToFile(post) {
  const fm = {};
  let body = '';
  for (const [k, v] of Object.entries(post)) {
    if (k === 'postBody') { body = v ?? ''; continue; }
    if (k === 'state') { fm.status = STATE_TO_STATUS[v] ?? v; continue; }
    fm[TO_PRETTY[k] ?? k] = v;
  }
  const front = yaml.dump(orderKeys(fm), DUMP_OPTS);
  return `---\n${front}---\n${body}`;
}

const FENCE_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

/**
 * fileToWire(str) -> post  (inverse of wireToFile)
 * Restores `postBody` from the body and inverts the pretty renames / status map;
 * passthrough keys return under their original wire names unchanged.
 */
export function fileToWire(str) {
  const m = FENCE_RE.exec(str);
  if (!m) throw new Error('posts-format: missing or malformed frontmatter fence');
  const fm = yaml.load(m[1], { schema: SCHEMA }) || {};
  const post = {};
  for (const [k, v] of Object.entries(fm)) {
    if (k === 'status') { post.state = STATUS_TO_STATE[v] ?? v; continue; }
    post[TO_WIRE[k] ?? k] = v;
  }
  post.postBody = m[2];
  return post;
}
