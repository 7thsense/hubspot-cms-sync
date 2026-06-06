// sync/cta-inventory.mjs — READ-ONLY legacy-CTA inventory + resolution helpers.
//
// WHY (codex #3/#5, gap-closure "REVISED approach"): legacy HubSpot CTAs are NOT
// portable. There is no working v3 CTA CRUD API (every documented list endpoint —
// /cms/v3/cta, /content/api/v2/cta(-buttons), /calls-to-action/v2/buttons, … —
// 404s on a real portal; the legacy CTA editor is sunset). The ONLY CTAs in this
// corpus live in legacy blog/landing-page bodies as the classic embed block:
//
//   <!--HubSpot Call-to-Action Code --><span class="hs-cta-wrapper" id="hs-cta-wrapper-<GUID>">
//     <span class="hs-cta-node hs-cta-<GUID>" id="hs-cta-<GUID>">
//       <!--[if lte IE 8]><div id="hs-cta-ie-element"></div><![endif]-->
//       <a href="https://cta-redirect.hubspot.com/cta/redirect/<PORTAL>/<GUID>" [target=…] >
//         <img class="hs-cta-img" id="hs-cta-img-<GUID>" src="https://no-cache.hubspot.com/cta/default/<PORTAL>/<GUID>.png" alt="<NAME>"/>
//       </a>
//     </span>
//     <script src="https://js.hscta.net/cta/current.js"></script>
//     <script>hbspt.cta.load(<PORTAL>, '<GUID>', {});</script>
//   </span><!-- end HubSpot Call-to-Action Code -->
//
// Those carry a per-account portal id + a CTA GUID — neither is portable, and
// canonicalize() would turn them into `@cta:<guid-prefix>` tokens that NO adapter
// can resolve (the push preflight then fails-closed). Blind link-conversion would
// be silent fidelity loss (codex #5: analytics / redirect / styling).
//
// REVISED approach: build a one-time inventory mapping each CTA GUID to its
// { destinationHref, renderedHtml, name, tracked } by RESOLVING the public
// cta-redirect interstitial (the same URL the embed's own fallback <a> points at).
// That interstitial is an HTML page whose body contains
//   var redirectUrl = "<final destination>";
// so we extract the real destination href without any private API. The blog
// canonicalizer (blog.mjs) then rewrites each embed to a styled, portable
// <a class="btn" href="<destination>">…</a> — NO @cta token, NO per-account GUID.
//
// PRODUCTION 529456 is READ-ONLY. This tool only READS (an outbound GET to the
// public cta-redirect host + GETs against the account); it NEVER writes to any
// account. Output is cached to the gitignored .sync-state/<portal>.cta-inventory.json.
//
// Usage:  node sync/cta-inventory.mjs <account> [--content content] [--refresh]
//
// Pure helpers (no I/O — unit-testable without network):
//   ctaGuidsInText(text)          -> [guid, …]  (every CTA guid shape in a string)
//   extractRedirectUrl(html)      -> destination href | null  (from the interstitial)
//   ctaNameFromEmbed(html, guid)  -> alt-text name | null
//   resolveCtaEmbeds(text, inv)   -> { text, unresolved:[guid…], notes:[…] }

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

import { account as realAccount } from './lib/hub.mjs';

const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CTA_REDIRECT_HOST = 'https://cta-redirect.hubspot.com';

// ── pure: enumerate every CTA GUID shape in a string ────────────────────────────

// Every place a legacy CTA GUID appears in an embed: the redirect <a href>, the
// hbspt.cta.load() call, the wrapper/node/img ids, the data-hs-img-pg attr, and the
// {{cta('guid')}} HubL shortcode. Deduped, source-order preserved.
const GUID_SHAPES = [
  new RegExp(`cta/redirect/\\d{5,}/(${GUID})`, 'g'),
  new RegExp(`cta/default/\\d{5,}/(${GUID})`, 'g'),
  new RegExp(`hbspt\\.cta\\.load\\(\\s*\\d{5,}\\s*,\\s*['"](${GUID})['"]`, 'g'),
  new RegExp(`hs-cta(?:-wrapper|-node|-img|-ie-element)?-(${GUID})`, 'g'),
  new RegExp(`data-hs-img-pg=["'](${GUID})["']`, 'g'),
  new RegExp(`\\{\\{\\s*cta\\(\\s*['"](${GUID})['"]`, 'g'),
];

export function ctaGuidsInText(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const seen = new Set();
  const out = [];
  for (const re of GUID_SHAPES) {
    for (const m of text.matchAll(re)) {
      const g = m[1].toLowerCase();
      if (!seen.has(g)) {
        seen.add(g);
        out.push(g);
      }
    }
  }
  return out;
}

// ── pure: extract the destination href from a cta-redirect interstitial ──────────

