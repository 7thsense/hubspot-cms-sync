// Unit tests for sync/adapters/assets.mjs — pure + mocked network, no real API.
//   node --test test/unit/adapter-assets.test.mjs
//
// Covers (per task): path <-> logical mapping, the OVERWRITE upload option
// (codex #4), and pull/push register the right registry.assets entries — with
// hub() and fetch fully mocked so PRODUCTION is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  name,
  dependsOn,
  assetTokenToPath,
  pathToAssetToken,
  assetRepoPath,
  blogAssetRepoPath,
  assetRepoCandidates,
  resolveAssetBytesPath,
  extractAssetPaths,
  collectReferencedAssetPaths,
  listAssetFiles,
  uploadOptions,
  uploadTarget,
  uploadAsset,
  loadRehosted,
  saveRehosted,
  pull,
  push,
} from '../../src/adapters/assets.mjs';
import { emptyRegistry } from '../../src/lib/refs.mjs';

const ACCT = { name: 'dev', portalId: '246389711', key: 'pat-test-key' };

function tmpContentDir() {
  const root = mkdtempSync(join(tmpdir(), 'assets-test-'));
  mkdirSync(join(root, 'pages'), { recursive: true });
  mkdirSync(join(root, 'blog', 'posts'), { recursive: true });
  return root;
}

// ── adapter contract ─────────────────────────────────────────────────────────

test('adapter exports the required interface', () => {
  assert.equal(name, 'assets');
  assert.deepEqual(dependsOn, []); // assets populate the registry, depend on nobody
  assert.equal(typeof pull, 'function');
  assert.equal(typeof push, 'function');
});

// ── path <-> logical mapping ─────────────────────────────────────────────────

test('assetTokenToPath / pathToAssetToken round-trip a simple path', () => {
  assert.equal(assetTokenToPath('@asset:Sucess.jpg'), 'Sucess.jpg');
  assert.equal(pathToAssetToken('Sucess.jpg'), '@asset:Sucess.jpg');
  const p = 'Sucess.jpg';
  assert.equal(assetTokenToPath(pathToAssetToken(p)), p);
});

test('assetTokenToPath preserves nested / encoded path tails verbatim', () => {
  const p = 'Stock%20images/Double%20exposure.jpeg';
  assert.equal(assetTokenToPath(`@asset:${p}`), p);
  // verbatim so the on-disk path == registry key == @asset token
  assert.equal(pathToAssetToken(p), '@asset:Stock%20images/Double%20exposure.jpeg');
});

test('assetTokenToPath returns null for non-asset tokens / junk', () => {
  assert.equal(assetTokenToPath('@form:home-lead'), null);
  assert.equal(assetTokenToPath('@portal'), null);
  assert.equal(assetTokenToPath(''), null);
  assert.equal(assetTokenToPath(null), null);
});

test('assetRepoPath places bytes under content/assets/<tail> verbatim', () => {
  assert.equal(assetRepoPath('/c', 'Sucess.jpg'), join('/c', 'assets', 'Sucess.jpg'));
  assert.equal(
    assetRepoPath('/c', 'Stock%20images/Double%20exposure.jpeg'),
    join('/c', 'assets', 'Stock%20images', 'Double%20exposure.jpeg'),
  );
});

// ── asset-scheme unification (codex #6): both trees count as committed bytes ──

test('assetRepoCandidates lists content/assets then content/blog/assets for a key', () => {
  assert.deepEqual(assetRepoCandidates('/c', 'Sucess.jpg'), [
    join('/c', 'assets', 'Sucess.jpg'),
    join('/c', 'blog', 'assets', 'Sucess.jpg'),
  ]);
  // a blog-manifest sha1-prefixed filename works the same way
  assert.deepEqual(blogAssetRepoPath('/c', '4e7bf9bad5-Inbox.png'), join('/c', 'blog', 'assets', '4e7bf9bad5-Inbox.png'));
});

