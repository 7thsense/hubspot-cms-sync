// sync/lib/email-blocks.mjs — reusable email widget blocks (pure).

import { join } from 'node:path';

export const BLOCKS_SUBDIR = 'blocks';
export const CAMPAIGNS_SUBDIR = 'campaigns';

/**
 * @param {string} contentDir
 * @returns {string}
 */
export function blocksDir(contentDir) {
  return join(contentDir, 'emails', BLOCKS_SUBDIR);
}

/**
 * Candidate paths for a campaign file (campaigns/ preferred, flat legacy fallback).
 * @param {string} contentDir
 * @param {string} key
 * @returns {string[]}
 */
export function campaignFileCandidates(contentDir, key) {
  const base = join(contentDir, 'emails');
  return [
    join(base, CAMPAIGNS_SUBDIR, `${key}.json`),
    join(base, `${key}.json`),
  ];
}

/**
 * @param {string} contentDir
 * @param {string} key
 * @returns {string}
 */
export function blockFilePath(contentDir, key) {
  return join(blocksDir(contentDir), `${key}.json`);
}

/**
 * Normalize a block file to a widgets map keyed by widget name.
 * @param {object} block
 * @returns {Record<string, object>}
 */
export function widgetsFromBlock(block) {
  if (!block || typeof block !== 'object') return {};
  if (block.widgets && typeof block.widgets === 'object') {
    return { ...block.widgets };
  }
  if (block.widgetName && block.widget) {
    return { [String(block.widgetName)]: block.widget };
  }
  return {};
}

/**
 * Merge block widgets under campaign widgets (campaign wins on name collision).
 * @param {Record<string, object>} blockWidgets
 * @param {Record<string, object>} campaignWidgets
 */
export function mergeEmailWidgets(blockWidgets, campaignWidgets) {
  const blocks = blockWidgets && typeof blockWidgets === 'object' ? blockWidgets : {};
  const campaign = campaignWidgets && typeof campaignWidgets === 'object' ? campaignWidgets : {};
  return { ...blocks, ...campaign };
}

/**
 * Load and merge manifest-listed blocks into campaign widgets.
 * @param {object} opts
 * @param {string} opts.contentDir
 * @param {string[]} opts.blockKeys
 * @param {object} opts.campaignWidgets
 * @param {{ existsSync: (p: string) => boolean, readFileSync: (p: string, enc: string) => string }} opts.fs
 * @returns {{ widgets: Record<string, object>, loaded: string[], missing: string[] }}
 */
export function mergeBlocksIntoCampaign({
  contentDir,
  blockKeys = [],
  campaignWidgets = {},
  fs,
}) {
  const loaded = [];
  const missing = [];
  let merged = {};
  for (const key of blockKeys) {
    const path = blockFilePath(contentDir, key);
    if (!fs.existsSync(path)) {
      missing.push(key);
      continue;
    }
    let block;
    try {
      block = JSON.parse(fs.readFileSync(path, 'utf8'));
    } catch {
      missing.push(key);
      continue;
    }
    merged = mergeEmailWidgets(merged, widgetsFromBlock(block));
    loaded.push(key);
  }
  return {
    widgets: mergeEmailWidgets(merged, campaignWidgets),
    loaded,
    missing,
  };
}

/**
 * List block keys that have producer files on disk.
 * @param {string} contentDir
 * @param {{ existsSync, readdirSync }} fs
 * @returns {Set<string>}
 */
export function knownBlockKeys(contentDir, fs) {
  const dir = blocksDir(contentDir);
  const keys = new Set();
  if (!fs.existsSync(dir)) return keys;
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.json')) keys.add(name.slice(0, -'.json'.length));
  }
  return keys;
}