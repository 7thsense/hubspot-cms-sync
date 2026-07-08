// sync/adapters/emails.mjs — marketing email pull/push adapter (v1 draft-copy push).
//
// Pulls /marketing/v3/emails from the source account, canonicalizes to
// content/emails/<key>.json, tokenizes hosted URLs to @asset:, and registers
// registry.emails[key] = hubspotId. Push upserts manifest draftCopy emails as
// BATCH_EMAIL / DRAFT content clones on the target account.

import * as nodeFs from 'node:fs';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { hub as defaultHub } from '../lib/hub.mjs';
import { stableStringify } from '../lib/canonical.mjs';
import { loadInventory } from '../cta-inventory.mjs';
import { campaignFileCandidates } from '../lib/email-blocks.mjs';
import { pushEmailEntries, isWorkflowEmail, effectiveEmailTemplatePath, isCommittedEmailTemplatePath } from '../lib/email-manifest.mjs';
import {
  committedEmailTemplateExists,
  HUBSPOT_DND_FALLBACK_TEMPLATE,
} from '../lib/email-dnd.mjs';
import {
  assignEmailKeys,
  buildEmailPushPayload,
  canonicalEmail,
  populateEmailRegistry,
  EMAIL_SIDECAR_FILES,
} from '../lib/email-canonical.mjs';

export const name = 'emails';

// Resolve @asset: refs after the assets adapter uploads bytes (forward push topo).
export const dependsOn = ['assets'];

async function listMarketingEmails(acct, hub) {
  const out = [];
  let after;
  do {
    const base = '/marketing/v3/emails';
    const sep = base.includes('?') ? '&' : '?';
    const url = `${base}${sep}limit=100${after ? `&after=${after}` : ''}`;
    const { ok, status, json } = await hub(acct, 'GET', url);
    if (!ok) {
      const msg = json?.message || json?.category || JSON.stringify(json).slice(0, 200);
      throw new Error(`GET ${url} -> ${status}: ${msg}`);
    }
    out.push(...(json.results || []));
    after = json.paging?.next?.after;
  } while (after);
  return out;
}