test('resolveAssetBytesPath finds bytes in EITHER the assets or the blog tree', () => {
  const dir = tmpContentDir();
  try {
    // a hubfs-tail asset in the assets tree
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'assets', 'Sucess.jpg'), 'A');
    // a blog-manifest asset in the blog tree
    mkdirSync(join(dir, 'blog', 'assets'), { recursive: true });
    writeFileSync(join(dir, 'blog', 'assets', '4e7bf9bad5-Inbox.png'), 'B');

    assert.equal(resolveAssetBytesPath(dir, 'Sucess.jpg'), join(dir, 'assets', 'Sucess.jpg'));
    assert.equal(
      resolveAssetBytesPath(dir, '4e7bf9bad5-Inbox.png'),
      join(dir, 'blog', 'assets', '4e7bf9bad5-Inbox.png'),
    );
    // committed in neither tree -> null
    assert.equal(resolveAssetBytesPath(dir, 'Ghost.png'), null);
    // content/assets/ wins when a key (improbably) exists in BOTH trees
    writeFileSync(join(dir, 'blog', 'assets', 'Sucess.jpg'), 'dup');
    assert.equal(resolveAssetBytesPath(dir, 'Sucess.jpg'), join(dir, 'assets', 'Sucess.jpg'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveAssetBytesPath honors an injected existsFn (preflight fake-fs seam)', () => {
  const have = new Set([join('/c', 'blog', 'assets', 'M.png')]);
  const existsFn = (p) => have.has(p);
  assert.equal(resolveAssetBytesPath('/c', 'M.png', existsFn), join('/c', 'blog', 'assets', 'M.png'));
  assert.equal(resolveAssetBytesPath('/c', 'Absent.png', existsFn), null);
});

test('push uploads a blog-manifest @asset whose bytes live in content/blog/assets, and resolves it', async (t) => {
  // A blog post body references a manifest asset (@asset:<sha1>-<name>) whose bytes
  // are committed under content/blog/assets/, NOT content/assets/. The assets
  // adapter must find those bytes (unification), upload them, and register the
  // target URL so resolve() in blog/content/theme works — instead of hard-failing
  // "missing committed bytes".
  const dir = tmpContentDir();
  const key = '4e7bf9bad5-Inbox.png';
  mkdirSync(join(dir, 'blog', 'assets'), { recursive: true });
  writeFileSync(join(dir, 'blog', 'assets', key), 'BLOGPNGBYTES');
  writeFileSync(
    join(dir, 'blog', 'posts', 'p.json'),
    JSON.stringify({ postBody: `<img src="@asset:${key}">` }),
  );

  const realFetch = globalThis.fetch;
  let uploadedName = null;
  globalThis.fetch = async (url, init) => {
    uploadedName = init.body.get('fileName');
    return { ok: true, json: async () => ({ url: `https://tgt/synced-assets/${key}` }) };
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
    const f = join(process.cwd(), '.sync-state', `${ACCT.portalId}.rehosted.json`);
    if (existsSync(f)) rmSync(f, { force: true });
  });

  const registry = emptyRegistry(ACCT.portalId);
  const { pushed } = await push(ACCT, { contentDir: dir, registry });
  assert.equal(pushed, 1, 'the blog-tree asset must upload (not be rejected as missing)');
  assert.equal(uploadedName, key);
  // resolve() in blog/content/theme reads this target URL:
  assert.equal(registry.assets[key], `https://tgt/synced-assets/${key}`);
});

