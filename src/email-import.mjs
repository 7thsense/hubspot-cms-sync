#!/usr/bin/env node
// sync/email-import.mjs — import external email designs into canonical git layout.
//
//   hcms emails import beefree <schema.json> --key <campaign> --template <shell-key> [--write]
//   hcms emails import beefree-zip <export.zip|dir> --key <campaign> [--write]

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { stableStringify } from './lib/canonical.mjs';
import { projectBeefreeImport } from './lib/beefree-import.mjs';
import {
  projectBeefreeZipImport,
  readBeefreeExport,
  stageBeefreeAssets,
  writeBeefreeZipProvenance,
} from './lib/beefree-zip-import.mjs';
import {
  applyBeefreeContentSpec,
  loadBeefreeContentSpec,
} from './lib/beefree-content.mjs';

export function importBeefreeFromFile(schemaPath, opts = {}) {
  const {
    key,
    templateKey = key,
    themeName = 'seventh-sense-theme',
    root = process.cwd(),
    write = false,
    name,
    subject,
  } = opts;

  if (!key) throw new Error('import beefree: --key is required');
  const raw = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const projected = projectBeefreeImport(raw, { key, templateKey, themeName, name, subject });

  const contentDir = join(root, 'content');
  const campaignPath = join(contentDir, 'emails', 'campaigns', `${key}.json`);
  const shellPath = join(root, 'email-templates', `${templateKey}.html`);
  const importMetaPath = join(root, 'imports', 'beefree', key, 'source.simple.json');

  if (write) {
    mkdirSync(dirname(campaignPath), { recursive: true });
    mkdirSync(dirname(shellPath), { recursive: true });
    mkdirSync(dirname(importMetaPath), { recursive: true });
    writeFileSync(campaignPath, stableStringify(projected.campaign));
    writeFileSync(shellPath, projected.shell);
    writeFileSync(importMetaPath, stableStringify(raw));
  }

  return {
    campaignPath,
    shellPath,
    importMetaPath,
    templatePath: projected.templatePath,
    notes: projected.notes,
  };
}

function resolveContentSpecPath(root, key, contentSpecPath) {
  if (contentSpecPath) return contentSpecPath;
  const defaultPath = join(root, 'imports', 'beefree', key, 'content.spec.json');
  return existsSync(defaultPath) ? defaultPath : null;
}

function applyOptionalContentSpec(html, { root, key, contentSpecPath, applyContent }) {
  const specPath = applyContent
    ? resolveContentSpecPath(root, key, contentSpecPath)
    : null;
  if (!specPath) return { html, contentNotes: [] };
  const spec = loadBeefreeContentSpec(specPath);
  const result = applyBeefreeContentSpec(html, spec);
  const notes = [
    `content spec: ${specPath} (${result.applied} replacements applied)`,
  ];
  if (result.skipped.length > 0) {
    notes.push(`content spec skipped ${result.skipped.length} missing fragment(s)`);
  }
  return { html: result.html, contentNotes: notes, customizedPath: specPath };
}

export function importBeefreeZipFromFile(exportPath, opts = {}) {
  const {
    key,
    root = process.cwd(),
    write = false,
    name,
    subject,
    previewText,
    templatePath,
    contentSpecPath,
    applyContent = true,
  } = opts;

  if (!key) throw new Error('import beefree-zip: --key is required');

  const source = readBeefreeExport(exportPath);
  const customized = applyOptionalContentSpec(source.html, {
    root, key, contentSpecPath, applyContent,
  });
  const projected = projectBeefreeZipImport({
    html: customized.html,
    key,
    name,
    subject,
    previewText,
    templatePath,
  });

  const contentDir = join(root, 'content');
  const campaignPath = join(contentDir, 'emails', 'campaigns', `${key}.json`);
  const importDir = join(root, 'imports', 'beefree', key);
  const assets = stageBeefreeAssets(
    source.imagesDir,
    contentDir,
    projected.assetPrefix,
    write,
  );

  const notes = [
    ...projected.notes,
    ...customized.contentNotes,
    `staged ${assets.length} image(s) under content/assets/${projected.assetPrefix}/`,
  ];

  const provenance = writeBeefreeZipProvenance({
    importDir,
    key,
    exportPath,
    html: customized.html,
    sourceHtml: source.html,
    assets,
    sourceType: source.sourceType,
    write,
  });

  const customizedHtmlPath = join(importDir, 'customized.index.html');

  if (write) {
    mkdirSync(dirname(campaignPath), { recursive: true });
    writeFileSync(campaignPath, stableStringify(projected.campaign));
    if (customized.contentNotes.length > 0) {
      writeFileSync(customizedHtmlPath, customized.html);
    }
  }

  return {
    campaignPath,
    importDir,
    importMetaPath: provenance.metaPath,
    templatePath: projected.campaign.templatePath,
    assetCount: assets.length,
    assets: assets.map((a) => a.token),
    notes,
  };
}

