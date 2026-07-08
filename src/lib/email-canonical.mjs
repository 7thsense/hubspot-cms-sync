// sync/lib/email-canonical.mjs — portable marketing-email projection (pure).
//
// Projects HubSpot /marketing/v3/emails objects into git-committable JSON:
// logical key, portable fields, unsupported.readOnly audit bucket, and
// pushBlockedReasons populated at pull time.

import { stableStringify } from './canonical.mjs';
import { canonicalize as canonicalizeRefs, resolve as resolveRefs } from './refs.mjs';
import { resolveCtaEmbeds, ctaGuidsInText } from '../cta-inventory.mjs';
import {
  blockKeysForEmail,
  effectiveEmailTemplatePath,
  isCommittedEmailTemplatePath,
} from './email-manifest.mjs';
import { mergeBlocksIntoCampaign } from './email-blocks.mjs';
import { buildDnDFlexAreas, normalizeDnDPushWidgets } from './email-dnd.mjs';

export const EMAIL_SIDECAR_FILES = new Set([
  'template-paths.json',
  'subscriptions.json',
  'keys.json',
]);

export const EMAIL_NON_CAMPAIGN_DIRS = new Set(['blocks', 'campaigns']);

const READ_ONLY_KEYS = [
  'to',
  'activeDomain',
  'businessUnitId',
  'previewKey',
  'subscriptionDetails',
  'createdById',
  'updatedById',
  'createdAt',
  'updatedAt',
  'publishDate',
  'isAb',
  'isPublished',
  'isTransactional',
  'sendOnPublish',
  'id',
  'archived',
  'stats',
  'folderId',
  'folderIdV2',
];

const isMeaningful = (v) => {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'boolean') return true;
  return true;
};

/**
 * Stable logical key from email display name (forms-style slug).
 * @param {string} name
 * @returns {string}
 */
export function emailKeyForName(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'email';
}

/**
 * Derive templateMappingKey from a source content.templatePath.
 * @param {string} templatePath
 * @returns {string|null}
 */