test('pull treats a blog-tree committed asset as already-committed (no re-download into content/assets)', async (t) => {
  const dir = tmpContentDir();
  const key = '4e7bf9bad5-Inbox.png';
  mkdirSync(join(dir, 'blog', 'assets'), { recursive: true });
  writeFileSync(join(dir, 'blog', 'assets', key), 'ALREADYINBLOG');
  writeFileSync(
    join(dir, 'blog', 'posts', 'p.json'),
    JSON.stringify({ postBody: `<img src="@asset:${key}">` }),
  );
  saveRehosted(ACCT.portalId, { [key]: `https://src/hubfs/529456/${key}` });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('pull must not download an asset already committed in the blog tree');
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
    const f = join(process.cwd(), '.sync-state', `${ACCT.portalId}.rehosted.json`);
    if (existsSync(f)) rmSync(f, { force: true });
  });

  const registry = emptyRegistry(ACCT.portalId);
  const { pulled } = await pull(ACCT, { contentDir: dir, registry });
  assert.equal(pulled, 0, 'blog-tree bytes count as committed — nothing downloaded');
  // and crucially it did NOT duplicate the bytes into content/assets/
  assert.equal(existsSync(join(dir, 'assets', key)), false);
  assert.equal(registry.assets[key], `https://src/hubfs/529456/${key}`);
});

test('extractAssetPaths finds unique @asset tails, ignoring other tokens', () => {
  const s =
    'src="@asset:Sucess.jpg" then @asset:Stock%20images/x.png again @asset:Sucess.jpg ' +
    'plus @cta:request-demo and @portal and @form:home-lead';
  const got = extractAssetPaths(s).sort();
  assert.deepEqual(got, ['Stock%20images/x.png', 'Sucess.jpg']);
});

test('extractAssetPaths handles non-strings', () => {
  assert.deepEqual(extractAssetPaths(null), []);
  assert.deepEqual(extractAssetPaths(123), []);
  assert.deepEqual(extractAssetPaths(''), []);
});

// ── scanning the canonical tree ──────────────────────────────────────────────

