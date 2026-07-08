// sync/lib/beefree-import.mjs — Beefree Simple Schema → canonical email + HubL shell (pure).

import { countBodyModules, dndModuleSection } from './email-dnd.mjs';

/**
 * Escape text for HTML attribute or body insertion.
 * @param {string} s
 */
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Convert a Beefree simple paragraph module to HTML fragment.
 * @param {object} mod
 */
export function paragraphModuleToHtml(mod) {
  const text = mod?.text ?? mod?.html ?? '';
  if (typeof text !== 'string' || !text.trim()) return '';
  if (text.includes('<')) return text;
  return `<p style="line-height: 1.5;">${escHtml(text)}</p>`;
}

/**
 * Build HubSpot-style widgets from Beefree simple schema rows.
 * @param {object} simple — { template: { rows, settings?, metadata? } } or template object
 * @returns {{ widgets: object, metadata: object, notes: string[] }}
 */
export function beefreeSimpleToWidgets(simple) {
  const template = simple?.template ?? simple;
  const rows = Array.isArray(template?.rows) ? template.rows : [];
  const notes = [];
  const widgets = {};
  let bodyIndex = 0;

  for (const row of rows) {
    const columns = Array.isArray(row?.columns) ? row.columns : [];
    for (const col of columns) {
      const modules = Array.isArray(col?.modules) ? col.modules : [];
      for (const mod of modules) {
        const type = String(mod?.type ?? mod?.descriptor ?? 'paragraph').toLowerCase();
        if (type === 'paragraph' || type === 'text' || type === 'html') {
          const html = paragraphModuleToHtml(mod);
          if (!html) continue;
          const name = bodyIndex === 0 ? 'hs_email_body' : `hs_email_body_${bodyIndex + 1}`;
          widgets[name] = {
            type: 'module',
            name,
            label: name,
            body: { html },
            smart_type: null,
          };
          bodyIndex += 1;
          continue;
        }
        if (type === 'image') {
          const src = mod?.src ?? mod?.url ?? '';
          const name = `image_${Object.keys(widgets).length + 1}`;
          widgets[name] = {
            type: 'module',
            name,
            body: {
              img: {
                src: src.startsWith('http') ? src : `@asset:${src}`,
                alt: mod?.alt ?? '',
              },
            },
          };
          notes.push(`image module "${name}" — hosted URL tokenized if external`);
          continue;
        }
        notes.push(`skipped Beefree module type "${type}"`);
      }
    }
  }

  const metadata = template?.metadata ?? {};
  return { widgets, metadata, notes };
}

/**
 * HubSpot HTML comment annotation that registers a file as an email template
 * (not a CMS page). Without templateType: email, Source Code upload rejects
 * dnd_area tags as "unmapped templates".
 * @param {object} opts
 * @param {string} opts.label — Design Manager display name
 * @param {boolean} [opts.isAvailableForNewContent=true]
 * @returns {string}
 */
function annotationLabel(label) {
  return String(label || 'Email template').replace(/[\r\n]+/g, ' ').trim();
}

export function emailTemplateAnnotation({ label, isAvailableForNewContent = true } = {}) {
  const lines = [
    'templateType: email',
    `label: ${annotationLabel(label)}`,
    `isAvailableForNewContent: ${isAvailableForNewContent}`,
  ];
  return `<!--\n  ${lines.join('\n  ')}\n-->`;
}

/**
 * Fail closed before upload if a shell lacks HubSpot's email template annotation.
 * @param {string} html
 * @param {string} relPath — for error messages
 */
export function assertEmailTemplateAnnotated(html, relPath) {
  if (!/templateType:\s*email/i.test(String(html))) {
    throw new Error(
      `email template "${relPath}" missing "templateType: email" HTML annotation — ` +
        'HubSpot rejects dnd_area as an unmapped template without it',
    );
  }
}

/**
 * Generate a minimal HubSpot email DnD shell HubL document.
 * @param {object} opts
 * @param {string} opts.key — filename stem (email-templates/<key>.html)
 * @param {string} [opts.label] — Design Manager label (defaults to key)
 * @param {string} [opts.dndAreaName='main'] — dnd_area id (HubSpot allows one per email)
 * @param {number} [opts.bodyModuleCount=1] — email_body module rows in the shell
 * @param {boolean} [opts.includeLogo=true]
 * @param {boolean} [opts.includeFooter=true]
 * @returns {string}
 */
export function beefreeShellHtml({
  key,
  label,
  dndAreaName = 'main',
  bodyModuleCount = 1,
  includeLogo = true,
  includeFooter = true,
}) {
  const areaLabel = label || key;
  const annotation = emailTemplateAnnotation({ label: areaLabel });
  const sections = [];
  if (includeLogo) {
    sections.push(dndModuleSection('@hubspot/email_linked_image', 'label="Logo"'));
  }
  const bodies = Math.max(1, bodyModuleCount);
  for (let i = 0; i < bodies; i += 1) {
    sections.push(dndModuleSection('@hubspot/email_body'));
  }
  if (includeFooter) {
    sections.push(dndModuleSection('@hubspot/email_can_spam'));
  }
  return `${annotation}
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>{% if content.html_title and content.html_title != "" %}{{ content.html_title }}{% else %}{{ content.body.subject }}{% endif %}</title>
  {% if content.meta_description %}<meta name="description" content="{{ content.meta_description }}"/>{% endif %}
  {{ dnd_area_stylesheet }}
  {{ email_header_includes }}
  {{ reset_css_stylesheet }}
</head>
<body>
  <div id="preview_text" style="display:none!important">{% text "preview_text" label="Preview Text", value="", no_wrapper=True %}</div>
  {% dnd_area "${escHtml(dndAreaName)}" %}
${sections.join('\n')}
  {% end_dnd_area %}
</body>
</html>
`;
}

/**
 * Full import projection from Beefree Simple Schema.
 * @param {object} simple
 * @param {object} opts
 * @param {string} opts.key — campaign logical key
 * @param {string} opts.templateKey — shell filename stem
 * @param {string} opts.themeName — e.g. seventh-sense-theme
 */
export function projectBeefreeImport(simple, {
  key,
  templateKey,
  themeName = 'seventh-sense-theme',
  name,
  subject,
} = {}) {
  const { widgets, metadata, notes } = beefreeSimpleToWidgets(simple);
  const templatePath = `${themeName}/email-templates/${templateKey}.html`;
  const campaign = {
    key,
    name: name ?? metadata.title ?? key,
    subject: subject ?? metadata.subject ?? metadata.title ?? key,
    type: 'BATCH_EMAIL',
    subcategory: 'batch',
    emailTemplateMode: 'DRAG_AND_DROP',
    language: metadata.lang ?? 'en',
    from: { fromName: '', replyTo: '' },
    templatePath,
    blocks: [],
    content: {
      templatePath,
      widgets,
    },
    webversion: { enabled: false },
    jitterSendTime: true,
  };
  if (metadata.preheader) {
    campaign.previewText = metadata.preheader;
  }
  const shell = beefreeShellHtml({
    key: templateKey,
    label: metadata.title ?? templateKey,
    bodyModuleCount: countBodyModules(widgets),
    includeLogo: true,
    includeFooter: true,
  });
  return { campaign, shell, templatePath, notes };
}