export function templateMappingKeyForPath(templatePath) {
  const p = String(templatePath || '');
  const gen = /^generated_layouts\/(\d+)\.html$/i.exec(p);
  if (gen) return `generated-${gen[1]}`;
  if (p.startsWith('@hubspot/')) {
    return p
      .replace(/^@hubspot\/email\/dnd\//i, 'hubspot-')
      .replace(/\.html$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
  if (p.includes('/')) {
    return p
      .replace(/\.html$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
  return null;
}

/**
 * Load template-paths.json mapping object (pure — caller passes parsed JSON).
 * @param {Record<string, object>|null} templatePaths
 * @param {string|null} mappingKey
 * @returns {{ targetPath: string|null, verified: boolean, entry: object|null }}
 */
export function resolveTemplateMapping(templatePaths, mappingKey) {
  if (!mappingKey || !templatePaths || typeof templatePaths !== 'object') {
    return { targetPath: null, verified: false, entry: null };
  }
  const entry = templatePaths[mappingKey] ?? null;
  if (!entry || typeof entry !== 'object') {
    return { targetPath: null, verified: false, entry: null };
  }
  return {
    targetPath: entry.targetPath ? String(entry.targetPath) : null,
    verified: entry.verified === true,
    entry,
  };
}

function collectReadOnly(raw) {
  const readOnly = {};
  for (const k of READ_ONLY_KEYS) {
    if (isMeaningful(raw?.[k])) readOnly[k] = raw[k];
  }
  if (isMeaningful(raw?.webversion)) {
    readOnly.webversion = {
      enabled: raw.webversion.enabled,
      domain: raw.webversion.domain,
      slug: raw.webversion.slug,
      isPageRedirected: raw.webversion.isPageRedirected,
    };
  }
  return Object.keys(readOnly).length > 0 ? readOnly : null;
}

function deepClone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function processHtmlString(html, registry, ctaInventory, ctaPolicy, notes, unresolvedCtas) {
  if (typeof html !== 'string' || html.length === 0) return html;
  let text = html;
  if (ctaPolicy === 'linkify') {
    const resolved = resolveCtaEmbeds(text, ctaInventory);
    text = resolved.text;
    for (const n of resolved.notes) notes.push(n);
    for (const g of resolved.unresolved) unresolvedCtas.add(g);
  } else {
    for (const g of ctaGuidsInText(text)) unresolvedCtas.add(g);
  }
  return canonicalizeRefs(text, registry);
}

function canonicalizeWidgetValue(value, registry, ctaInventory, ctaPolicy, notes, unresolvedCtas) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return processHtmlString(value, registry, ctaInventory, ctaPolicy, notes, unresolvedCtas);
  }
  if (Array.isArray(value)) {
    return value.map((v) =>
      canonicalizeWidgetValue(v, registry, ctaInventory, ctaPolicy, notes, unresolvedCtas),
    );
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'html' && typeof v === 'string') {
        out[k] = processHtmlString(v, registry, ctaInventory, ctaPolicy, notes, unresolvedCtas);
      } else {
        out[k] = canonicalizeWidgetValue(v, registry, ctaInventory, ctaPolicy, notes, unresolvedCtas);
      }
    }
    return out;
  }
  return value;
}

/**
 * Canonicalize widget map (refs + optional CTA handling).
 */
export function canonicalizeWidgets(widgets, registry, {
  ctaInventory = {},
  ctaPolicy = 'fail',
  notes = [],
  unresolvedCtas = new Set(),
} = {}) {
  if (!widgets || typeof widgets !== 'object') return {};
  const out = {};
  for (const [name, widget] of Object.entries(widgets)) {
    if (!widget || typeof widget !== 'object') continue;
    const w = deepClone(widget);
    if (w.body != null) {
      w.body = canonicalizeWidgetValue(
        w.body, registry, ctaInventory, ctaPolicy, notes, unresolvedCtas,
      );
    }
    delete w.id;
    delete w.definition_id;
    out[name] = w;
  }
  return out;
}

/**
 * Compute pushBlockedReasons for a canonical email record.
 */
export function computePushBlockedReasons(canon, {
  templatePaths = null,
  manifestEntry = null,
  unresolvedCtas = [],
} = {}) {
  const reasons = [];
  const ctaPolicy = manifestEntry?.ctaPolicy ?? 'fail';
  if (unresolvedCtas.length > 0 && ctaPolicy !== 'linkify') {
    reasons.push(`unresolved CTA embed(s): ${[...new Set(unresolvedCtas)].sort().join(', ')}`);
  }
  const portablePath = effectiveEmailTemplatePath(canon, manifestEntry);
  const isNativeHubspotTemplate = portablePath.startsWith('@hubspot/');
  const isCommittedShell = isCommittedEmailTemplatePath(portablePath);
  const mappingKey = canon.templateMappingKey ?? templateMappingKeyForPath(portablePath);
  if (!isNativeHubspotTemplate && !isCommittedShell) {
    if (mappingKey) {
      const { verified, targetPath } = resolveTemplateMapping(templatePaths, mappingKey);
      if (!targetPath) {
        reasons.push(`no template-paths.json entry for mapping key "${mappingKey}"`);
      } else if (!verified) {
        reasons.push(`template mapping "${mappingKey}" not verified on target account`);
      }
    } else if (portablePath.startsWith('generated_layouts/')) {
      reasons.push('generated_layouts template path has no portable mapping');
    }
  }
  const ds = manifestEntry?.desiredState;
  const pushableDraft = ds === 'draft' || ds === 'draftCopy' || ds === 'workflow';
  if (canon.type === 'AUTOMATED_EMAIL' && !pushableDraft && ds !== 'unsupportedAutomated') {
    reasons.push('AUTOMATED_EMAIL workflow state is not recreated by push (mark draft/workflow or pullOnly)');
  }
  if (canon.unsupported?.readOnly?.to && !pushableDraft) {
    reasons.push('list/segment targeting (to) is read-only in v1');
  }
  return reasons;
}

/**
 * Resolve the templatePath to send on push (verified mapping for generated_layouts).
 */
export function resolvePushTemplatePath(canon, templatePaths, manifestEntry = null) {
  const path = effectiveEmailTemplatePath(canon, manifestEntry);
  if (isCommittedEmailTemplatePath(path)) return path;
  if (path.startsWith('@hubspot/')) return path;
  const mappingKey = canon.templateMappingKey ?? templateMappingKeyForPath(path);
  if (mappingKey) {
    const { targetPath, verified } = resolveTemplateMapping(templatePaths, mappingKey);
    if (targetPath && verified) return targetPath;
    if (path.startsWith('generated_layouts/')) {
      throw new Error(
        `email "${canon.key}": template mapping "${mappingKey}" is missing or not verified`,
      );
    }
  }
  return path;
}

function resolvePushWidgetValue(value, registry) {
  if (value == null) return value;
  if (typeof value === 'string') return resolveRefs(value, registry);
  if (Array.isArray(value)) {
    return value.map((v) => resolvePushWidgetValue(v, registry));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolvePushWidgetValue(v, registry);
    }
    return out;
  }
  return value;
}

