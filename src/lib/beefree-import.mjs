// sync/lib/beefree-import.mjs — Beefree Simple Schema → canonical email + HubL shell (pure).

import {
  countBodyModules,
  dndModuleSection,
  DEFAULT_EMAIL_STYLE_SETTINGS,
} from './email-dnd.mjs';

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

function modStyle(mod, key, fallback = '') {
  if (!mod || typeof mod !== 'object') return fallback;
  const kebab = key.replace(/([A-Z])/g, '-$1').toLowerCase();
  return mod[key] ?? mod[kebab] ?? fallback;
}

/**
 * Map Beefree template.settings → HubSpot DnD styleSettings.
 * @param {object} settings
 * @returns {object}
 */
export function beefreeSettingsToStyleSettings(settings = {}) {
  const bg = settings.backgroundColor ?? settings['background-color'] ?? '#f5f8fa';
  const body = settings.contentAreaBackgroundColor ?? '#ffffff';
  const link = settings.linkColor ?? '#00a4bd';
  return {
    ...DEFAULT_EMAIL_STYLE_SETTINGS,
    backgroundColor: bg,
    bodyColor: body,
    linksFont: link ? { color: link } : DEFAULT_EMAIL_STYLE_SETTINGS.linksFont,
  };
}

/**
 * Convert a Beefree simple title module to HTML fragment.
 * @param {object} mod
 * @returns {string}
 */
export function titleModuleToHtml(mod) {
  const text = String(mod?.text ?? '').trim();
  if (!text) return '';
  if (/<[a-z]/i.test(text)) return text;
  const size = modStyle(mod, 'size', 24);
  const color = modStyle(mod, 'color', '#33475b');
  const align = modStyle(mod, 'align', 'left');
  const bold = mod.bold !== false;
  const pt = modStyle(mod, 'padding-top', 12);
  const pb = modStyle(mod, 'padding-bottom', 8);
  const lh = modStyle(mod, 'line-height', 1.2);
  const inner = bold ? `<strong>${escHtml(text)}</strong>` : escHtml(text);
  return (
    `<p style="font-size:${size}px;line-height:${lh};color:${color};text-align:${align};` +
    `padding-top:${pt}px;padding-bottom:${pb}px;margin:0;font-family:Arial,sans-serif;">${inner}</p>`
  );
}

/**
 * Convert a Beefree simple divider module to HTML fragment.
 * @param {object} mod
 * @returns {string}
 */
export function dividerModuleToHtml(mod) {
  const color = modStyle(mod, 'color', '#cbd6e2');
  const width = modStyle(mod, 'width', 100);
  return (
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0;">' +
    `<tr><td align="center"><hr style="border:0;border-top:1px solid ${color};` +
    `width:${width}%;margin:0;"></td></tr></table>`
  );
}

/**
 * Convert a Beefree simple button module to HTML fragment.
 * @param {object} mod
 * @returns {string}
 */
export function buttonModuleToHtml(mod) {
  const text = String(mod?.text ?? 'Learn more').trim();
  const href = String(mod?.href ?? '#');
  const color = modStyle(mod, 'color', '#ffffff');
  const bg = mod['background-color'] ?? mod.backgroundColor ?? '#00a4bd';
  return (
    '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0;" width="100%">' +
    '<tr><td align="center">' +
    `<a href="${escHtml(href)}" style="background-color:${bg};color:${color};` +
    'font-family:Arial,sans-serif;font-size:16px;font-weight:bold;text-decoration:none;' +
    `padding:12px 24px;border-radius:4px;display:inline-block;">${escHtml(text)}</a>` +
    '</td></tr></table>'
  );
}

/**
 * Convert a Beefree simple paragraph module to HTML fragment.
 * @param {object} mod
 * @returns {string}
 */
export function paragraphModuleToHtml(mod) {
  const text = mod?.text ?? mod?.html ?? '';
  if (typeof text !== 'string' || !text.trim()) return '';
  if (/<[a-z]/i.test(text)) return text;
  const size = modStyle(mod, 'size', 15);
  const color = modStyle(mod, 'color', '#444444');
  const align = modStyle(mod, 'align', 'left');
  const lh = modStyle(mod, 'line-height', 1.5);
  let inner = escHtml(text);
  if (mod.bold) inner = `<strong>${inner}</strong>`;
  return (
    `<p style="font-size:${size}px;line-height:${lh};color:${color};text-align:${align};` +
    `margin:0 0 10px;font-family:Arial,sans-serif;">${inner}</p>`
  );
}

/**
 * Convert any supported Beefree simple module to an HTML fragment.
 * @param {object} mod
 * @returns {string}
 */
export function beefreeModuleToHtml(mod) {
  const type = String(mod?.type ?? mod?.descriptor ?? 'paragraph').toLowerCase();
  if (type === 'title' || type === 'heading') return titleModuleToHtml(mod);
  if (type === 'divider' || type === 'separator') return dividerModuleToHtml(mod);
  if (type === 'button' || type === 'cta') return buttonModuleToHtml(mod);
  if (type === 'paragraph' || type === 'text' || type === 'html') {
    return paragraphModuleToHtml(mod);
  }
  return '';
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
        const html = beefreeModuleToHtml(mod);
        if (!html) {
          notes.push(`skipped Beefree module type "${type}"`);
          continue;
        }
        const name = bodyIndex === 0 ? 'hs_email_body' : `hs_email_body_${bodyIndex + 1}`;
        widgets[name] = {
          type: 'module',
          name,
          label: name,
          body: { html },
          smart_type: null,
        };
        bodyIndex += 1;
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
 * @param {string} [opts.dndAreaName='main'] — dnd_area id (HubSpot allows one per page)
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
  const template = simple?.template ?? simple;
  const { widgets, metadata, notes } = beefreeSimpleToWidgets(simple);
  const templatePath = `${themeName}/email-templates/${templateKey}.html`;
  const styleSettings = beefreeSettingsToStyleSettings(template?.settings ?? {});
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
      styleSettings,
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