function emailsDir(contentDir) {
  return join(contentDir, 'emails');
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function loadTemplatePaths(contentDir) {
  return readJsonIfExists(join(emailsDir(contentDir), 'template-paths.json'));
}

function loadSeedKeys(contentDir) {
  return readJsonIfExists(join(emailsDir(contentDir), 'keys.json')) ?? {};
}

function loadManifestEmailMap(config) {
  const path = config?.manifestFilePath;
  if (!path || !existsSync(path)) return { keys: null, byKey: new Map() };
  try {
    const m = JSON.parse(readFileSync(path, 'utf8'));
    const entries = Array.isArray(m.emails) ? m.emails : [];
    const byKey = new Map(entries.filter((e) => e?.key).map((e) => [e.key, e]));
    return { keys: new Set(byKey.keys()), byKey };
  } catch {
    return { keys: null, byKey: new Map() };
  }
}

function shouldPullEmail(key, { manifestKeys, pullAll }) {
  if (pullAll) return true;
  if (!manifestKeys || manifestKeys.size === 0) return false;
  return manifestKeys.has(key);
}

function writeSubscriptionsSummary(contentDir, rawEmails) {
  const counts = {};
  for (const e of rawEmails) {
    const n = e.subscriptionDetails?.subscriptionName || '(none)';
    counts[n] = (counts[n] || 0) + 1;
  }
  const subs = {};
  for (const [subscriptionName, count] of Object.entries(counts).sort()) {
    const key = subscriptionName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'none';
    subs[key] = { subscriptionName, count };
  }
  writeFileSync(
    join(emailsDir(contentDir), 'subscriptions.json'),
    stableStringify(subs),
  );
}

function mergeTemplatePathCandidates(contentDir, rawEmails) {
  const file = join(emailsDir(contentDir), 'template-paths.json');
  const existing = readJsonIfExists(file) ?? {};
  const modes = {};
  for (const e of rawEmails) {
    const sourcePath = e?.content?.templatePath;
    if (!sourcePath) continue;
    const gen = /^generated_layouts\/(\d+)\.html$/i.exec(sourcePath);
    const key = gen ? `generated-${gen[1]}` : null;
    if (!key || existing[key]) continue;
    existing[key] = {
      sourcePath,
      emailTemplateMode: e.emailTemplateMode ?? '',
      targetPath: '@hubspot/email/dnd/Start_from_scratch.html',
      verified: false,
      notes: 'auto-generated candidate — verify on dev before push',
    };
    modes[e.emailTemplateMode] = (modes[e.emailTemplateMode] || 0) + 1;
  }
  if (Object.keys(existing).length > 0) {
    writeFileSync(file, stableStringify(existing));
  }
  return Object.keys(existing).length;
}

/**
 * pull(acct, ctx) -> { pulled, notes }
 */
export async function pull(acct, ctx) {
  const { contentDir, registry, config } = ctx;
  const hub = ctx.hub || defaultHub;
  const notes = [];
  const pullAll = process.env.HCMS_EMAIL_PULL_ALL === '1' || ctx.pullAllEmails === true;

  const list = await listMarketingEmails(acct, hub);
  const templatePaths = loadTemplatePaths(contentDir);
  const seedKeys = loadSeedKeys(contentDir);
  const ctaInventory = loadInventory(acct.portalId);
  const { keys: manifestKeys, byKey: manifestByKey } = loadManifestEmailMap(config);

  const dir = emailsDir(contentDir);
  mkdirSync(dir, { recursive: true });

  const assigned = assignEmailKeys(list, seedKeys);
  let pulled = 0;

  for (const { raw, key, collisionNote } of assigned) {
    if (!shouldPullEmail(key, { manifestKeys, pullAll })) continue;

    const manifestEntry = manifestByKey.get(key) ?? null;
    const ctaPolicy = manifestEntry?.ctaPolicy ?? 'fail';

    const { canon, notes: canonNotes, unresolvedCtas } = canonicalEmail(raw, {
      key,
      registry,
      ctaInventory,
      ctaPolicy,
      templatePaths,
      manifestEntry,
    });

    writeFileSync(join(dir, `${key}.json`), stableStringify(canon));
    populateEmailRegistry(registry, [{ key, id: raw.id }]);
    pulled += 1;

    if (collisionNote) notes.push(collisionNote);
    for (const n of canonNotes) notes.push(n);
    if (unresolvedCtas.length > 0 && ctaPolicy !== 'linkify') {
      notes.push(
        `⚠ email "${raw.name}" (${key}): ${unresolvedCtas.length} unresolved CTA embed(s) — push blocked unless ctaPolicy:linkify`,
      );
    }
    if (canon.pushBlockedReasons?.length) {
      notes.push(
        `⚠ email "${raw.name}" (${key}): push blocked — ${canon.pushBlockedReasons.join('; ')}`,
      );
    }
  }

  if (pulled > 0 || pullAll) {
    writeSubscriptionsSummary(contentDir, list);
    const mappingCount = mergeTemplatePathCandidates(contentDir, list);
    notes.push(`template-path candidates: ${mappingCount} entries in content/emails/template-paths.json`);
  }

  if (manifestKeys && manifestKeys.size > 0 && !pullAll) {
    notes.push(`pulled ${pulled} manifest-listed email(s) (${list.length} on account)`);
  } else {
    notes.push(`pulled ${pulled} of ${list.length} account email(s)`);
  }

  return { pulled, notes };
}

function loadManifest(config) {
  const path = config?.manifestFilePath;
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function loadManifestPushEntries(config) {
  return pushEmailEntries(loadManifest(config));
}

function readCanonicalEmail(contentDir, key) {
  for (const file of campaignFileCandidates(contentDir, key)) {
    if (!existsSync(file)) continue;
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

function indexEmailsByName(list) {
  const byName = new Map();
  for (const e of list) {
    const n = e?.name;
    if (!n) continue;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(e);
  }
  return byName;
}

async function resolveTargetEmailId(acct, hub, key, name, registry, byName) {
  const regId = registry.emails?.[key];
  if (regId) return String(regId);
  const matches = byName.get(name) || [];
  if (matches.length === 1) return String(matches[0].id);
  if (matches.length > 1) {
    throw new Error(
      `emails push: name collision for "${name}" (${matches.length} matches) — ` +
        `cannot upsert "${key}" without registry.emails["${key}"]`,
    );
  }
  return null;
}

/**
 * push(acct, ctx) -> { pushed, notes }
 */
export async function push(acct, ctx) {
  const { contentDir, registry, config } = ctx;
  const hub = ctx.hub || defaultHub;
  const notes = [];
  const manifestEntries = loadManifestPushEntries(config);
  if (manifestEntries.length === 0) {
    return { pushed: 0, notes: ['no manifest pushable emails (draft/draftCopy/workflow) — skipped'] };
  }

  const templatePaths = loadTemplatePaths(contentDir);
  const list = await listMarketingEmails(acct, hub);
  const byName = indexEmailsByName(list);

  let pushed = 0;
  const upserted = [];

  for (const manifestEntry of manifestEntries) {
    const { key } = manifestEntry;
    const canon = readCanonicalEmail(contentDir, key);
    if (!canon) {
      throw new Error(`emails push: manifest email "${key}" has no content/emails/${key}.json`);
    }

    let effectiveManifestEntry = manifestEntry;
    const intendedTemplate = effectiveEmailTemplatePath(canon, manifestEntry);
    if (isCommittedEmailTemplatePath(intendedTemplate)) {
      const themeName = config?.theme?.name || 'seventh-sense-theme';
      const shellExists = await committedEmailTemplateExists(acct, intendedTemplate, themeName);
      if (!shellExists) {
        notes.push(
          `⚠ email "${key}": shell "${intendedTemplate}" missing on portal — ` +
            `using ${HUBSPOT_DND_FALLBACK_TEMPLATE}`,
        );
        effectiveManifestEntry = {
          ...manifestEntry,
          templatePath: HUBSPOT_DND_FALLBACK_TEMPLATE,
        };
      }
    }

    const body = buildEmailPushPayload(canon, {
      templatePaths,
      registry,
      manifestEntry: effectiveManifestEntry,
      contentDir,
      fs: nodeFs,
    });
    if (isWorkflowEmail(manifestEntry)) {
      notes.push(
        `workflow ${key}: draft pushed — attach to workflow "${manifestEntry.workflow?.sequence ?? '?'}" step ${manifestEntry.workflow?.step ?? '?'} manually in HubSpot`,
      );
    }
    const targetId = await resolveTargetEmailId(
      acct, hub, key, body.name, registry, byName,
    );

    if (targetId) {
      const cur = list.find((e) => String(e.id) === targetId);
      if (cur) {
        try {
          const remoteCanon = canonicalEmail(cur, {
            key, registry, templatePaths, manifestEntry,
          }).canon;
          const remoteBody = buildEmailPushPayload(remoteCanon, {
            templatePaths, registry, manifestEntry: effectiveManifestEntry, contentDir, fs: nodeFs,
          });
          if (stableStringify(body) === stableStringify(remoteBody)) {
            upserted.push({ key, id: targetId });
            notes.push(`email = ${key} (${targetId})`);
            continue;
          }
        } catch {
          /* remote shape differs — PATCH to converge */
        }
      }
      const r = await hub(acct, 'PATCH', `/marketing/v3/emails/${targetId}`, body);
      if (!r.ok) {
        const msg = r.json?.message || r.json?.category || JSON.stringify(r.json).slice(0, 200);
        throw new Error(`emails push: PATCH ${key} (${targetId}) -> ${r.status}: ${msg}`);
      }
      upserted.push({ key, id: targetId });
      notes.push(`email ~ ${key} (${targetId})`);
      pushed += 1;
      continue;
    }

    const r = await hub(acct, 'POST', '/marketing/v3/emails', body);
    if (!r.ok || r.json?.id == null) {
      const msg = r.json?.message || r.json?.category || JSON.stringify(r.json).slice(0, 200);
      throw new Error(`emails push: POST ${key} -> ${r.status}: ${msg}`);
    }
    const id = String(r.json.id);
    upserted.push({ key, id });
    notes.push(`email + ${key} (${id})`);
    pushed += 1;
  }

  populateEmailRegistry(registry, upserted);
  notes.push(`registry.emails populated with ${upserted.length} key(s)`);
  return { pushed, notes };
}