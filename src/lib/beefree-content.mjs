// sync/lib/beefree-content.mjs — apply campaign copy to imported Beefree HTML (pure).

import { readFileSync, existsSync } from 'node:fs';

/**
 * Apply ordered string replacements to Beefree HTML.
 * @param {string} html
 * @param {{ find: string, replace: string }[]} replacements
 * @returns {{ html: string, applied: number, skipped: string[] }}
 */
export function applyBeefreeReplacements(html, replacements = []) {
  let out = String(html || '');
  let applied = 0;
  const skipped = [];
  for (const { find, replace } of replacements) {
    if (!find || !out.includes(find)) {
      skipped.push(find?.slice(0, 80) ?? '(empty)');
      continue;
    }
    out = out.split(find).join(replace);
    applied += 1;
  }
  return { html: out, applied, skipped };
}

/**
 * Load a JSON content spec from disk.
 * @param {string} specPath
 * @returns {{ replacements?: { find: string, replace: string }[] }}
 */
export function loadBeefreeContentSpec(specPath) {
  if (!existsSync(specPath)) {
    throw new Error(`Beefree content spec not found: ${specPath}`);
  }
  return JSON.parse(readFileSync(specPath, 'utf8'));
}

/**
 * Patch Beefree three-column card rows before global replacements.
 * Anchors each card by its template image filename (images/<file>).
 *
 * @param {string} html
 * @param {{ imageFile: string, titleFrom: string, titleTo: string, body: string }[]} patches
 */
export function applyBeefreeColumnPatches(html, patches = []) {
  let out = String(html || '');
  for (const patch of patches) {
    const { imageFile, titleFrom, titleTo, body } = patch;
    if (!imageFile || !titleFrom || !titleTo || !body) continue;
    const needle = `images/${imageFile}`;
    const parts = out.split(needle);
    if (parts.length < 2) continue;
    const chunk = parts[1];
    const tIdx = chunk.indexOf(titleFrom);
    if (tIdx < 0) continue;
    let part = chunk.slice(0, tIdx) + titleTo + chunk.slice(tIdx + titleFrom.length);
    const lorem = 'Lorem ipsum dolor sit amet, consectetuer adipiscing elit.';
    const lIdx = part.indexOf(lorem);
    if (lIdx >= 0) {
      part = part.slice(0, lIdx) + body + part.slice(lIdx + lorem.length);
    }
    out = parts[0] + needle + part;
  }
  return out;
}

/**
 * Apply a content spec: optional columnPatches, then ordered replacements.
 * @param {string} html
 * @param {object} spec
 */
export function applyBeefreeContentSpec(html, spec = {}) {
  let working = String(html || '');
  if (Array.isArray(spec.columnPatches) && spec.columnPatches.length > 0) {
    working = applyBeefreeColumnPatches(working, spec.columnPatches);
  }
  const replacements = Array.isArray(spec.replacements) ? spec.replacements : [];
  return applyBeefreeReplacements(working, replacements);
}