test('collectReferencedAssetPaths scans pages + blog json', () => {
  const dir = tmpContentDir();
  try {
    writeFileSync(
      join(dir, 'pages', 'home.json'),
      JSON.stringify({ widgets: { hero: { body: { img: '@asset:Hero.png' } } } }),
    );
    writeFileSync(
      join(dir, 'blog', 'posts', 'p.json'),
      JSON.stringify({ postBody: '<img src="@asset:blog/Inbox.png">' }),
    );
    const got = collectReferencedAssetPaths(dir).sort();
    assert.deepEqual(got, ['Hero.png', 'blog/Inbox.png']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listAssetFiles returns tails with / separators, skipping manifest.json', () => {
  const dir = tmpContentDir();
  try {
    const a = join(dir, 'assets');
    mkdirSync(join(a, 'sub'), { recursive: true });
    writeFileSync(join(a, 'Sucess.jpg'), 'x');
    writeFileSync(join(a, 'sub', 'Deep.png'), 'y');
    writeFileSync(join(a, 'manifest.json'), '{}');
    const got = listAssetFiles(a).sort();
    assert.deepEqual(got, ['Sucess.jpg', 'sub/Deep.png']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── upload OVERWRITE option (codex #4) ───────────────────────────────────────

test('uploadOptions sets overwrite:true (codex #4 — no duplicates)', () => {
  const o = uploadOptions();
  assert.equal(o.overwrite, true, 'overwrite MUST be true so push is idempotent');
  assert.equal(o.access, 'PUBLIC_INDEXABLE');
});

test('uploadTarget splits a nested tail into folderPath + fileName', () => {
  assert.deepEqual(uploadTarget('Sucess.jpg'), {
    fileName: 'Sucess.jpg',
    folderPath: '/synced-assets',
  });
  // The %20-encoded segment is DECODED for File Manager (it rejects '%' in
  // folder/file names); the @asset token key stays encoded.
  assert.deepEqual(uploadTarget('Stock%20images/Double.jpeg'), {
    fileName: 'Double.jpeg',
    folderPath: '/synced-assets/Stock images',
  });
});

test('uploadAsset posts options with overwrite:true and returns hosted url', async () => {
  let capturedOptions = null;
  let capturedUrl = null;
  const fakeFetch = async (url, init) => {
    capturedUrl = url;
    // FormData is in the body; pull the options field back out.
    capturedOptions = JSON.parse(init.body.get('options'));
    assert.equal(init.headers.Authorization, `Bearer ${ACCT.key}`);
    return { ok: true, json: async () => ({ url: 'https://host/synced-assets/Sucess.jpg' }) };
  };
  const out = await uploadAsset(ACCT, Buffer.from('bytes'), 'Sucess.jpg', fakeFetch);
  assert.equal(out, 'https://host/synced-assets/Sucess.jpg');
  assert.ok(capturedUrl.endsWith('/files/v3/files'));
  assert.equal(capturedOptions.overwrite, true);
});

test('uploadAsset throws on a non-ok response', async () => {
  const fakeFetch = async () => ({ ok: false, status: 413, json: async () => ({ message: 'too big' }) });
  await assert.rejects(
    () => uploadAsset(ACCT, Buffer.from('x'), 'Big.jpg', fakeFetch),
    /413: too big/,
  );
});

// ── rehosted state cache (gitignored) ────────────────────────────────────────

test('saveRehosted / loadRehosted round-trip per portal', () => {
  const portal = `test-${Date.now()}`;
  try {
    saveRehosted(portal, { 'Sucess.jpg': 'https://host/Sucess.jpg' });
    assert.deepEqual(loadRehosted(portal), { 'Sucess.jpg': 'https://host/Sucess.jpg' });
  } finally {
    const f = join(process.cwd(), '.sync-state', `${portal}.rehosted.json`);
    if (existsSync(f)) rmSync(f, { force: true });
  }
});

test('saveRehosted writes ATOMICALLY (tmp + rename) — no leftover .tmp file', () => {
  const portal = `test-atomic-${process.pid}-${Date.now()}`;
  const f = join(process.cwd(), '.sync-state', `${portal}.rehosted.json`);
  const tmp = `${f}.tmp-${process.pid}`;
  try {
    saveRehosted(portal, { 'A.png': 'https://host/A.png' });
    // The final file exists with the content...
    assert.deepEqual(loadRehosted(portal), { 'A.png': 'https://host/A.png' });
    // ...and the per-pid temp file was renamed away, never left behind. A
    // lingering tmp (a non-atomic write) is the failure mode this guards.
    assert.equal(existsSync(tmp), false, 'temp file must be renamed into place, not left behind');
  } finally {
    if (existsSync(f)) rmSync(f, { force: true });
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }
});

// ── push IDEMPOTENCY: a re-push REUSES (uploaded 0 | reused N), never re-uploads ──

// A single per-portal rehosted cache is shared across tests (it lives in the repo
// .sync-state). Use a unique portal per test and clean it up.
function freshAcct() {
  return { name: 'dev', portalId: `idem-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, key: 'pat-test-key' };
}
function rehostedFileFor(portalId) {
  return join(process.cwd(), '.sync-state', `${portalId}.rehosted.json`);
}

test('SECOND identical push REUSES the rehosted cache (uploaded 0 | reused N) — idempotent, no re-upload', async (t) => {
  const dir = tmpContentDir();
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'A.png'), 'AAA');
  writeFileSync(join(dir, 'assets', 'B.png'), 'BBB');
  writeFileSync(
    join(dir, 'pages', 'home.json'),
    JSON.stringify({ a: '@asset:A.png', b: '@asset:B.png' }),
  );
  const acct = freshAcct();

  let uploadCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    uploadCalls++;
    const fileName = init.body.get('fileName');
    return { ok: true, json: async () => ({ url: `https://tgt/synced-assets/${fileName}` }) };
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
    const f = rehostedFileFor(acct.portalId);
    if (existsSync(f)) rmSync(f, { force: true });
  });

  // The orchestrator persists ONE registry across the run; emulate a re-run by
  // reusing the SAME registry object (it is durable on disk between real pushes).
  const registry = emptyRegistry(acct.portalId);

  const r1 = await push(acct, { contentDir: dir, registry });
  assert.equal(r1.pushed, 2, 'first push uploads both assets');
  assert.equal(uploadCalls, 2);
  assert.match(r1.notes[0], /uploaded 2 \| reused 0/);

  // SECOND push (same defs, same account): everything must be REUSED, nothing
  // re-uploaded. This is the idempotency contract — a re-run produces no churn.
  const before = uploadCalls;
  const r2 = await push(acct, { contentDir: dir, registry });
  assert.equal(r2.pushed, 0, 'second push uploads nothing');
  assert.equal(uploadCalls, before, 'no new upload calls on the second push');
  assert.match(r2.notes[0], /uploaded 0 \| reused 2/);
  // registry still resolves both to their hosted URLs
  assert.equal(registry.assets['A.png'], 'https://tgt/synced-assets/A.png');
  assert.equal(registry.assets['B.png'], 'https://tgt/synced-assets/B.png');
});

test('reuse SURVIVES a lost/truncated rehosted cache via the durable registry backstop', async (t) => {
  const dir = tmpContentDir();
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'A.png'), 'AAA');
  writeFileSync(join(dir, 'pages', 'home.json'), JSON.stringify({ a: '@asset:A.png' }));
  const acct = freshAcct();

  let uploadCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    uploadCalls++;
    const fileName = init.body.get('fileName');
    return { ok: true, json: async () => ({ url: `https://tgt/synced-assets/${fileName}` }) };
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
    const f = rehostedFileFor(acct.portalId);
    if (existsSync(f)) rmSync(f, { force: true });
  });

  const registry = emptyRegistry(acct.portalId);
  await push(acct, { contentDir: dir, registry });
  assert.equal(uploadCalls, 1);

  // Simulate the real-world failure: the gitignored rehosted cache is lost or
  // truncated to `{}` between pushes (a crash mid-write, a clobber, a clean
  // checkout). The durable registry (persisted atomically by the orchestrator)
  // still carries the hosted URL, so the next push must REUSE — not re-upload.
  saveRehosted(acct.portalId, {}); // wipe the cache
  const before = uploadCalls;
  const r2 = await push(acct, { contentDir: dir, registry });
  assert.equal(r2.pushed, 0);
  assert.equal(uploadCalls, before, 'registry backstop prevents a re-upload despite a wiped cache');
  assert.match(r2.notes[0], /uploaded 0 \| reused 1/);
  // and it RE-SEEDS the cache from the registry so the file is healthy again
  assert.equal(loadRehosted(acct.portalId)['A.png'], 'https://tgt/synced-assets/A.png');
});

test('$ASSET_FORCE forces a re-upload even when the asset is cached', async (t) => {
  const dir = tmpContentDir();
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'A.png'), 'AAA');
  writeFileSync(join(dir, 'pages', 'home.json'), JSON.stringify({ a: '@asset:A.png' }));
  const acct = freshAcct();

  let uploadCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    uploadCalls++;
    const fileName = init.body.get('fileName');
    return { ok: true, json: async () => ({ url: `https://tgt/synced-assets/${fileName}` }) };
  };
  const prevForce = process.env.ASSET_FORCE;
  t.after(() => {
    globalThis.fetch = realFetch;
    if (prevForce === undefined) delete process.env.ASSET_FORCE;
    else process.env.ASSET_FORCE = prevForce;
    rmSync(dir, { recursive: true, force: true });
    const f = rehostedFileFor(acct.portalId);
    if (existsSync(f)) rmSync(f, { force: true });
  });

  const registry = emptyRegistry(acct.portalId);
  await push(acct, { contentDir: dir, registry }); // seed cache
  assert.equal(uploadCalls, 1);

  process.env.ASSET_FORCE = '1';
  const before = uploadCalls;
  const r2 = await push(acct, { contentDir: dir, registry });
  assert.equal(uploadCalls, before + 1, 'ASSET_FORCE re-uploads despite the cache');
  assert.equal(r2.pushed, 1);
  assert.match(r2.notes[0], /uploaded 1 \| reused 0/);
});

