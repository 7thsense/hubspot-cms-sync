// sync/lib/beefree-zip-import.mjs — Beefree HTML+images zip export → DnD campaign (pure).

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

import { pathToAssetToken } from '../adapters/assets.mjs';
import {
  DEFAULT_EMAIL_STYLE_SETTINGS,
  HUBSPOT_DND_FALLBACK_TEMPLATE,
} from './email-dnd.mjs';

/**
 * Canonical content/assets prefix for a Beefree zip import.
 * @param {string} key — campaign logical key
 */
export function beefreeAssetPrefix(key) {
  return `beefree/${key}`;
}

/**
 * Rewrite Beefree-relative image paths to portable @asset: tokens.
 * Handles src="images/…", src='images/…', and background-image: url('images/…').
 *
 * @param {string} html
 * @param {string} assetPrefix — e.g. beefree/pub-party-2026
 * @returns {string}
 */
export function rewriteBeefreeImageRefs(html, assetPrefix) {
  let out = String(html || '');
  out = out.replace(
    /src=(["'])images\/([^"']+)\1/gi,
    (_m, quote, file) => `src=${quote}${pathToAssetToken(`${assetPrefix}/${file}`)}${quote}`,
  );
  out = out.replace(
    /url\(\s*(['"]?)images\/([^)'"]+)\1\s*\)/gi,
    (_m, quote, file) => {
      const q = quote || '';
      return `url(${q}${pathToAssetToken(`${assetPrefix}/${file}`)}${q})`;
    },
  );
  return out;
}

/**
 * Pull responsive CSS and optional Google Font links from Beefree <head>.
 * @param {string} html
 * @returns {string}
 */
export function extractBeefreeHeadFragment(html) {
  const s = String(html || '');
  const links = [...s.matchAll(/<link[^>]*fonts\.googleapis\.com[^>]*>/gi)].map((m) => m[0]);
  const styleBlocks = [...s.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(
    (m) => `<style>${m[1]}</style>`,
  );
  return [...links, ...styleBlocks].join('\n');
}

/**
 * Extract the main Beefree layout table (nl-container … <!-- End -->).
 * @param {string} html
 * @returns {string}
 */
export function extractBeefreeBodyFragment(html) {
  const s = String(html || '');
  const marker = 'class="nl-container"';
  const idx = s.indexOf(marker);
  if (idx < 0) {
    const body = s.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    return body ? body[1].trim() : s.trim();
  }
  const tableStart = s.lastIndexOf('<table', idx);
  if (tableStart < 0) return s.slice(idx).trim();
  const endComment = s.indexOf('<!-- End -->', tableStart);
  if (endComment >= 0) {
    return s.slice(tableStart, endComment + '<!-- End -->'.length).trim();
  }
  const bodyEnd = s.indexOf('</body>', tableStart);
  return s.slice(tableStart, bodyEnd >= 0 ? bodyEnd : undefined).trim();
}

/**
 * Compose widget-ready HTML: head styles + nl-container body.
 * @param {string} html — full Beefree index.html
 * @param {string} assetPrefix
 * @returns {string}
 */
export function beefreeHtmlToEmailBody(html, assetPrefix) {
  const head = extractBeefreeHeadFragment(html);
  const body = extractBeefreeBodyFragment(html);
  const combined = `${head}\n${body}`;
  return rewriteBeefreeImageRefs(combined, assetPrefix);
}

/**
 * Infer HubSpot DnD styleSettings from Beefree outer background colors.
 * @param {string} html
 * @returns {object}
 */
export function beefreeHtmlToStyleSettings(html) {
  const s = String(html || '');
  const bodyBg = s.match(/<body[^>]*style="[^"]*background-color:\s*(#[0-9a-fA-F]{3,8})/i);
  const containerBg = s.match(
    /class="nl-container"[^>]*style="[^"]*background-color:\s*(#[0-9a-fA-F]{3,8})/i,
  );
  const linkColor = s.match(
    /<a[^>]*style="[^"]*color:\s*(#[0-9a-fA-F]{3,8})/i,
  );
  const bg = (bodyBg?.[1] ?? containerBg?.[1] ?? DEFAULT_EMAIL_STYLE_SETTINGS.backgroundColor)
    .toLowerCase();
  const settings = {
    ...DEFAULT_EMAIL_STYLE_SETTINGS,
    backgroundColor: bg,
    bodyColor: bg,
    bodyBorderWidth: 0,
    bodyBorderColorChoice: 'BORDER_MANUAL',
  };
  if (linkColor?.[1]) {
    settings.linksFont = { color: linkColor[1].toLowerCase() };
  }
  return settings;
}

/**
 * Build a single full-bleed hs_email_body widget from Beefree HTML.
 * @param {string} html — full index.html (before asset rewrite)
 * @param {string} assetPrefix
 * @returns {Record<string, object>}
 */
export function beefreeHtmlToWidgets(html, assetPrefix) {
  const fragment = beefreeHtmlToEmailBody(html, assetPrefix);
  return {
    hs_email_body: {
      type: 'module',
      name: 'hs_email_body',
      label: 'hs_email_body',
      body: {
        html: fragment,
        hs_enable_module_padding: false,
        hs_wrapper_css: {},
      },
      smart_type: null,
    },
  };
}

/**
 * List image files under a Beefree export images/ directory.
 * @param {string} imagesDir
 * @param {string} assetPrefix
 * @returns {{ file: string, assetPath: string, token: string }[]}
 */
export function listBeefreeImageAssets(imagesDir, assetPrefix) {
  if (!imagesDir || !existsSync(imagesDir)) return [];
  const out = [];
  for (const file of readdirSync(imagesDir)) {
    const abs = join(imagesDir, file);
    if (!statSync(abs).isFile()) continue;
    const assetPath = `${assetPrefix}/${file}`;
    out.push({
      file,
      assetPath,
      token: pathToAssetToken(assetPath),
    });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Extract a Beefree zip export to a directory (requires `unzip` on PATH).
 * @param {string} zipPath
 * @param {string} destDir
 */
export function extractBeefreeZip(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  execFileSync('unzip', ['-qo', zipPath, '-d', destDir], { stdio: 'pipe' });
}

/**
 * Read a Beefree HTML+images export from a zip path or extracted directory.
 * @param {string} exportPath — .zip file or directory with index.html
 * @param {{ tempDir?: string }} [opts]
 * @returns {{ html: string, imagesDir: string|null, htmlPath: string, sourceType: 'zip'|'dir', cleanup?: () => void }}
 */
export function readBeefreeExport(exportPath, { tempDir } = {}) {
  const abs = exportPath;
  if (!existsSync(abs)) {
    throw new Error(`Beefree export not found: ${exportPath}`);
  }

  const st = statSync(abs);
  if (st.isDirectory()) {
    const htmlPath = join(abs, 'index.html');
    if (!existsSync(htmlPath)) {
      throw new Error(`Beefree export directory missing index.html: ${exportPath}`);
    }
    const imagesDir = join(abs, 'images');
    return {
      html: readFileSync(htmlPath, 'utf8'),
      imagesDir: existsSync(imagesDir) ? imagesDir : null,
      htmlPath,
      sourceType: 'dir',
    };
  }

  if (extname(abs).toLowerCase() !== '.zip') {
    throw new Error(`Beefree export must be a .zip file or directory: ${exportPath}`);
  }

  const extractRoot = tempDir ?? join(dirname(abs), `.beefree-extract-${basename(abs, '.zip')}`);
  extractBeefreeZip(abs, extractRoot);
  const htmlPath = join(extractRoot, 'index.html');
  if (!existsSync(htmlPath)) {
    throw new Error(`Beefree zip missing index.html: ${exportPath}`);
  }
  const imagesDir = join(extractRoot, 'images');
  return {
    html: readFileSync(htmlPath, 'utf8'),
    imagesDir: existsSync(imagesDir) ? imagesDir : null,
    htmlPath,
    sourceType: 'zip',
    cleanup: () => {
      /* caller may rm extractRoot; zip imports copy provenance instead */
    },
  };
}

/**
 * Full projection: Beefree HTML export → canonical DnD campaign JSON shape.
 * Uses HubSpot Start_from_scratch shell so editor stays DRAG_AND_DROP.
 *
 * @param {object} opts
 * @param {string} opts.html — full index.html
 * @param {string} opts.key — campaign logical key
 * @param {string} [opts.name]
 * @param {string} [opts.subject]
 * @param {string} [opts.previewText]
 * @param {string} [opts.templatePath]
 */
export function projectBeefreeZipImport({
  html,
  key,
  name,
  subject,
  previewText,
  templatePath = HUBSPOT_DND_FALLBACK_TEMPLATE,
} = {}) {
  if (!key) throw new Error('projectBeefreeZipImport: key is required');
  if (!html) throw new Error('projectBeefreeZipImport: html is required');

  const assetPrefix = beefreeAssetPrefix(key);
  const widgets = beefreeHtmlToWidgets(html, assetPrefix);
  const styleSettings = beefreeHtmlToStyleSettings(html);

  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const defaultName = titleMatch?.[1]?.trim() || key;

  const notes = [
    `zip import: ${Object.keys(widgets).length} body widget(s), full-bleed Beefree HTML`,
    `assets: rewrite images/* → @asset:${assetPrefix}/*`,
    `templatePath: ${templatePath} (DRAG_AND_DROP — do not use committed theme shells)`,
    'module padding disabled on hs_email_body for full-bleed layout',
  ];

  const campaign = {
    key,
    name: name ?? defaultName,
    subject: subject ?? name ?? defaultName,
    type: 'BATCH_EMAIL',
    subcategory: 'batch',
    emailTemplateMode: 'DRAG_AND_DROP',
    language: 'en',
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

  if (previewText) campaign.previewText = previewText;

  return { campaign, assetPrefix, notes };
}

/**
 * Copy Beefree images/ into content/assets/beefree/<key>/.
 * @param {string} imagesDir
 * @param {string} contentDir — repo content/ root
 * @param {string} assetPrefix
 * @param {boolean} [write]
 * @returns {{ file: string, assetPath: string, destPath: string, token: string }[]}
 */
export function stageBeefreeAssets(imagesDir, contentDir, assetPrefix, write = false) {
  const planned = listBeefreeImageAssets(imagesDir, assetPrefix).map((a) => ({
    ...a,
    destPath: join(contentDir, 'assets', a.assetPath),
  }));

  if (write && imagesDir) {
    for (const a of planned) {
      mkdirSync(dirname(a.destPath), { recursive: true });
      copyFileSync(join(imagesDir, a.file), a.destPath);
    }
  }

  return planned;
}

/**
 * Write provenance artifacts under imports/beefree/<key>/.
 * @param {object} opts
 */
export function writeBeefreeZipProvenance({
  importDir,
  key,
  exportPath,
  html,
  sourceHtml,
  assets,
  sourceType,
  write = false,
}) {
  const meta = {
    sourceType,
    sourcePath: exportPath,
    importedKey: key,
    assetPrefix: beefreeAssetPrefix(key),
    assetCount: assets.length,
    assets: assets.map((a) => a.assetPath),
  };

  const htmlArchive = join(importDir, 'source.index.html');
  const metaPath = join(importDir, 'import.meta.json');
  const zipArchive = join(importDir, 'source.zip');

  if (write) {
    mkdirSync(importDir, { recursive: true });
    writeFileSync(htmlArchive, sourceHtml ?? html);
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    if (sourceType === 'zip' && existsSync(exportPath)) {
      copyFileSync(exportPath, zipArchive);
    }
  }

  return { htmlArchive, metaPath, zipArchive, meta };
}