function parseCommonImportArgs(args, config) {
  const write = args.includes('--write');
  const keyIdx = args.indexOf('--key');
  const nameIdx = args.indexOf('--name');
  const subjectIdx = args.indexOf('--subject');
  const previewIdx = args.indexOf('--preview-text');
  const templatePathIdx = args.indexOf('--template-path');
  const key = keyIdx >= 0 ? args[keyIdx + 1] : null;
  const name = nameIdx >= 0 ? args[nameIdx + 1] : undefined;
  const subject = subjectIdx >= 0 ? args[subjectIdx + 1] : undefined;
  const previewText = previewIdx >= 0 ? args[previewIdx + 1] : undefined;
  const templatePath = templatePathIdx >= 0 ? args[templatePathIdx + 1] : undefined;
  const skipIndices = new Set(
    [keyIdx, nameIdx, subjectIdx, previewIdx, templatePathIdx]
      .filter((i) => i >= 0)
      .flatMap((i) => [i, i + 1]),
  );
  const positional = args.filter((a, i) => !a.startsWith('--') && !skipIndices.has(i));
  return {
    write,
    key,
    name,
    subject,
    previewText,
    templatePath,
    positional,
    root: config?.root ?? process.cwd(),
  };
}

export function refreshBeefreeCampaignContent(key, opts = {}) {
  const {
    root = process.cwd(),
    write = false,
    name,
    subject,
    previewText,
    templatePath,
    contentSpecPath,
  } = opts;
  if (!key) throw new Error('refresh beefree content: --key is required');

  const importDir = join(root, 'imports', 'beefree', key);
  const htmlPath = join(importDir, 'source.index.html');
  if (!existsSync(htmlPath)) {
    throw new Error(`missing ${htmlPath} — run beefree-zip import first`);
  }

  const html = readFileSync(htmlPath, 'utf8');
  const customized = applyOptionalContentSpec(html, {
    root, key, contentSpecPath, applyContent: true,
  });
  const projected = projectBeefreeZipImport({
    html: customized.html,
    key,
    name,
    subject,
    previewText,
    templatePath,
  });

  const campaignPath = join(root, 'content', 'emails', 'campaigns', `${key}.json`);
  const customizedHtmlPath = join(importDir, 'customized.index.html');

  if (write) {
    mkdirSync(dirname(campaignPath), { recursive: true });
    writeFileSync(campaignPath, stableStringify(projected.campaign));
    writeFileSync(customizedHtmlPath, customized.html);
  }

  return {
    campaignPath,
    customizedHtmlPath,
    notes: customized.contentNotes,
  };
}