/**
 * Deep-resolve @logical refs in widget bodies for push.
 */
export function resolvePushWidgets(widgets, registry) {
  if (!widgets || typeof widgets !== 'object') return {};
  const out = {};
  for (const [name, widget] of Object.entries(widgets)) {
    if (!widget || typeof widget !== 'object') continue;
    out[name] = resolvePushWidgetValue(widget, registry);
  }
  return out;
}

/**
 * Build the v1 marketing-email POST/PATCH body from a canonical record.
 */
export function buildEmailPushPayload(canon, {
  templatePaths,
  registry,
  manifestEntry = null,
  contentDir = null,
  fs = null,
} = {}) {
  const reasons = computePushBlockedReasons(canon, { templatePaths, manifestEntry });
  if (reasons.length > 0) {
    throw new Error(`email "${canon.key}": push blocked — ${reasons.join('; ')}`);
  }
  const templatePath = resolvePushTemplatePath(canon, templatePaths, manifestEntry);
  let campaignWidgets = canon.content?.widgets ?? {};
  const blockKeys = blockKeysForEmail(canon, manifestEntry);
  if (blockKeys.length > 0) {
    if (!contentDir || !fs) {
      throw new Error(`email "${canon.key}": blocks ${blockKeys.join(', ')} require contentDir/fs to merge`);
    }
    const { widgets, missing } = mergeBlocksIntoCampaign({
      contentDir,
      blockKeys,
      campaignWidgets,
      fs,
    });
    if (missing.length > 0) {
      throw new Error(
        `email "${canon.key}": missing block file(s): ${missing.map((k) => `content/emails/blocks/${k}.json`).join(', ')}`,
      );
    }
    campaignWidgets = widgets;
  }
  let widgets = resolvePushWidgets(campaignWidgets, registry);
  // Committed email-templates/ paths are always DnD shells in this system, even when
  // emailTemplateMode is unset on older canonical records.
  const isDnD = canon.emailTemplateMode === 'DRAG_AND_DROP'
    || templatePath.includes('/dnd/')
    || isCommittedEmailTemplatePath(templatePath);
  if (isDnD) {
    widgets = normalizeDnDPushWidgets(widgets, { previewText: canon.previewText });
  }
  const content = { templatePath, widgets };
  if (isDnD) {
    content.flexAreas = buildDnDFlexAreas(widgets);
  }
  return {
    name: canon.name,
    subject: canon.subject,
    from: {
      fromName: canon.from?.fromName ?? '',
      replyTo: canon.from?.replyTo ?? '',
    },
    content,
  };
}

/**
 * Project raw marketing email API object to canonical shape.
 * @param {object} raw
 * @param {object} opts
 * @returns {{ canon: object, notes: string[], unresolvedCtas: string[] }}
 */
