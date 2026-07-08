#!/usr/bin/env node
// sync/email-import.mjs — import external email designs into canonical git layout.
//
//   hcms emails import beefree <schema.json> --key <campaign> --template <shell-key> [--write]

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { stableStringify } from './lib/canonical.mjs';
import { projectBeefreeImport } from './lib/beefree-import.mjs';

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

export async function main(argv = process.argv.slice(2), config = {}) {
  const args = [...argv];
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
    console.error('usage: hcms emails import beefree <schema.json> --key <campaign> [--template <shell>] [--write]');
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