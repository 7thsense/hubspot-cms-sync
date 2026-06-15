// Unit tests for src/reconcile.mjs — the PURE classifier and the surface registry.
// No network: classifySurface is a pure function over {gitKeys, accountItems}.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifySurface, SURFACES, reconcile, formatReport, redirectPath } from '../../src/reconcile.mjs';

test('redirectPath: strips scheme+host so absolute and path redirects compare equal', () => {
  assert.equal(redirectPath('http://www.theseventhsense.com/team'), '/team');
  assert.equal(redirectPath('https://get.theseventhsense.com/demo'), '/demo');
  assert.equal(redirectPath('/team'), '/team', 'a bare path is unchanged');
  assert.equal(redirectPath('http://www.theseventhsense.com'), '/', 'host-only -> root');
});

test('url-redirects classify on path, not host: prod absolute URL matches git path', () => {
  const redir = SURFACES.find((s) => s.key === 'url-redirects');
  const git = new Set(['/team', '/pricing']);
  const account = [
    { routePrefix: 'http://www.theseventhsense.com/team', destination: '/x' }, // synced via path
    { routePrefix: 'http://get.theseventhsense.com/legacy', destination: '/y' }, // orphan
  ];
  const r = classifySurface(git, account, redir);
  assert.equal(r.counts.synced, 1, '/team matches across host');
  assert.deepEqual(r.orphans.map((o) => o.key), ['/legacy']);
  assert.deepEqual(r.missing, ['/pricing']);
});

const sitePages = SURFACES.find((s) => s.key === 'site-pages');

test('classifySurface: orphan = live on account but absent from git', () => {
  const git = new Set(['', 'about', 'contact']);
  const account = [
    { slug: '', currentState: 'PUBLISHED_OR_SCHEDULED' },
    { slug: 'about', currentState: 'PUBLISHED' },
    { slug: 'team', currentState: 'PUBLISHED_OR_SCHEDULED' }, // ORPHAN — live, not in git
    { slug: 'draft-thing', currentState: 'DRAFT' }, // non-live -> not an orphan
    { slug: 'loser', currentState: 'LOSER_AB_VARIANT' }, // AB junk -> ignored
  ];
  const r = classifySurface(git, account, sitePages);
  assert.deepEqual(r.orphans.map((o) => o.key), ['team'], 'only the live non-git page is an orphan');
  assert.deepEqual(r.missing, ['contact'], 'in git, not live on account -> missing');
  assert.equal(r.counts.synced, 2, 'home + about present on both');
  assert.equal(r.counts.account_nonlive, 2, 'draft + AB variant counted, not listed');
});

test('classifySurface: missing = in git but not on account; (home) empty slug handled', () => {
  const git = new Set(['', 'about', 'pricing']);
  const account = [{ slug: 'about', currentState: 'PUBLISHED' }];
  const r = classifySurface(git, account, sitePages);
  assert.deepEqual(r.missing.sort(), ['', 'pricing'], 'home ("") + pricing missing on account');
  assert.equal(r.counts.orphans, 0);
});

test('classifySurface: empty account inventory -> everything in git is missing, no orphans', () => {
  const git = new Set(['general-demo-request', 'try-it-free']);
  const r = classifySurface(git, [], SURFACES.find((s) => s.key === 'landing-pages'));
  assert.equal(r.counts.orphans, 0);
  assert.deepEqual(r.missing.sort(), ['general-demo-request', 'try-it-free']);
});

test('classifySurface: blog-posts liveness is state===PUBLISHED (scheduled/draft excluded)', () => {
  const posts = SURFACES.find((s) => s.key === 'blog-posts');
  const git = new Set(['blog/a']);
  const account = [
    { slug: 'blog/a', state: 'PUBLISHED' },
    { slug: 'blog/b', state: 'PUBLISHED' }, // orphan
    { slug: 'blog/c', state: 'SCHEDULED' }, // non-live
    { slug: 'blog/d', state: 'DRAFT' }, // non-live
  ];
  const r = classifySurface(git, account, posts);
  assert.deepEqual(r.orphans.map((o) => o.key), ['blog/b']);
  assert.equal(r.counts.account_nonlive, 2);
});

test('reconcile: orchestrates surfaces per account with injected IO, never writes', async () => {
  const config = { contentDirPath: '/nonexistent', redirectsFilePath: null };
  // Inject git readers + a fake account/getAll/hub so no fs or network is touched.
  const fakeAccount = async (name) => ({ name, portalId: name === 'prod' ? '529456' : '246389711', key: 'k' });
  const getAll = async (acct, path) => {
    if (path.includes('site-pages')) return [{ slug: 'team', currentState: 'PUBLISHED_OR_SCHEDULED' }];
    return [];
  };
  const hub = async () => ({ ok: true, json: { objects: [] } });

  // Patch buildGitIndex inputs by pointing loaders at empties via a wrapper: reconcile
  // calls buildGitIndex(config) which reads fs; here contentDir is nonexistent so the
  // loaders throw-and-empty. site-pages git set is therefore empty -> 'team' is an orphan.
  const report = await reconcile(['prod'], { config, accountFn: fakeAccount, getAll, hub });
  const sp = report.accounts[0].surfaces.find((s) => s.surface === 'site-pages');
  assert.equal(sp.counts.orphans, 1, 'team is an orphan against an empty git index');
  assert.equal(sp.orphans[0].key, 'team');
  // formatReport renders without throwing and names the orphan.
  assert.match(formatReport(report), /ORPHANS.*team/);
});
