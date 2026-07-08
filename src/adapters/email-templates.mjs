// sync/adapters/email-templates.mjs — manifest-scoped HubSpot email DnD shell upload.
//
// Custom email templates must be registered in Design Manager with
// `templateType: email` in the HTML annotation. The full theme adapter depends on
// forms (for @form injection in page modules) and uploads the entire theme tree;
// this adapter pushes only manifest-listed email-templates/*.html shells with no
// upstream dependencies — use `hcms push dev --only email-templates`.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { emailTemplateEntriesByKey } from '../lib/email-manifest.mjs';
import { assertEmailTemplateAnnotated } from '../lib/beefree-import.mjs';
import { THEME_NAME } from './theme.mjs';

export const name = 'email-templates';
export const dependsOn = [];

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const HUB_API = 'https://api.hubapi.com';

function loadManifest(config) {
  const path = config?.manifestFilePath;
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Strip "<themeName>/" from a manifest emailTemplates[].path value.
 * @param {string} manifestPath e.g. seventh-sense-theme/email-templates/foo.html
 * @param {string} themeName
 * @returns {string} repo-relative path e.g. email-templates/foo.html
 */
export function localPathFromManifestTemplate(manifestPath, themeName = THEME_NAME) {
  const prefix = `${themeName}/`;
  const p = String(manifestPath || '');
  if (!p.startsWith(prefix)) {
    throw new Error(
      `email-templates: manifest path must start with "${prefix}" (got "${p}")`,
    );
  }
  return p.slice(prefix.length);
}

async function uploadSourceFile(acct, themeName, relPath, buf, { tries = 4 } = {}) {
  const remote = relPath.replace(/\\/g, '/');
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const fd = new FormData();
      fd.append('file', new Blob([buf]), basename(remote));
      const res = await fetch(
        `${HUB_API}/cms/v3/source-code/published/content/${themeName}/${remote}`,
        { method: 'PUT', headers: { Authorization: `Bearer ${acct.key}` }, body: fd },
      );
      if (res.ok) return;
      const body = await res.text().catch(() => '');
      if (res.status !== 429 && res.status < 500) {
        throw new Error(`source-code PUT ${remote} -> ${res.status} ${body.slice(0, 300)}`);
      }
      lastErr = new Error(`source-code PUT ${remote} -> ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < tries) await new Promise((r) => setTimeout(r, 400 * attempt));
  }
  throw lastErr;
}

/**
 * push(acct, ctx) -> { pushed, notes }
 */
export async function push(acct, ctx = {}) {
  const { config } = ctx;
  const root = config?.root || REPO_ROOT;
  const themeName = config?.theme?.name || THEME_NAME;
  const manifest = loadManifest(config);
  const entries = [...emailTemplateEntriesByKey(manifest).values()];
  if (entries.length === 0) {
    return { pushed: 0, notes: ['no manifest emailTemplates — skipped'] };
  }

  const notes = [];
  let pushed = 0;

  for (const entry of entries) {
    const remoteRel = localPathFromManifestTemplate(entry.path, themeName);
    const localAbs = join(root, remoteRel);
    if (!existsSync(localAbs)) {
      throw new Error(`email-templates push: missing shell file ${remoteRel}`);
    }
    const html = readFileSync(localAbs, 'utf8');
    assertEmailTemplateAnnotated(html, remoteRel);

    await uploadSourceFile(acct, themeName, remoteRel, Buffer.from(html, 'utf8'));
    pushed += 1;
    notes.push(`email-template + ${entry.key} (${entry.path})`);
  }

  notes.push(
    `uploaded ${pushed} email template shell(s) to ${themeName} (portal ${acct.portalId})`,
  );
  return { pushed, notes };
}

export default { name, dependsOn, push };