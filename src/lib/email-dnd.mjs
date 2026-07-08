// sync/lib/email-dnd.mjs — DnD email widget normalization + shell layout (pure).

import { join } from 'node:path';

import {
  effectiveEmailTemplatePath,
  isCommittedEmailTemplatePath,
  pushEmailEntries,
} from './email-manifest.mjs';

export const HUBSPOT_DND_FALLBACK_TEMPLATE = '@hubspot/email/dnd/Start_from_scratch.html';

const LOGO_KEYS = new Set(['logo_image', 'logo', 'email_logo']);
const FOOTER_KEYS = new Set(['email_can_spam', 'email_footer']);

const HUB_API = 'https://api.hubapi.com';
const DEFAULT_THEME_NAME = 'seventh-sense-theme';

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

/**
 * Sort key for DnD widget placement: preview → logo → bodies → other → footer.
 * @param {string} name
 * @returns {[number, number]}
 */
export function dndWidgetRank(name) {
  if (name === 'preview_text') return [0, 0];
  if (LOGO_KEYS.has(name)) return [1, 0];
  if (name === 'hs_email_body') return [2, 0];
  const numbered = /^hs_email_body_(\d+)$/.exec(name);
  if (numbered) return [2, parseInt(numbered[1], 10)];
  if (name.startsWith('image_')) return [1, 10];
  if (FOOTER_KEYS.has(name)) return [4, 0];
  return [3, 0];
}

/**
 * Count hs_email_body* widgets (for shell section generation).
 * @param {Record<string, object>} widgets
 */
export function countBodyModules(widgets = {}) {
  const n = Object.keys(widgets).filter(
    (k) => k === 'hs_email_body' || /^hs_email_body_\d+$/.test(k),
  ).length;
  return Math.max(1, n);
}

/**
 * Normalize widgets for HubSpot DRAG_AND_DROP push:
 * - rich_text → type module (DnD editor ignores rich_text carriers)
 * - assign stable order for layout
 * - inject preview_text from campaign metadata when missing
 *
 * @param {Record<string, object>} widgets
 * @param {{ previewText?: string }} [opts]
 * @returns {Record<string, object>}
 */
export function normalizeDnDPushWidgets(widgets, { previewText } = {}) {
  const src = widgets && typeof widgets === 'object' ? widgets : {};
  const sorted = Object.entries(src).sort(([a], [b]) => {
    const [ra, sa] = dndWidgetRank(a);
    const [rb, sb] = dndWidgetRank(b);
    return ra - rb || sa - sb || a.localeCompare(b);
  });

  const out = {};
  let order = 1;

  if (previewText && !src.preview_text) {
    out.preview_text = {
      type: 'text',
      name: 'preview_text',
      order: 0,
      body: { value: previewText },
      smart_type: null,
    };
  }

  for (const [name, raw] of sorted) {
    if (!raw || typeof raw !== 'object') continue;
    const w = deepClone(raw);

    if (name === 'preview_text') {
      w.type = 'text';
      w.name = 'preview_text';
      w.order = 0;
      w.smart_type = w.smart_type ?? null;
      if (previewText && (!w.body?.value || w.body.value === '')) {
        w.body = { ...(w.body ?? {}), value: previewText };
      }
      out[name] = w;
      continue;
    }

    const isBody = name === 'hs_email_body' || /^hs_email_body_\d+$/.test(name);
    const needsModule = w.type === 'rich_text'
      || (isBody && w.body?.html != null && w.type !== 'module')
      || (LOGO_KEYS.has(name) && w.type !== 'module')
      || (FOOTER_KEYS.has(name) && w.type !== 'module');

    if (needsModule) w.type = 'module';
    w.name = w.name ?? name;
    w.order = w.order ?? order;
    w.smart_type = w.smart_type ?? null;
    order += 1;
    out[name] = w;
  }

  return out;
}

const FLEX_BREAKPOINT_STYLE = {
  backgroundColor: null,
  backgroundImage: null,
  backgroundImageType: null,
  backgroundType: 'CONTENT',
  borderBottom: null,
  borderBottomLeftRadius: null,
  borderBottomRightRadius: null,
  borderLeft: null,
  borderRight: null,
  borderTop: null,
  borderTopLeftRadius: null,
  borderTopRightRadius: null,
  hidden: null,
  marginBottom: null,
  marginTop: null,
  paddingBottom: '0px',
  paddingTop: '0px',
  verticalAlign: null,
};