// ── push: registers @asset -> target hosted URL, never touches prod ──────────

test('push uploads committed bytes and records @asset -> target url in registry', async (t) => {
  const dir = tmpContentDir();
  // commit one asset's bytes + reference it from a page
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'Sucess.jpg'), 'JPEGBYTES');
  writeFileSync(
    join(dir, 'pages', 'home.json'),
    JSON.stringify({ widgets: { hero: { body: { img: '@asset:Sucess.jpg' } } } }),
  );

  // mock the global fetch the upload uses
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, options: JSON.parse(init.body.get('options')) });
    return { ok: true, json: async () => ({ url: 'https://tgt/synced-assets/Sucess.jpg' }) };
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
    const f = join(process.cwd(), '.sync-state', `${ACCT.portalId}.rehosted.json`);
    if (existsSync(f)) rmSync(f, { force: true });
  });

  const registry = emptyRegistry(ACCT.portalId);
  const { pushed } = await push(ACCT, { contentDir: dir, registry });

  assert.equal(pushed, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.overwrite, true, 'push must upload with overwrite');
  // content/blog/theme resolve() reads this:
  assert.equal(registry.assets['Sucess.jpg'], 'https://tgt/synced-assets/Sucess.jpg');
});

test('push HARD-FAILS (throws) on a referenced-but-uncommitted asset — no silent skip', async (t) => {
  const dir = tmpContentDir();
  writeFileSync(
    join(dir, 'pages', 'home.json'),
    JSON.stringify({ body: 'src="@asset:Ghost.png"' }),
  );
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('should not upload missing bytes');
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
    const f = join(process.cwd(), '.sync-state', `${ACCT.portalId}.rehosted.json`);
    if (existsSync(f)) rmSync(f, { force: true });
  });

  const registry = emptyRegistry(ACCT.portalId);
  // DATA-LOSS GUARD: a referenced @asset with no committed bytes must abort the
  // whole push (orchestrator contract) and NAME the offender — never return ok.
  await assert.rejects(
    () => push(ACCT, { contentDir: dir, registry }),
    /referenced @asset\(s\) missing committed bytes.*@asset:Ghost\.png/s,
  );
  // and it must NOT have registered any (stale/empty) url for the ghost
  assert.equal(registry.assets['Ghost.png'], undefined);
});

