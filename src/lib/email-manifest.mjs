// sync/lib/email-manifest.mjs — shared manifest parsing for email surfaces (pure).

export const PUSH_EMAIL_STATES = new Set(['draft', 'draftCopy', 'workflow']);

export const VALID_EMAIL_DESIRED_STATES = new Set([
  'ignore', 'pullOnly', 'draft', 'draftCopy', 'workflow', 'unsupportedAutomated',
]);

export const VALID_CTA_POLICIES = new Set(['fail', 'linkify']);

/**
 * @param {object|null} manifest parsed site.manifest.json
 * @returns {Map<string, object>}
 */
export function emailEntriesByKey(manifest) {
  const entries = Array.isArray(manifest?.emails) ? manifest.emails : [];
  return new Map(entries.filter((e) => e?.key).map((e) => [e.key, e]));
}

/**
 * Manifest entries that should be pushed as marketing-email drafts.
 */
export function pushEmailEntries(manifest) {
  const entries = Array.isArray(manifest?.emails) ? manifest.emails : [];
  return entries.filter((e) => e?.key && PUSH_EMAIL_STATES.has(e.desiredState));
}

/**
 * @param {object|null} manifest
 * @returns {Map<string, object>}
 */
export function emailTemplateEntriesByKey(manifest) {
  const entries = Array.isArray(manifest?.emailTemplates) ? manifest.emailTemplates : [];
  return new Map(entries.filter((e) => e?.key).map((e) => [e.key, e]));
}

/**
 * @param {object|null} manifest
 * @returns {Set<string>}
 */
export function manifestEmailBlockKeys(manifest) {
  const fromBlocks = Array.isArray(manifest?.emailBlocks)
    ? manifest.emailBlocks.filter((b) => b?.key).map((b) => b.key)
    : [];
  const fromEmails = (Array.isArray(manifest?.emails) ? manifest.emails : [])
    .flatMap((e) => (Array.isArray(e.blocks) ? e.blocks : []));
  return new Set([...fromBlocks, ...fromEmails]);
}

/**
 * True when templatePath points at a committed theme email shell (not legacy mapping).
 * @param {string} templatePath
 */
export function isCommittedEmailTemplatePath(templatePath) {
  const p = String(templatePath || '');
  if (!p) return false;
  if (p.includes('/email-templates/')) return true;
  if (p.startsWith('email-templates/')) return true;
  return false;
}

/**
 * Effective template path for push: manifest entry overrides canonical record.
 */
export function effectiveEmailTemplatePath(canon, manifestEntry = null) {
  const fromManifest = manifestEntry?.templatePath;
  if (fromManifest && String(fromManifest).trim()) return String(fromManifest).trim();
  return canon?.content?.templatePath ?? '';
}

/**
 * Block keys to merge for a campaign: manifest blocks[] + canon.blocks[].
 */
export function blockKeysForEmail(canon, manifestEntry = null) {
  const keys = new Set();
  for (const k of manifestEntry?.blocks ?? []) keys.add(k);
  for (const k of canon?.blocks ?? []) keys.add(k);
  return [...keys];
}

/**
 * Whether workflow metadata should be surfaced on push (no automated API write).
 */
export function isWorkflowEmail(manifestEntry) {
  return manifestEntry?.desiredState === 'workflow';
}