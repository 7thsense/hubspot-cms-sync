// Unit tests for the menus adapter — capture (pull) of HubSpot advanced menus.
// projectMenu/projectMenuNode are pure; pull/push are network/fs-mocked.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { projectMenu, projectMenuNode, pull, push, name, dependsOn } from '../../src/adapters/menus.mjs';

const ACCT = { name: 'prod', portalId: '529456', key: 'k' };

test('menus adapter metadata', () => {
  assert.equal(name, 'menus');
  assert.deepEqual(dependsOn, []);
});

test('projectMenuNode: keeps label + url, recurses children, drops empty url/children', () => {
  const node = {
    label: 'For HubSpot', url: 'https://x/for-hubspot', pageId: 123, isPublished: true,
    children: [{ label: 'Leaf', url: null, children: [] }],
  };
  assert.deepEqual(projectMenuNode(node), {
    label: 'For HubSpot',
    url: 'https://x/for-hubspot',
    children: [{ label: 'Leaf' }], // no url (null) and no empty children array
  });
});

test('projectMenu: name/label/tree from pageTreeNodeProperty (camelCase preferred)', () => {
  const raw = {
    name: 'Website Menu', label: 'Website Menu',
    pageTreeNodeProperty: { children: [{ label: 'A', url: '/a', children: [] }] },
    pagesTree: { children: [] }, // ignored when pageTreeNodeProperty present
  };
  assert.deepEqual(projectMenu(raw), { name: 'Website Menu', label: 'Website Menu', tree: [{ label: 'A', url: '/a' }] });
});

test('pull: fetches each menu detail and writes content/menus/<slug>.json', async () => {
  const writes = [];
  const hub = async (acct, method, path) => {
    if (path === '/content/api/v2/menus') return { ok: true, status: 200, json: { objects: [{ id: '1', name: 'Main Menu - 2025' }] } };
    if (path === '/content/api/v2/menus/1') {
      return { ok: true, status: 200, json: { name: 'Main Menu - 2025', label: 'Main', pageTreeNodeProperty: { children: [{ label: 'Home', url: '/' }] } } };
    }
    return { ok: false, status: 404, json: {} };
  };
  const writeFile = async (p, text) => writes.push({ p, text });
  const res = await pull(ACCT, { contentDir: '/c', hub, writeFile });
  assert.equal(res.pulled, 1);
  assert.match(writes[0].p, /\/c\/menus\/main-menu-2025\.json$/);
  const written = JSON.parse(writes[0].text);
  assert.deepEqual(written.tree, [{ label: 'Home', url: '/' }]);
});

test('push: honest capture-only no-op (never throws, reports git menu count)', async () => {
  const res = await push(ACCT, { contentDir: '/nonexistent' });
  assert.equal(res.pushed, 0);
  assert.match(res.notes.join(' '), /capture-only/);
});