test('push abort names EVERY missing referenced asset, not just the first', async (t) => {
  const dir = tmpContentDir();
  writeFileSync(
    join(dir, 'pages', 'home.json'),
    JSON.stringify({ a: '@asset:Ghost.png', b: '@asset:Phantom.jpg' }),
  );
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('should not upload missing bytes');
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
    const f = join(process.cwd(), '.sync-state', `${ACCT.portalId}.rehosted.json`);
    if (existsSync(f)) rmSync(f, { force: true });
  });

  const registry = emptyRegistry(ACCT.portalId);
  await assert.rejects(
    () => push(ACCT, { contentDir: dir, registry }),
    (e) =>
      /Ghost\.png/.test(e.message) &&
      /Phantom\.jpg/.test(e.message) &&
      /\b2\b/.test(e.message),
  );
});

test('push uploads good assets but STILL aborts if any referenced one is missing bytes', async (t) => {
  const dir = tmpContentDir();
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'Good.jpg'), 'BYTES');
  writeFileSync(
    join(dir, 'pages', 'home.json'),
    JSON.stringify({ a: '@asset:Good.jpg', b: '@asset:Ghost.png' }),
  );
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ url: 'https://tgt/Good.jpg' }) });
  t.after(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
    const f = join(process.cwd(), '.sync-state', `${ACCT.portalId}.rehosted.json`);
    if (existsSync(f)) rmSync(f, { force: true });
  });

  const registry = emptyRegistry(ACCT.portalId);
  await assert.rejects(
    () => push(ACCT, { contentDir: dir, registry }),
    /missing committed bytes.*@asset:Ghost\.png/s,
  );
  // the good asset that DID upload before the abort is persisted to the state
  // cache so a re-run (after committing Ghost.png) reuses it — idempotency.
  assert.equal(loadRehosted(ACCT.portalId)['Good.jpg'], 'https://tgt/Good.jpg');
});

