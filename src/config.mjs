import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const DEFAULT_CONFIG_FILE = 'hubspot-cms-sync.config.mjs';

export function defaultConfig(root = process.cwd()) {
  return {
    root: resolve(root),
    accountsFile: 'sync/accounts.json',
    keyDirEnv: 'HUBSPOT_KEY_DIR',
    contentDir: 'content',
    syncStateDir: '.sync-state',
    manifestPath: 'site.manifest.json',
    readOnlyPortalIds: [],
    knownPortalIds: [],
    assetHosts: {
      canonicalizeHostPatterns: ['hubfs', 'hubspotusercontent', 'cdn\\d*\\.hubspot\\.net'],
      legacySiteHosts: [],
    },
    adapters: {
      externalDirs: [],
    },
    theme: {
      name: 'theme',
      dirs: ['templates', 'modules', 'css', 'js', 'images'],
      files: ['theme.json', 'fields.json'],
    },
    blog: {
      slug: 'blog',
      itemTemplate: '',
      listingTemplate: '',
    },
    uiGated: [],
    verification: {
      baseUrlEnv: 'SITE_BASE_URL',
      commands: {},
    },
  };
}

function mergeConfig(base, override) {
  const out = { ...base, ...override };
  out.theme = { ...base.theme, ...(override.theme || {}) };
  out.blog = { ...base.blog, ...(override.blog || {}) };
  out.assetHosts = { ...base.assetHosts, ...(override.assetHosts || {}) };
  out.adapters = { ...base.adapters, ...(override.adapters || {}) };
  out.verification = { ...base.verification, ...(override.verification || {}) };
  out.verification.commands = {
    ...(base.verification?.commands || {}),
    ...(override.verification?.commands || {}),
  };
  return out;
}

export function resolveConfigPaths(cfg) {
  const root = resolve(cfg.root || process.cwd());
  const abs = (p) => resolve(root, p);
  const keyDir = process.env[cfg.keyDirEnv || 'HUBSPOT_KEY_DIR'] || join(homedir(), '.hubspot');
  return {
    ...cfg,
    root,
    keyDir,
    accountsPath: abs(cfg.accountsFile),
    contentDirPath: abs(cfg.contentDir),
    syncStateDirPath: abs(cfg.syncStateDir),
    manifestFilePath: abs(cfg.manifestPath),
  };
}

export async function loadConfig({ root = process.cwd(), configPath } = {}) {
  const base = defaultConfig(root);
  const file = resolve(root, configPath || DEFAULT_CONFIG_FILE);
  let user = {};
  if (existsSync(file)) {
    const mod = await import(pathToFileURL(file).href);
    user = mod.default || mod.config || {};
  }
  const cfg = resolveConfigPaths(mergeConfig(base, user));
  validateConfig(cfg);
  return cfg;
}

export function loadConfigSyncFallback({ root = process.cwd() } = {}) {
  return resolveConfigPaths(defaultConfig(root));
}

export function validateConfig(cfg) {
  const errors = [];
  if (!cfg.root) errors.push('missing root');
  if (!cfg.accountsFile) errors.push('missing accountsFile');
  if (!cfg.contentDir) errors.push('missing contentDir');
  if (!cfg.syncStateDir) errors.push('missing syncStateDir');
  if (!cfg.manifestPath) errors.push('missing manifestPath');
  if (!Array.isArray(cfg.readOnlyPortalIds)) errors.push('readOnlyPortalIds must be an array');
  if (!Array.isArray(cfg.knownPortalIds)) errors.push('knownPortalIds must be an array');
  if (!cfg.theme?.name) errors.push('theme.name is required');
  if (!Array.isArray(cfg.theme?.dirs)) errors.push('theme.dirs must be an array');
  if (!Array.isArray(cfg.theme?.files)) errors.push('theme.files must be an array');
  if (errors.length) {
    throw new Error(`Invalid hubspot-cms-sync config:\n${errors.map((e) => `- ${e}`).join('\n')}`);
  }
}

export async function readJsonFile(file, label = file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    throw new Error(`Cannot read ${label} at ${file}: ${e.message}`);
  }
}