export async function main(argv = process.argv.slice(2), config = {}) {
  const args = [...argv];
  const sub = args[0];

  if (sub === 'beefree-apply-content') {
    const rest = args.slice(1);
    const {
      write, key, name, subject, previewText, templatePath, positional, root,
    } = parseCommonImportArgs(rest, config);
    const contentSpecPath = positional[0] ?? undefined;
    if (!key) {
      console.error(
        'usage: hcms emails import beefree-apply-content --key <campaign> '
        + '[content.spec.json] [--write]',
      );
      return 2;
    }
    const result = refreshBeefreeCampaignContent(key, {
      root,
      write,
      name,
      subject,
      previewText,
      templatePath,
      contentSpecPath,
    });
    console.log(`campaign: ${result.campaignPath}`);
    console.log(`customized: ${result.customizedHtmlPath}`);
    for (const n of result.notes) console.log(`  note: ${n}`);
    if (!write) console.log('(dry-run — pass --write to update campaign)');
    return 0;
  }

  if (sub === 'beefree-zip') {
    const rest = args.slice(1);
    const {
      write, key, name, subject, previewText, templatePath, positional, root,
    } = parseCommonImportArgs(rest, config);
    const exportPath = positional[0];
    if (!exportPath || !existsSync(exportPath)) {
      console.error(
        'usage: hcms emails import beefree-zip <export.zip|dir> --key <campaign> '
        + '[--name <name>] [--subject <subject>] [--preview-text <text>] [--write]\n'
        + '  Zip exports need `unzip` on PATH. Directories must contain index.html + images/.',
      );
      return 2;
    }
    const noContent = rest.includes('--no-content-spec');
    const contentSpecIdx = rest.indexOf('--content-spec');
    const contentSpecPath = contentSpecIdx >= 0 ? rest[contentSpecIdx + 1] : undefined;
    const result = importBeefreeZipFromFile(exportPath, {
      key,
      root,
      write,
      name,
      subject,
      previewText,
      templatePath,
      contentSpecPath,
      applyContent: !noContent,
    });
    console.log(`campaign: ${result.campaignPath}`);
    console.log(`provenance: ${result.importDir}`);
    console.log(`templatePath: ${result.templatePath}`);
    console.log(`assets: ${result.assetCount}`);
    for (const n of result.notes) console.log(`  note: ${n}`);
    if (!write) console.log('(dry-run — pass --write to create files)');
    return 0;
  }

  const write = args.includes('--write');
  const keyIdx = args.indexOf('--key');
  const tplIdx = args.indexOf('--template');
  const themeIdx = args.indexOf('--theme');
  const nameIdx = args.indexOf('--name');
  const subjectIdx = args.indexOf('--subject');
  const key = keyIdx >= 0 ? args[keyIdx + 1] : null;
  const templateKey = tplIdx >= 0 ? args[tplIdx + 1] : key;
  const themeName = themeIdx >= 0 ? args[themeIdx + 1] : (config?.theme?.name ?? 'seventh-sense-theme');
  const name = nameIdx >= 0 ? args[nameIdx + 1] : undefined;
  const subject = subjectIdx >= 0 ? args[subjectIdx + 1] : undefined;
  const positional = args.filter((a, i) => {
    if (a.startsWith('--')) return false;
    if (keyIdx >= 0 && i === keyIdx + 1) return false;
    if (tplIdx >= 0 && i === tplIdx + 1) return false;
    if (themeIdx >= 0 && i === themeIdx + 1) return false;
    if (nameIdx >= 0 && i === nameIdx + 1) return false;
    if (subjectIdx >= 0 && i === subjectIdx + 1) return false;
    return true;
  });
  const schemaPath = positional[0];
  if (!schemaPath || !existsSync(schemaPath)) {
    console.error(
      'usage: hcms emails import beefree <schema.json> --key <campaign> '
      + '[--template <shell>] [--write]\n'
      + '  Unsupported Beefree module types are skipped (see import notes).',
    );
    return 2;
  }
  const result = importBeefreeFromFile(schemaPath, {
    key,
    templateKey,
    themeName,
    root: config?.root ?? process.cwd(),
    write,
    name,
    subject,
  });
  console.log(`campaign: ${result.campaignPath}`);
  console.log(`shell: ${result.shellPath}`);
  console.log(`templatePath: ${result.templatePath}`);
  for (const n of result.notes) console.log(`  note: ${n}`);
  if (!write) console.log('(dry-run — pass --write to create files)');
  return 0;
}