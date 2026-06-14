#!/usr/bin/env node
// Republish CMS pages/posts so template/CSS/asset changes take effect.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { account as resolveAccount } from './lib/hub.mjs';

const API = 'https://api.hubapi.com';

function future() {
  return new Date(Date.now() + 90_000).toISOString().replace(/\.\d+Z$/, '.000Z');
}

function parse(argv) {
  let portal;
  let account;
  let all = false;
  let blog = false;
  const slugs = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--portal') portal = argv[++i];
    else if (argv[i] === '--account') account = argv[++i];
    else if (argv[i] === '--all') all = true;
    else if (argv[i] === '--blog') blog = true;
    else if (!account && !portal && !argv[i].startsWith('--')) account = argv[i];
    else slugs.push(argv[i]);
  }
  return { portal, account, all, blog, slugs };
}

function keyForPortal(portal, config) {
  const dir = config?.keyDir || process.env[config?.keyDirEnv || 'HUBSPOT_KEY_DIR'] || join(homedir(), '.hubspot');
  return readFileSync(join(dir, `${portal}.key`), 'utf8').trim();
}

async function republish(argv = process.argv.slice(2), opts = {}) {
  const { config } = opts;
  const parsed = parse(argv);
  let portal = parsed.portal;
  let key;
  if (parsed.account && !portal) {
    const acct = resolveAccount(parsed.account, config);
    portal = acct.portalId;
    key = acct.key;
  }
  if (!portal) {
    process.stderr.write('usage: hcms republish <account>|--portal <id> [slug...] [--all] [--blog]\n');
    return 1;
  }
  key ||= keyForPortal(portal, config);

  async function hub(method, path, body) {
    const r = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    return { ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) };
  }
  async function getAll(path) {
    const out = [];
    let after;
    do {
      const sep = path.includes('?') ? '&' : '?';
      const { j } = await hub('GET', `${path}${sep}limit=100${after ? `&after=${after}` : ''}`);
      out.push(...(j.results || []));
      after = j.paging?.next?.after;
    } while (after);
    return out;
  }

  const fut = future();
  let ok = 0;
  let fail = 0;
  let skipped = 0;
  async function schedule(kind, id, publishDate) {
    const body = { id: String(id), publishDate: publishDate || fut };
    const { status } = await hub('POST', `/cms/v3/${kind}/schedule`, body);
    // 409 = the page already has a scheduled publish (e.g. just published by a
    // `push --publish`, or an orphan portal page) — the desired end state, not a
    // failure. `--all` legitimately touches pages outside our manifest; don't let
    // their conflicts fail the deploy. Log for visibility.
    if (status === 204) ok++;
    else if (status === 409) { skipped++; console.error(`  ${kind} ${id} -> 409 already scheduled (skip)`); }
    else { fail++; console.error(`  ${kind} ${id} -> ${status}`); }
  }

  const pages = await getAll('/cms/v3/pages/site-pages?property=id,slug,state');
  const live = pages.filter((p) => p.state === 'PUBLISHED' || p.state === 'PUBLISHED_OR_SCHEDULED' || !p.state);
  const targets = parsed.all ? live : live.filter((p) => parsed.slugs.includes(p.slug) || (p.slug === '' && parsed.slugs.includes('/')));
  console.log(`republishing ${targets.length} page(s) on ${portal} @ ${fut}`);
  for (const p of targets) await schedule('pages/site-pages', p.id);

  if (parsed.blog) {
    const posts = (await getAll('/cms/v3/blogs/posts?property=id,slug,state,publishDate'))
      .filter((p) => p.state === 'PUBLISHED' && !/temporary-slug/.test(p.slug || ''));
    console.log(`republishing ${posts.length} blog post(s) (preserving publishDate)`);
    for (const p of posts) await schedule('blogs/posts', p.id, p.publishDate);
  }
  console.log(`scheduled ${ok} | already-scheduled ${skipped} | failed ${fail} (live in ~90s)`);
  return fail ? 1 : 0;
}

export { republish, republish as main };

if (import.meta.url === `file://${process.argv[1]}`) {
  republish().then((code) => process.exit(code));
}