test('push aborts when an upload itself FAILS (network/API) — no silent data drop', async (t) => {
  const dir = tmpContentDir();
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'Boom.jpg'), 'BYTES');
  writeFileSync(
    join(dir, 'pages', 'home.json'),
    JSON.stringify({ a: '@asset:Boom.jpg' }),
  );
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ message: 'kaboom' }) });
  t.after(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
    const f = join(process.cwd(), '.sync-state', `${ACCT.portalId}.rehosted.json`);
    if (existsSync(f)) rmSync(f, { force: true });
  });

  const registry = emptyRegistry(ACCT.portalId);
  await assert.rejects(
    () => push(ACCT, { contentDir: dir, registry }),
    /upload\(s\) failed/,
  );
  // the failed asset must NOT have a url registered for a consumer to resolve
  assert.equal(registry.assets['Boom.jpg'], undefined);
});

test('push round-trips a NESTED / %20-encoded tail to the right upload target', async (t) => {
  const dir = tmpContentDir();
  const tail = 'Stock%20images/Double%20exposure.jpeg';
  mkdirSync(join(dir, 'assets', 'Stock%20images'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'Stock%20images', 'Double%20exposure.jpeg'), 'NESTEDBYTES');
  writeFileSync(
    join(dir, 'pages', 'home.json'),
    JSON.stringify({ img: `@asset:${tail}` }),
  );

  let sentFolderPath = null;
  let sentFileName = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sentFolderPath = init.body.get('folderPath');
    sentFileName = init.body.get('fileName');
    return { ok: true, json: async () => ({ url: 'https://tgt/synced-assets/Stock%20images/Double%20exposure.jpeg' }) };
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
    const f = join(process.cwd(), '.sync-state', `${ACCT.portalId}.rehosted.json`);
    if (existsSync(f)) rmSync(f, { force: true });
  });

  const registry = emptyRegistry(ACCT.portalId);
  const { pushed } = await push(ACCT, { contentDir: dir, registry });
  assert.equal(pushed, 1);
  // nested tail uploads to a DECODED sub-folder + filename (File Manager rejects
  // '%'); the @asset token/registry key stays encoded so resolve() still matches.
  assert.equal(sentFolderPath, '/synced-assets/Stock images');
  assert.equal(sentFileName, 'Double exposure.jpeg');
  // registry key is the verbatim @asset tail (== on-disk path == token)
  assert.equal(
    registry.assets['Stock%20images/Double%20exposure.jpeg'],
    'https://tgt/synced-assets/Stock%20images/Double%20exposure.jpeg',
  );
});

// ── pull: reuses committed bytes, registers source url (no download) ─────────

test('pull reuses committed bytes and registers the source url', async (t) => {
  const dir = tmpContentDir();
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'Sucess.jpg'), 'ALREADYHERE');
  writeFileSync(
    join(dir, 'pages', 'home.json'),
    JSON.stringify({ body: 'src="@asset:Sucess.jpg"' }),
  );
  // seed the per-account rehosted cache so no network is needed
  saveRehosted(ACCT.portalId, { 'Sucess.jpg': 'https://src/hubfs/529456/Sucess.jpg' });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('pull should not download when bytes already committed');
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
    const f = join(process.cwd(), '.sync-state', `${ACCT.portalId}.rehosted.json`);
    if (existsSync(f)) rmSync(f, { force: true });
  });

  const registry = emptyRegistry(ACCT.portalId);
  const { pulled } = await pull(ACCT, { contentDir: dir, registry });
  assert.equal(pulled, 0, 'nothing downloaded — bytes already on disk');
  assert.equal(registry.assets['Sucess.jpg'], 'https://src/hubfs/529456/Sucess.jpg');
  // bytes untouched
  assert.equal(readFileSync(join(dir, 'assets', 'Sucess.jpg'), 'utf8'), 'ALREADYHERE');
});