const FLEX_SECTION_STYLE = {
  backgroundColor: null,
  backgroundImage: null,
  backgroundImageType: null,
  backgroundType: 'CONTENT',
  breakpointStyles: {
    default: { ...FLEX_BREAKPOINT_STYLE },
    mobile: { ...FLEX_BREAKPOINT_STYLE },
  },
  paddingBottom: '0px',
  paddingTop: '0px',
  stack: 'LEFT_TO_RIGHT',
};

/**
 * Build flexAreas.main so DnD preview/editor renders pushed widgets (not just the
 * flat widgets map). preview_text is excluded — it is not a dnd section module.
 *
 * @param {Record<string, object>} widgets normalized DnD widgets
 * @returns {{ main: object }}
 */
export function buildDnDFlexAreas(widgets = {}) {
  const keys = Object.keys(widgets)
    .filter((k) => k !== 'preview_text')
    .sort((a, b) => {
      const [ra, sa] = dndWidgetRank(a);
      const [rb, sb] = dndWidgetRank(b);
      return ra - rb || sa - sb || a.localeCompare(b);
    });

  const sections = keys.map((key, index) => ({
    id: `section-${index}`,
    path: null,
    style: { ...FLEX_SECTION_STYLE },
    columns: [{
      id: `column-${index}-0`,
      width: 12,
      widgets: [key],
    }],
  }));

  return {
    main: {
      boxFirstElementIndex: null,
      boxLastElementIndex: null,
      boxed: false,
      isSingleColumnFullWidth: false,
      sections,
    },
  };
}

/**
 * Strip "<themeName>/" from a manifest emailTemplates[].path value.
 * @param {string} manifestPath e.g. seventh-sense-theme/email-templates/foo.html
 * @param {string} [themeName]
 * @returns {string} repo-relative path e.g. email-templates/foo.html
 */
export function localPathFromManifestTemplate(manifestPath, themeName = DEFAULT_THEME_NAME) {
  const prefix = `${themeName}/`;
  const p = String(manifestPath || '');
  if (!p.startsWith(prefix)) {
    throw new Error(
      `email shell path must start with "${prefix}" (got "${p}")`,
    );
  }
  return p.slice(prefix.length);
}

/**
 * Unique committed shell manifest paths referenced by pushable emails and emailTemplates[].
 * @param {object|null} manifest
 * @param {string} [themeName]
 * @returns {string[]}
 */
export function committedShellManifestPaths(manifest, themeName = DEFAULT_THEME_NAME) {
  const paths = new Set();
  const templates = Array.isArray(manifest?.emailTemplates) ? manifest.emailTemplates : [];
  for (const t of templates) {
    if (t?.path && isCommittedEmailTemplatePath(t.path)) paths.add(t.path);
  }
  for (const entry of pushEmailEntries(manifest)) {
    const p = effectiveEmailTemplatePath(null, entry);
    if (p && isCommittedEmailTemplatePath(p)) paths.add(p);
  }
  return [...paths];
}

/**
 * Local repo paths (under root) for committed email shells required by the manifest.
 * @param {object|null} manifest
 * @param {string} root repo root
 * @param {string} [themeName]
 * @returns {string[]} absolute paths
 */
export function committedShellLocalPaths(manifest, root, themeName = DEFAULT_THEME_NAME) {
  return committedShellManifestPaths(manifest, themeName).map(
    (p) => join(root, localPathFromManifestTemplate(p, themeName)),
  );
}

/**
 * HubL for one full-width dnd_module row inside a dnd_area.
 * @param {string} modulePath e.g. @hubspot/email_body
 * @param {string} [extraParams] trailing HubL params (label=..., etc.)
 */
export function dndModuleSection(modulePath, extraParams = '') {
  const params = extraParams ? `, ${extraParams}` : '';
  return `    {% dnd_section %}
      {% dnd_column width=12 %}
        {% dnd_module path='${modulePath}'${params} %}
        {% end_dnd_module %}
      {% end_dnd_column %}
    {% end_dnd_section %}`;
}

/**
 * Whether a committed theme email shell exists on the target portal (Source Code API).
 * @param {object} acct { key }
 * @param {string} manifestPath e.g. seventh-sense-theme/email-templates/foo.html
 * @param {string} [themeName]
 */
export async function committedEmailTemplateExists(acct, manifestPath, themeName = 'seventh-sense-theme') {
  if (!isCommittedEmailTemplatePath(manifestPath)) return true;
  const prefix = `${themeName}/`;
  if (!String(manifestPath).startsWith(prefix)) return false;
  const rel = manifestPath.slice(prefix.length);
  const url = `${HUB_API}/cms/v3/source-code/published/content/${themeName}/${rel}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${acct.key}` } });
  return res.ok;
}