// The interstitial sets `var redirectUrl = "<dest>";` (and uses window.location).
// Fall back to a plain meta-refresh / Location-style URL if the JS var is absent.
export function extractRedirectUrl(html) {
  if (typeof html !== 'string' || html.length === 0) return null;
  const jsVar = html.match(/var\s+redirectUrl\s*=\s*["']([^"']+)["']/);
  if (jsVar) return decodeHtml(jsVar[1]);
  const meta = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+url=([^"'>\s]+)/i);
  if (meta) return decodeHtml(meta[1]);
  const loc = html.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/);
  if (loc) return decodeHtml(loc[1]);
  return null;
}

function decodeHtml(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#47;/g, '/')
    .replace(/&quot;/g, '"');
}

// ── pure: best-effort human name from the embed (the image alt text) ─────────────

export function ctaNameFromEmbed(html, guid) {
  if (typeof html !== 'string') return null;
  // Find the <img …id="hs-cta-img-<guid>"…alt="…"> for this guid and read its alt.
  const re = new RegExp(
    `hs-cta-img-${guid.replace(/[-]/g, '\\-')}[^>]*?\\balt=["']([^"']*)["']`,
    'i',
  );
  const m = html.match(re);
  if (m && m[1]) return m[1];
  // Fallback: any alt on an hs-cta-img near this guid.
  const any = html.match(/hs-cta-img[^>]*?\balt=["']([^"']+)["']/i);
  return any ? any[1] : null;
}

// ── pure: rewrite CTA embeds in a body to portable styled <a> links ──────────────
//
// resolveCtaEmbeds(text, inventory) -> { text, unresolved, notes }
//
//   inventory: { [guid]: { destinationHref, name?, tracked? } }
//
// For each whole CTA embed block we find, look up its guid in the inventory:
//   • known + has destinationHref + NOT still-tracked → replace the WHOLE block with
//     <a class="btn" href="<dest>"[ target=_blank]>…label…</a>  (fully portable).
//   • unknown guid, or flagged still-tracked, or no destination → PRESERVE the raw
//     embed HTML verbatim and record a LOUD note + the guid in `unresolved` (never
//     silently dropped — the operator/preflight must see it).
//
// Idempotent: a body with no embed block is returned unchanged; an already-resolved
// <a class="btn"> is left alone (it carries no hs-cta markup to match).
const CTA_BLOCK_RE =
  /<!--\s*HubSpot Call-to-Action Code\s*-->[\s\S]*?<!--\s*end HubSpot Call-to-Action Code\s*-->/gi;

export function resolveCtaEmbeds(text, inventory = {}) {
  const notes = [];
  const unresolved = [];
  if (typeof text !== 'string' || text.length === 0) return { text, unresolved, notes };

  const out = text.replace(CTA_BLOCK_RE, (block) => {
    const guids = ctaGuidsInText(block);
    const guid = guids[0];
    if (!guid) {
      notes.push('⚠ CTA embed found with no recognizable GUID — preserved raw HTML.');
      return block;
    }
    const entry = inventory[guid];
    if (!entry || !entry.destinationHref) {
      unresolved.push(guid);
      notes.push(
        `⚠ CTA ${guid} not in inventory (or no destination) — preserved raw embed HTML. ` +
          `Run \`node sync/cta-inventory.mjs <account>\` to resolve it.`,
      );
      return block;
    }
    if (entry.tracked === true) {
      unresolved.push(guid);
      notes.push(
        `⚠ CTA ${guid} ("${entry.name || '?'}") is flagged STILL-TRACKED — preserved raw ` +
          `embed HTML to avoid losing analytics/redirect behavior (codex #5). Resolve manually.`,
      );
      return block;
    }
    const label = ctaNameFromEmbed(block, guid) || entry.name || 'Learn more';
    const targetBlank = /target=["']?_blank/i.test(block);
    return buildResolvedLink(entry.destinationHref, label, { targetBlank });
  });

  return { text: out, unresolved, notes };
}

// Build the portable replacement anchor. A styled button link, no per-account ids.
export function buildResolvedLink(href, label, { targetBlank = false } = {}) {
  const safeHref = escapeAttr(href);
  const safeLabel = escapeText(label);
  const tgt = targetBlank ? ' target="_blank" rel="noopener"' : '';
  return `<a class="btn cta-btn" href="${safeHref}"${tgt}>${safeLabel}</a>`;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── inventory I/O (cache under the gitignored .sync-state) ───────────────────────

export function inventoryPath(portalId) {
  return join(resolvePath('.sync-state'), `${portalId}.cta-inventory.json`);
}

export function loadInventory(portalId) {
  const p = inventoryPath(portalId);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function saveInventory(portalId, inv) {
  mkdirSync(resolvePath('.sync-state'), { recursive: true });
  const ordered = {};
  for (const k of Object.keys(inv).sort()) ordered[k] = inv[k];
  writeFileSync(inventoryPath(portalId), JSON.stringify(ordered, null, 2) + '\n');
}

// ── scan committed content for CTA guids ─────────────────────────────────────────

// Recursively collect every CTA GUID referenced under a content dir. Defaults to
// the blog (CTAs are blog/landing-page-content-only per codex #3/#5) but accepts
// any subtree so the operator can widen the scan.
export function scanContentForCtaGuids(contentDir, sub = '') {
  const root = join(resolvePath(contentDir), sub);
  const guids = new Set();
  if (!existsSync(root)) return [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (name.endsWith('.json')) {
        for (const g of ctaGuidsInText(readFileSync(full, 'utf8'))) guids.add(g);
      }
    }
  };
  walk(root);
  return [...guids].sort();
}

// ── resolution against the public cta-redirect interstitial ──────────────────────

// Resolve one CTA GUID to { destinationHref, name, renderedHtml, tracked, status }.
// READ-ONLY: a single outbound GET to the PUBLIC cta-redirect host (no account key,
// no write). `tracked` is true when we could not extract a destination (the CTA may
// still be live/tracked and must be preserved, not link-converted).
export async function resolveCta(portalId, guid, { fetchFn = fetch } = {}) {
  const redirectUrl = `${CTA_REDIRECT_HOST}/cta/redirect/${portalId}/${guid}`;
  let html = '';
  let status = 0;
  try {
    const res = await fetchFn(redirectUrl, { redirect: 'manual' });
    status = res.status;
    // A 3xx with a Location header is a clean destination; otherwise read the body.
    const loc = res.headers?.get?.('location');
    if (loc && /^https?:/i.test(loc)) {
      return {
        destinationHref: loc,
        name: null,
        renderedHtml: redirectUrl,
        tracked: false,
        status,
      };
    }
    html = await res.text();
  } catch (e) {
    return { destinationHref: null, name: null, renderedHtml: redirectUrl, tracked: true, status, error: e.message };
  }
  const destinationHref = extractRedirectUrl(html);
  return {
    destinationHref,
    name: ctaNameFromEmbed(html, guid),
    renderedHtml: redirectUrl,
    // If we could not extract a destination, treat as still-tracked/unknown so the
    // canonicalizer PRESERVES the raw embed rather than dropping it.
    tracked: destinationHref == null,
    status,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────

export async function buildInventory(
  name,
  { contentDir = 'content', sub = 'blog', refresh = false, account = realAccount, resolveFn = resolveCta, log = console.log } = {},
) {
  const acct = account(name);
  const guids = scanContentForCtaGuids(contentDir, sub);
  log(`cta-inventory: account "${acct.name}" (portal ${acct.portalId}) — ${guids.length} CTA guid(s) found under ${join(contentDir, sub)}`);

  const inv = refresh ? {} : loadInventory(acct.portalId);
  let resolved = 0;
  let stillTracked = 0;
  for (const guid of guids) {
    if (inv[guid] && inv[guid].destinationHref && !refresh) continue;
    const r = await resolveFn(acct.portalId, guid);
    inv[guid] = {
      destinationHref: r.destinationHref || null,
      name: r.name || null,
      renderedHtml: r.renderedHtml || null,
      tracked: r.tracked === true,
    };
    if (r.destinationHref) {
      resolved++;
      log(`  ✓ ${guid} -> ${r.destinationHref}${r.name ? `  (${r.name})` : ''}`);
    } else {
      stillTracked++;
      log(`  ⚠ ${guid} -> UNRESOLVED (status ${r.status}) — preserved as still-tracked/unknown`);
    }
  }
  saveInventory(acct.portalId, inv);
  log(`cta-inventory: ${resolved} resolved, ${stillTracked} still-tracked/unknown, ${Object.keys(inv).length} total -> ${inventoryPath(acct.portalId)}`);
  return inv;
}

async function main(argv) {
  const args = argv.slice(2);
  const name = args.find((a) => !a.startsWith('--'));
  if (!name) {
    console.error('Usage: node sync/cta-inventory.mjs <account> [--content <dir>] [--sub <subdir>] [--refresh]');
    process.exit(2);
  }
  const contentDir = optVal(args, '--content') || 'content';
  const sub = optVal(args, '--sub') ?? 'blog';
  const refresh = args.includes('--refresh');
  await buildInventory(name, { contentDir, sub, refresh });
}

function optVal(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// Run as CLI only when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv).catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}

export default {
  ctaGuidsInText,
  extractRedirectUrl,
  ctaNameFromEmbed,
  resolveCtaEmbeds,
  buildResolvedLink,
  loadInventory,
  inventoryPath,
  scanContentForCtaGuids,
  resolveCta,
  buildInventory,
};