test('pull downloads missing bytes via mocked fetch and writes them', async (t) => {
  const dir = tmpContentDir();
  writeFileSync(
    join(dir, 'pages', 'home.json'),
    JSON.stringify({ body: 'src="@asset:New.png"' }),
  );
  saveRehosted(ACCT.portalId, { 'New.png': 'https://src/hubfs/529456/New.png' });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.ok(String(url).includes('New.png'));
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode('DOWNLOADED').buffer };
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
    const f = join(process.cwd(), '.sync-state', `${ACCT.portalId}.rehosted.json`);
    if (existsSync(f)) rmSync(f, { force: true });
  });

  const registry = emptyRegistry(ACCT.portalId);
  const { pulled } = await pull(ACCT, { contentDir: dir, registry });
  assert.equal(pulled, 1);
  assert.equal(readFileSync(join(dir, 'assets', 'New.png'), 'utf8'), 'DOWNLOADED');
  assert.equal(registry.assets['New.png'], 'https://src/hubfs/529456/New.png');
});

test('pull surfaces a download FAILURE as a note and does NOT drop / fake the ref', async (t) => {
  const dir = tmpContentDir();
  writeFileSync(
    join(dir, 'pages', 'home.json'),
    JSON.stringify({ body: 'src="@asset:Dead.png"' }),
  );
  // every network path fails: File Manager search (hub) AND the byte download.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
  t.after(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
    const f = join(process.cwd(), '.sync-state', `${ACCT.portalId}.rehosted.json`);
    if (existsSync(f)) rmSync(f, { force: true });
  });

  const registry = emptyRegistry(ACCT.portalId);
  const { pulled, notes } = await pull(ACCT, { contentDir: dir, registry });
  // nothing downloaded, and crucially the ref is SURFACED, not silently dropped
  assert.equal(pulled, 0);
  assert.ok(
    notes.some((n) => /download failed: @asset:Dead\.png/.test(n)),
    'a failed download must be reported as a note',
  );
  // DATA-LOSS GUARD: no bytes on disk for the failed asset...
  assert.equal(existsSync(join(dir, 'assets', 'Dead.png')), false);
  // ...and NO fabricated/stale url registered for a downstream resolve() to use.
  assert.equal(registry.assets['Dead.png'], undefined);
  assert.equal(loadRehosted(ACCT.portalId)['Dead.png'], undefined);
});

test('pull keeps GOOD downloads while surfacing a failed sibling — partial, not all-or-nothing', async (t) => {
  const dir = tmpContentDir();
  writeFileSync(
    join(dir, 'pages', 'home.json'),
    JSON.stringify({ a: '@asset:Ok.png', b: '@asset:Bad.png' }),
  );
  saveRehosted(ACCT.portalId, {
    'Ok.png': 'https://src/hubfs/529456/Ok.png',
    'Bad.png': 'https://src/hubfs/529456/Bad.png',
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('Ok.png')) {
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode('OKBYTES').buffer };
    }
    return { ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
    const f = join(process.cwd(), '.sync-state', `${ACCT.portalId}.rehosted.json`);
    if (existsSync(f)) rmSync(f, { force: true });
  });

  const registry = emptyRegistry(ACCT.portalId);
  const { pulled, notes } = await pull(ACCT, { contentDir: dir, registry });
  assert.equal(pulled, 1);
  assert.equal(readFileSync(join(dir, 'assets', 'Ok.png'), 'utf8'), 'OKBYTES');
  assert.equal(registry.assets['Ok.png'], 'https://src/hubfs/529456/Ok.png');
  assert.ok(notes.some((n) => /download failed: @asset:Bad\.png/.test(n)));
  assert.equal(registry.assets['Bad.png'], undefined);
});
