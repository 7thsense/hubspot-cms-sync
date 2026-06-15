// sync/adapters/menus.mjs — advanced/native MENU capture.
//
// HubSpot "advanced menus" (/content/api/v2/menus) drive site navigation. The original
// migration dropped them entirely (a prod probe found 8); the redesign uses hardcoded
// nav, but for a generic migrate-OFF-HubSpot workflow the menu tree IS the nav, so we
// capture it. Each tree node carries {label, url, children} directly (the per-account
// page_id is a fallback only), so the canonical form is portable without a page-id ref
// system: we keep label + url (verbatim) + children.
//
// DIRECTION: pull (capture) is the migrate-OFF direction and is verifiable read-only.
// PUSH-BACK to HubSpot is intentionally NOT implemented here — there is no writable
// menu target to verify against, and the menu write API takes a different (triple-
// redundant) tree shape. Rather than ship unverified write code, push() is an explicit,
// honest no-op that reports how many menus are in git. (Tracked as a follow-up.)

import { mkdir, writeFile as fsWriteFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { hub as realHub } from '../lib/hub.mjs';

export const name = 'menus';
// Capture stores urls verbatim, so no forms/assets/cta ref dependency.
export const dependsOn = [];

const MENUS_PATH = '/content/api/v2/menus';

function slugifyName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'menu';
}

// Project one raw menu tree node to the canonical { label, url?, children? }.
export function projectMenuNode(node) {
  const out = { label: node?.label ?? '' };
  if (node?.url) out.url = String(node.url);
  const children = Array.isArray(node?.children) ? node.children.map(projectMenuNode) : [];
  if (children.length) out.children = children;
  return out;
}

// Project a raw menu (detail) to canonical { name, label, tree }. The camelCase
// pageTreeNodeProperty is preferred; fall back to the snake_case pagesTree.
export function projectMenu(raw) {
  const root = raw?.pageTreeNodeProperty || raw?.pagesTree || {};
  const nodes = Array.isArray(root.children) ? root.children : [];
  return {
    name: raw?.name ?? raw?.label ?? '',
    label: raw?.label ?? raw?.name ?? '',
    tree: nodes.map(projectMenuNode),
  };
}

function menusDir(contentDir) {
  return join(contentDir, 'menus');
}

export async function pull(acct, ctx) {
  const { contentDir } = ctx;
  const hubFn = ctx.hub || realHub;
  const writeFileFn = ctx.writeFile || defaultWriteFile;

  const notes = [];
  const listed = await hubFn(acct, 'GET', MENUS_PATH);
  if (!listed.ok) {
    notes.push(`menus: list -> ${listed.status}; nothing pulled`);
    return { pulled: 0, notes };
  }
  const menus = Array.isArray(listed.json?.objects) ? listed.json.objects : [];

  let pulled = 0;
  for (const summary of menus) {
    // The list omits the tree; fetch each menu's detail.
    const detail = await hubFn(acct, 'GET', `${MENUS_PATH}/${summary.id}`);
    if (!detail.ok) {
      notes.push(`menus: skip "${summary.name}" (GET -> ${detail.status})`);
      continue;
    }
    const menu = projectMenu(detail.json);
    if (!menu.name) continue;
    await writeFileFn(join(menusDir(contentDir), `${slugifyName(menu.name)}.json`), `${JSON.stringify(menu, null, 2)}\n`);
    pulled += 1;
  }
  notes.push(`pulled ${pulled} menu(s)`);
  return { pulled, notes };
}

// Honest no-op (see header): capture-only. Reports git menu count so the operator knows
// nothing is being pushed back. Never throws — the orchestrator runs every adapter.
export async function push(acct, ctx) {
  const { contentDir } = ctx;
  const dir = menusDir(contentDir);
  let count = 0;
  if (existsSync(dir)) {
    const { readdir } = await import('node:fs/promises');
    count = (await readdir(dir)).filter((f) => f.endsWith('.json')).length;
  }
  return {
    pushed: 0,
    notes: [`menus: capture-only — push-back to HubSpot not implemented (no verifiable target); ${count} menu(s) in git`],
  };
}

async function defaultWriteFile(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await fsWriteFile(path, text);
}

export default { name, dependsOn, pull, push };