export function canonicalEmail(raw, opts = {}) {
  const {
    key: forcedKey,
    registry = { portalId: null, forms: {}, ctas: {}, menus: {}, assets: {}, emails: {} },
    ctaInventory = {},
    ctaPolicy = 'fail',
    templatePaths = null,
    manifestEntry = null,
  } = opts;

  const notes = [];
  const unresolvedCtas = new Set();
  const sourcePath = raw?.content?.templatePath ?? '';
  const mappingKey = templateMappingKeyForPath(sourcePath);
  const { targetPath, verified } = resolveTemplateMapping(templatePaths, mappingKey);

  let portableTemplatePath = sourcePath;
  if (targetPath) {
    portableTemplatePath = targetPath;
  } else if (sourcePath.startsWith('generated_layouts/')) {
    notes.push(
      `⚠ "${raw.name}": template ${sourcePath} has no verified mapping — stored path kept; push blocked until template-paths.json`,
    );
  }

  const widgets = canonicalizeWidgets(raw?.content?.widgets, registry, {
    ctaInventory, ctaPolicy, notes, unresolvedCtas,
  });

  const readOnly = collectReadOnly(raw);
  const canon = {
    key: forcedKey ?? emailKeyForName(raw?.name),
    name: String(raw?.name ?? ''),
    subject: String(raw?.subject ?? ''),
    type: raw?.type ?? 'BATCH_EMAIL',
    subcategory: raw?.subcategory ?? '',
    emailTemplateMode: raw?.emailTemplateMode ?? '',
    language: raw?.language ?? 'en',
    from: {
      fromName: raw?.from?.fromName ?? '',
      replyTo: raw?.from?.replyTo ?? '',
    },
    subscriptionName: raw?.subscriptionDetails?.subscriptionName ?? '',
    content: {
      templatePath: portableTemplatePath,
      widgets,
    },
    webversion: {
      enabled: raw?.webversion?.enabled ?? false,
    },
    jitterSendTime: raw?.jitterSendTime ?? true,
  };

  if (mappingKey) canon.templateMappingKey = mappingKey;
  if (readOnly) canon.unsupported = { readOnly };

  const pushBlockedReasons = computePushBlockedReasons(canon, {
    templatePaths,
    manifestEntry,
    unresolvedCtas: [...unresolvedCtas],
  });
  if (pushBlockedReasons.length > 0) canon.pushBlockedReasons = pushBlockedReasons;

  return { canon, notes, unresolvedCtas: [...unresolvedCtas] };
}

/**
 * Semantic fingerprint for round-trip comparison (strips volatiles).
 */
export function semanticEmailFingerprint(canon) {
  const pick = {
    key: canon.key,
    name: canon.name,
    subject: canon.subject,
    type: canon.type,
    subcategory: canon.subcategory,
    emailTemplateMode: canon.emailTemplateMode,
    language: canon.language,
    from: canon.from,
    subscriptionName: canon.subscriptionName,
    templateMappingKey: canon.templateMappingKey,
    content: canon.content,
    webversion: canon.webversion,
    jitterSendTime: canon.jitterSendTime,
  };
  return stableStringify(pick);
}

/**
 * Register pulled email ids in the per-account registry.
 */
export function populateEmailRegistry(registry, entries) {
  if (!registry.emails) registry.emails = {};
  for (const { key, id } of entries || []) {
    if (key && id != null) {
      registry.emails[key] = String(id);
      delete registry.__rev_emails;
    }
  }
  return registry;
}

/**
 * Disambiguate email keys when names slugify to the same key (forms pattern).
 */
export function assignEmailKeys(rawEmails, seedKeys = {}) {
  const used = new Set();
  const out = [];
  for (const raw of rawEmails) {
    let key = seedKeys[raw.id]
      ?? seedKeys[String(raw.id)]
      ?? seedKeys[raw.name]
      ?? emailKeyForName(raw.name);
    if (used.has(key)) {
      let n = 2;
      while (used.has(`${key}-${n}`)) n += 1;
      const disambiguated = `${key}-${n}`;
      out.push({
        raw,
        key: disambiguated,
        collisionNote:
          `⚠ email name collision: "${raw.name}" slug clashes — stored as "${disambiguated}"`,
      });
      used.add(disambiguated);
    } else {
      out.push({ raw, key, collisionNote: null });
      used.add(key);
    }
  }
  return out;
}