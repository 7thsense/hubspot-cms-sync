// Unit tests for sync/lib/orchestrate.mjs (topoSort + loadAdapters) and the
// sync/push.mjs production read-only HARD GUARD. No network.
//
//   - topoSort: correct dependency order (producers before consumers), deterministic
//     alphabetical tie-break, cycle detection, unknown-dependency detection.
//   - loadAdapters: imports fake adapter .mjs modules from a temp dir and keys them by
//     name (de-couples the test from the real adapters).
//   - push guard: refuses to run against portal 529456 regardless of the --publish flag,
//     and runs the topo order otherwise (with fake adapters injected via a temp dir).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// (tmpdir is still used by withKeyDir for the prod-guard test below.)

// Fake adapter modules are dynamically imported by loadAdapters, so they must live on
// the SAME filesystem mount as the source tree (the OS tmpdir can be a different mount
// where ESM resolution fails). Put them under the repo's test tree.
const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_BASE = join(__dirname, '..', '..', '.tmp-test');

import { topoSort, loadAdapters } from '../../src/lib/orchestrate.mjs';
import { push, preflightRefs, READ_ONLY_PORTAL } from '../../src/push.mjs';
import { pull } from '../../src/pull.mjs';
import { contentDir as realContentDir } from '../../src/lib/sync-state.mjs';

// ---------------------------------------------------------------------------
// Orchestrator (pull/push) test harness — drives the REAL pull()/push() with
// fake hub/loadAdapters/registry deps injected through their `deps` test seam.
// No network, no real .sync-state writes.
//
// `makeOrchestratorEnv` builds a set of fake adapters whose pull()/push() record
// the order in which they ran and mutate the shared in-memory registry, plus a
// `persist` spy that snapshots the registry at each call (so a test can prove the
// registry was persisted AFTER each adapter, with a producer's entries already in
// the snapshot). An adapter name listed in `failOn` throws when it runs, simulating
// a mid-pipeline failure (e.g. a resolve() hard-fail on push).
// ---------------------------------------------------------------------------
function makeOrchestratorEnv({ graph, failOn = [] } = {}) {
  // Default graph mirrors the real adapter dependency shape.
  graph = graph ?? {
    forms: [],
    assets: [],
    blog: ['assets'],
    theme: ['forms'],
    content: ['forms', 'assets'],
    pages: ['forms', 'assets'],
  };

  const ran = []; // names in the order their pull()/push() actually executed
  const persistSnapshots = []; // deep snapshots of the registry at each persist call

  const registry = { portalId: null, map: {} };

  const adapters = {};
  for (const [name, dependsOn] of Object.entries(graph)) {
    const makeImpl = (phase) => async (acct, ctx) => {
      // Mutate the shared registry so we can prove producer entries persist.
      ctx.registry.map[`${name}:ran`] = phase;
      ran.push(name);
      if (failOn.includes(name)) {
        throw new Error(`boom: adapter "${name}" failed mid-pipeline`);
      }
      return { pulled: 1, pushed: 1, written: 1 };
    };
    adapters[name] = {
      name,
      dependsOn,
      pull: makeImpl('pull'),
      push: makeImpl('push'),
    };
  }

  const deps = {
    account: (n) => ({ name: n, portalId: n === 'prod' ? '529456' : '246389711' }),
    loadAdapters: async () => adapters,
    loadAccountRegistry: (portalId) => {
      registry.portalId = String(portalId);
      return registry;
    },
    persistAccountRegistry: (_portalId, reg) => {
      // Snapshot the registry STATE at the moment of persistence (deep clone of map).
      persistSnapshots.push(JSON.parse(JSON.stringify(reg.map)));
    },
  };

  return { adapters, deps, ran, persistSnapshots, registry };
}

// ---------- topoSort: correct order ----------

test('topoSort orders producers before consumers (forms/assets before consumers)', () => {
  // Mirrors the real graph: forms & assets are roots; theme->forms; blog->assets;
  // content & pages -> forms,assets.
  const adapters = {
    forms: { dependsOn: [] },
    assets: { dependsOn: [] },
    blog: { dependsOn: ['assets'] },
    theme: { dependsOn: ['forms'] },
    content: { dependsOn: ['forms', 'assets'] },
    pages: { dependsOn: ['forms', 'assets'] },
  };
  const order = topoSort(adapters);

  // Every dependency must precede the dependent.
  const idx = (n) => order.indexOf(n);
  for (const [name, def] of Object.entries(adapters)) {
    for (const dep of def.dependsOn) {
      assert.ok(idx(dep) < idx(name), `${dep} should come before ${name} (got ${order.join(',')})`);
    }
  }
  // Fully deterministic Kahn order (alphabetical among ready nodes at each step):
  // assets (root) -> blog (its only dep assets now done, sorts before forms) -> forms
  // (root) -> content -> pages -> theme.
  assert.deepEqual(order, ['assets', 'blog', 'forms', 'content', 'pages', 'theme']);
  // Both roots precede their consumers regardless.
  assert.ok(idx('assets') < idx('content') && idx('forms') < idx('content'));
  // All six present, no dupes.
  assert.equal(order.length, 6);
  assert.equal(new Set(order).size, 6);
});

test('topoSort is deterministic (alphabetical tie-break) for independent nodes', () => {
  const adapters = { c: { dependsOn: [] }, a: { dependsOn: [] }, b: { dependsOn: [] } };
  assert.deepEqual(topoSort(adapters), ['a', 'b', 'c']);
  // Order of insertion must not matter.
  const adapters2 = { a: { dependsOn: [] }, b: { dependsOn: [] }, c: { dependsOn: [] } };
  assert.deepEqual(topoSort(adapters2), ['a', 'b', 'c']);
});

test('topoSort handles a deep chain', () => {
  const adapters = {
    d: { dependsOn: ['c'] },
    c: { dependsOn: ['b'] },
    b: { dependsOn: ['a'] },
    a: { dependsOn: [] },
  };
  assert.deepEqual(topoSort(adapters), ['a', 'b', 'c', 'd']);
});

test('topoSort treats missing dependsOn as no dependencies', () => {
  const adapters = { a: {}, b: { dependsOn: ['a'] } };
  assert.deepEqual(topoSort(adapters), ['a', 'b']);
});

// ---------- topoSort: cycle detection ----------

test('topoSort throws on a direct cycle', () => {
  const adapters = { a: { dependsOn: ['b'] }, b: { dependsOn: ['a'] } };
  assert.throws(() => topoSort(adapters), /cycle detected/i);
});

test('topoSort throws on a self-cycle', () => {
  const adapters = { a: { dependsOn: ['a'] } };
  assert.throws(() => topoSort(adapters), /cycle detected/i);
});

test('topoSort throws on an indirect cycle and names the chain', () => {
  const adapters = {
    a: { dependsOn: ['b'] },
    b: { dependsOn: ['c'] },
    c: { dependsOn: ['a'] },
  };
  assert.throws(() => topoSort(adapters), /cycle detected.*->/i);
});

// ---------- topoSort: unknown dependency ----------

test('topoSort throws on an unknown dependency, naming the missing dep', () => {
  const adapters = { a: { dependsOn: ['ghost'] } };
  assert.throws(() => topoSort(adapters), /unknown adapter "ghost"/);
});

// ---------- loadAdapters with fake adapter modules ----------

async function withFakeAdapters(modules, fn) {
  mkdirSync(FAKE_BASE, { recursive: true });
  const dir = mkdtempSync(join(FAKE_BASE, 'fake-adapters-'));
  try {
    for (const [file, src] of Object.entries(modules)) {
      writeFileSync(join(dir, file), src);
    }
    return await fn(dir); // AWAIT before the finally tears the temp dir down
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadAdapters imports *.mjs and keys modules by exported name', async () => {
  await withFakeAdapters(
    {
      'one.mjs': `export const name='one'; export const dependsOn=[]; export async function pull(){return {pulled:1}}; export async function push(){return {pushed:1}};`,
      'two.mjs': `export default { name:'two', dependsOn:['one'], async pull(){return {pulled:2}}, async push(){return {pushed:2}} };`,
      'notes.txt': `ignored`,
    },
    async (dir) => {
      const adapters = await loadAdapters(dir);
      assert.deepEqual(Object.keys(adapters).sort(), ['one', 'two']);
      assert.deepEqual(adapters.two.dependsOn, ['one']);
      assert.equal(typeof adapters.one.pull, 'function');
      assert.equal(typeof adapters.two.push, 'function');
      // topoSort over the loaded graph orders the dependency first.
      assert.deepEqual(topoSort(adapters), ['one', 'two']);
    },
  );
});

test('loadAdapters throws on a duplicate adapter name', async () => {
  await withFakeAdapters(
    {
      'a.mjs': `export const name='dup'; export const dependsOn=[];`,
      'b.mjs': `export const name='dup'; export const dependsOn=[];`,
    },
    async (dir) => {
      await assert.rejects(() => loadAdapters(dir), /Duplicate adapter name "dup"/);
    },
  );
});

test('real adapter graph orders email-templates before emails', async () => {
  const adapters = await loadAdapters();
  const order = topoSort(adapters);
  assert.ok(
    order.indexOf('email-templates') < order.indexOf('emails'),
    `email-templates must precede emails (got: ${order.join(' -> ')})`,
  );
  assert.deepEqual(adapters.emails.dependsOn, ['assets', 'email-templates']);
});

test('loadAdapters throws when a module has no name', async () => {
  await withFakeAdapters(
    { 'nameless.mjs': `export const dependsOn=[];` },
    async (dir) => {
      await assert.rejects(() => loadAdapters(dir), /does not export a `name`/);
    },
  );
});

// ---------- push production read-only HARD GUARD ----------
//
// push() resolves the account via hub.account(), which reads a key from
// $HUBSPOT_KEY_DIR/<portalId>.key. We point that at a temp dir holding keys for the
// real prod (529456) and dev (246389711) portals from sync/accounts.json. The guard
// must fire for prod BEFORE any adapter loads — even with --publish.

async function withKeyDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hubkeys-'));
  const prev = process.env.HUBSPOT_KEY_DIR;
  process.env.HUBSPOT_KEY_DIR = dir;
  try {
    writeFileSync(join(dir, '529456.key'), 'pat-naX-prod\n');
    writeFileSync(join(dir, '246389711.key'), 'pat-naX-dev\n');
    // MUST await: push() reads the key inside an async body, so tearing the temp dir
    // down before fn() resolves would make account() fall back to the real ~/.hubspot
    // (passes locally where a prod key exists, fails in CI where it doesn't).
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.HUBSPOT_KEY_DIR;
    else process.env.HUBSPOT_KEY_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('READ_ONLY_PORTAL is the production portal id', () => {
  assert.equal(READ_ONLY_PORTAL, '529456');
});

test('push HARD-GUARDS against the production portal (529456), even with --publish', async () => {
  await withKeyDir(async (dir) => {
    const config = {
      accountsPath: join(__dirname, '..', 'fixtures', 'config', 'accounts.json'),
      keyDir: dir,
      readOnlyPortalIds: [READ_ONLY_PORTAL],
    };
    await assert.rejects(() => push('prod', { config }), /portal is read-only.*529456/s);
    await assert.rejects(() => push('prod', { publish: true, config }), /portal is read-only.*529456/s);
  });
});

test('push does NOT guard a non-prod account (proceeds past the guard)', async () => {
  await withKeyDir(async (dir) => {
    const config = {
      accountsPath: join(__dirname, '..', 'fixtures', 'config', 'accounts.json'),
      keyDir: dir,
      readOnlyPortalIds: [READ_ONLY_PORTAL],
    };
    // We do not want to exercise the real adapters/network here; we only need to prove
    // the guard does not fire for dev. The real adapters will attempt network I/O and
    // fail — but with a NON-guard error. So assert the rejection is NOT the guard.
    await assert.rejects(
      () => push('dev', { config }),
      (e) => {
        assert.doesNotMatch(e.message, /portal is read-only/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// PULL-vs-PUSH ORDERING — the headline regression guard.
//
// push() must run adapters in forward topo order (producers forms/assets FIRST so
// their registry entries exist before consumers resolve). pull() must run the EXACT
// REVERSE (consumers tokenize @asset/refs FIRST so the asset COLLECTOR runs LAST and
// actually finds bytes to download). If these ever drift back together, pull silently
// downloads zero assets (data loss). These tests assert the relationship directly.
// ---------------------------------------------------------------------------

test('push runs adapters in forward topo order (producers before consumers)', async () => {
  const { deps, ran } = makeOrchestratorEnv();
  const res = await push('dev', {}, deps);
  // The orchestrator's reported order matches what actually ran.
  assert.deepEqual(res.order, ran);
  // Forward topo order: every dependency precedes its dependent.
  const idx = (n) => ran.indexOf(n);
  assert.ok(idx('assets') < idx('blog'));
  assert.ok(idx('forms') < idx('theme'));
  assert.ok(idx('forms') < idx('content') && idx('assets') < idx('content'));
  // Matches the pure topoSort result exactly.
  assert.deepEqual(ran, topoSort({
    forms: { dependsOn: [] }, assets: { dependsOn: [] },
    blog: { dependsOn: ['assets'] }, theme: { dependsOn: ['forms'] },
    content: { dependsOn: ['forms', 'assets'] }, pages: { dependsOn: ['forms', 'assets'] },
  }));
});

test('push and pull each run EVERY loaded adapter exactly once (no adapter skipped)', async () => {
  // Completeness guard: the orchestrator must run ALL adapters, not a subset. If a
  // future graph change orphaned an adapter (e.g. an unreachable node), the run count
  // would drop below the loaded count and this fails.
  const pushEnv = makeOrchestratorEnv();
  const pushRes = await push('dev', {}, pushEnv.deps);
  const all = Object.keys(pushEnv.adapters).sort();
  assert.deepEqual([...pushEnv.ran].sort(), all, 'push must run every adapter once');
  assert.equal(pushEnv.ran.length, all.length);
  assert.equal(new Set(pushEnv.ran).size, all.length, 'no adapter run twice');
  assert.deepEqual([...pushRes.order].sort(), all);

  const pullEnv = makeOrchestratorEnv();
  const pullRes = await pull('dev', pullEnv.deps);
  assert.deepEqual([...pullEnv.ran].sort(), all, 'pull must run every adapter once');
  assert.equal(new Set(pullEnv.ran).size, all.length, 'no adapter run twice');
  assert.deepEqual([...pullRes.order].sort(), all);
});

test('pull runs adapters in the EXACT REVERSE of push order (assets LAST on pull)', async () => {
  const pushEnv = makeOrchestratorEnv();
  const pushRes = await push('dev', {}, pushEnv.deps);

  const pullEnv = makeOrchestratorEnv();
  const pullRes = await pull('dev', pullEnv.deps);

  // The core invariant: pull order is push order reversed, element for element.
  assert.deepEqual(pullRes.order, [...pushRes.order].reverse());
  assert.deepEqual(pullEnv.ran, [...pushEnv.ran].reverse());

  // And the load-bearing consequence: the asset COLLECTOR runs LAST on pull, so it
  // scans a fully-tokenized tree. (assets is a root => first on push => last on pull.)
  assert.equal(pullEnv.ran.at(-1), 'assets');
  // Symmetrically, assets runs at/near the front on push (it is a producer root).
  assert.equal(pushEnv.ran[0], 'assets');
  // Consumers (which tokenize refs) precede the collector on pull.
  const pidx = (n) => pullEnv.ran.indexOf(n);
  assert.ok(pidx('blog') < pidx('assets'));
  assert.ok(pidx('content') < pidx('assets'));
  assert.ok(pidx('pages') < pidx('assets'));
});

// ---------------------------------------------------------------------------
// REGISTRY PERSISTENCE — after EACH adapter, and durable across a mid-pipeline fail.
//
// Both orchestrators persist the registry after every adapter so a producer's
// freshly-registered ids survive even if a LATER adapter throws. These tests prove
// (a) one persist per adapter that ran, and (b) when a consumer throws mid-pipeline,
// the registry already persisted the producers' entries (no corruption / no loss of
// the work done before the failure).
// ---------------------------------------------------------------------------

test('push persists the registry after EACH adapter (one snapshot per adapter)', async () => {
  const { deps, ran, persistSnapshots } = makeOrchestratorEnv();
  await push('dev', {}, deps);
  // Exactly one persist call per adapter that ran.
  assert.equal(persistSnapshots.length, ran.length);
  // The Nth snapshot contains the entries of the first N adapters that ran (monotonic
  // growth — persistence is cumulative, never dropping earlier entries).
  ran.forEach((name, i) => {
    const snap = persistSnapshots[i];
    for (let j = 0; j <= i; j++) {
      assert.ok(`${ran[j]}:ran` in snap, `snapshot ${i} should contain ${ran[j]}`);
    }
    // The final snapshot has every adapter's entry.
    assert.equal(Object.keys(snap).length, i + 1);
  });
});

test('pull persists the registry after EACH adapter', async () => {
  const { deps, ran, persistSnapshots } = makeOrchestratorEnv();
  await pull('dev', deps);
  assert.equal(persistSnapshots.length, ran.length);
  // First adapter to run is persisted in the first snapshot.
  assert.ok(`${ran[0]}:ran` in persistSnapshots[0]);
});

test('push: a mid-pipeline adapter failure leaves PRODUCER entries already persisted (no loss)', async () => {
  // `content` consumes forms+assets. Make it throw — like a resolve() hard-fail.
  const { deps, ran, persistSnapshots } = makeOrchestratorEnv({ failOn: ['content'] });

  await assert.rejects(() => push('dev', {}, deps), /boom.*"content"/);

  // The pipeline aborted AT content, so content never persisted and consumers after it
  // (pages, theme) never ran.
  assert.ok(!ran.includes('pages'));
  assert.ok(!ran.includes('theme'));
  assert.ok(ran.includes('content')); // it ran (and then threw)
  // Producers that ran BEFORE the failure WERE persisted — their work is durable.
  // content runs after assets, blog, forms in topo order; each of those persisted.
  const lastSnapshot = persistSnapshots.at(-1);
  assert.ok('assets:ran' in lastSnapshot, 'assets producer entry must be persisted');
  assert.ok('forms:ran' in lastSnapshot, 'forms producer entry must be persisted');
  // content threw BEFORE persist, so its entry is NOT in any persisted snapshot.
  for (const snap of persistSnapshots) {
    assert.ok(!('content:ran' in snap), 'failed adapter must not be persisted');
  }
  // One persist per adapter that SUCCEEDED (content threw before its persist).
  const succeeded = ran.filter((n) => n !== 'content');
  assert.equal(persistSnapshots.length, succeeded.length);
});

test('pull: a mid-pipeline adapter failure leaves earlier adapters persisted', async () => {
  // On pull, order is reversed; make `blog` throw and prove earlier-running adapters
  // (the consumers that ran before it) were persisted, and the asset collector never
  // ran (so nothing downstream corrupted the registry).
  const env = makeOrchestratorEnv();
  // Determine pull order to pick a mid-pipeline victim deterministically.
  const pullOrder = topoSort({
    forms: { dependsOn: [] }, assets: { dependsOn: [] },
    blog: { dependsOn: ['assets'] }, theme: { dependsOn: ['forms'] },
    content: { dependsOn: ['forms', 'assets'] }, pages: { dependsOn: ['forms', 'assets'] },
  }).reverse();
  const victim = pullOrder[2]; // a mid-pipeline adapter
  const { deps, ran, persistSnapshots } = makeOrchestratorEnv({ failOn: [victim] });

  await assert.rejects(() => pull('dev', deps), /boom/);

  // Everything that ran BEFORE the victim is persisted; the victim and everything after
  // it are not. assets (the collector) is LAST on pull, so it never ran here.
  const victimIdx = pullOrder.indexOf(victim);
  for (let i = 0; i < victimIdx; i++) {
    assert.ok(
      persistSnapshots.some((s) => `${pullOrder[i]}:ran` in s),
      `${pullOrder[i]} (ran before the failure) must be persisted`,
    );
  }
  assert.ok(!ran.includes(pullOrder[victimIdx + 1]), 'no adapter after the failure ran');
});

// ---------------------------------------------------------------------------
// PROD GUARD — fires before ANY adapter loads (data-safety, via the seam).
// ---------------------------------------------------------------------------

test('push prod guard fires BEFORE loadAdapters/registry are even touched', async () => {
  let loadAdaptersCalled = false;
  let registryLoaded = false;
  const deps = {
    account: () => ({ name: 'prod', portalId: READ_ONLY_PORTAL }),
    loadAdapters: async () => { loadAdaptersCalled = true; return {}; },
    loadAccountRegistry: () => { registryLoaded = true; return { map: {} }; },
    persistAccountRegistry: () => {},
  };
  await assert.rejects(() => push('prod', { publish: true }, deps), /portal is read-only/);
  assert.equal(loadAdaptersCalled, false, 'must not load adapters for a prod target');
  assert.equal(registryLoaded, false, 'must not load the registry for a prod target');
});

test('pull is ALLOWED against prod (prod is the canonical source — no guard)', async () => {
  // Pulling FROM prod is expected; only push is guarded. Prove pull runs to completion
  // against the prod portal id.
  const env = makeOrchestratorEnv();
  env.deps.account = (n) => ({ name: n, portalId: READ_ONLY_PORTAL });
  const res = await pull('prod', env.deps);
  assert.equal(res.portalId, READ_ONLY_PORTAL);
  assert.equal(env.ran.length, Object.keys(env.adapters).length);
});

// ---------------------------------------------------------------------------
// PUSH PREFLIGHT — account-independent producer-source satisfiability check that
// runs BEFORE the adapter loop (before ANY network write), so an @logical ref with
// no backing producer on disk fails the push CLOSED instead of half-updating the
// account on a mid-loop resolve() throw.
//
// We drive preflightRefs() with a FAKE fs (a plain { path -> content } map) so the
// scan is fully deterministic and network-free. The map models the canonical tree:
//   <root>/content/forms/<k>.json | guids.json   (@form producer source)
//   <root>/content/assets/<path>                 (@asset producer source — bytes)
//   <root>/content/pages/*.json, blog/posts/*.json, theme files (ref carriers)
// ---------------------------------------------------------------------------

// Minimal fake fs over an in-memory tree. `files` maps absolute path -> string
// content; `dirs` is the set of directory paths that exist. readdirSync returns the
// immediate children (basenames) of a dir.
function makeFakeFs(files) {
  const fileSet = new Map(Object.entries(files));
  const dirSet = new Set();
  for (const p of fileSet.keys()) {
    // register every ancestor directory of each file
    let d = p.slice(0, p.lastIndexOf('/'));
    while (d && !dirSet.has(d)) {
      dirSet.add(d);
      d = d.slice(0, d.lastIndexOf('/'));
    }
  }
  return {
    existsSync: (p) => fileSet.has(p) || dirSet.has(p),
    readFileSync: (p) => {
      if (!fileSet.has(p)) throw new Error(`ENOENT: ${p}`);
      return fileSet.get(p);
    },
    readdirSync: (p) => {
      if (!dirSet.has(p)) throw new Error(`ENOTDIR: ${p}`);
      const prefix = `${p}/`;
      const kids = new Set();
      for (const f of fileSet.keys()) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        kids.add(rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : rest);
      }
      for (const d of dirSet) {
        if (d.startsWith(prefix)) {
          const rest = d.slice(prefix.length);
          kids.add(rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : rest);
        }
      }
      return [...kids];
    },
  };
}

const CONTENT = '/repo/content';

test('preflight PASSES when every @form/@asset/@portal ref has a producer source on disk', () => {
  const fs = makeFakeFs({
    // @form producer sources: a per-form file AND a keyed guids.json.
    [`${CONTENT}/forms/contact.json`]: '{"key":"contact"}',
    [`${CONTENT}/forms/guids.json`]: '{"demo":"e6510401-3265-44d4-88d5-a3c5c4670311"}',
    // @asset producer source: committed bytes at content/assets/<path>.
    [`${CONTENT}/assets/Sucess.jpg`]: 'BYTES',
    // ref carriers using only satisfiable tokens.
    [`${CONTENT}/pages/home.widgets.json`]:
      '{"a":"@form:contact","b":"@form:demo","c":"@asset:Sucess.jpg","p":"@portal"}',
    [`${CONTENT}/blog/posts/post-1.json`]: '{"img":"@asset:Sucess.jpg"}',
    // theme ref-bearer at the repo root (sibling of content/).
    ['/repo/js/hs-forms.js']: '// portal @portal only',
  });

  const { scanned } = preflightRefs(CONTENT, { fs });
  // It scanned the pages, blog post, and theme file (forms/assets dirs are sources,
  // not token carriers).
  assert.ok(scanned.includes(`${CONTENT}/pages/home.widgets.json`));
  assert.ok(scanned.includes(`${CONTENT}/blog/posts/post-1.json`));
  assert.ok(scanned.includes('/repo/js/hs-forms.js'));
});

test('preflight PASSES a blog-manifest @asset whose bytes live under content/blog/assets (codex #6 unification)', () => {
  // The blog adapter commits its manifest assets at content/blog/assets/<file>
  // (a sha1-prefixed name), NOT content/assets/<file>. Before unification the
  // preflight only looked at content/assets/ and REJECTED these as unsatisfiable.
  // Now resolveAssetBytesPath accepts EITHER tree, so a blog post referencing
  // @asset:<manifestFile> preflights OK as long as the bytes are committed in the
  // blog tree.
  const fs = makeFakeFs({
    // bytes committed ONLY in the blog manifest tree — NOT content/assets/.
    [`${CONTENT}/blog/assets/4e7bf9bad5-Inbox.png`]: 'PNGBYTES',
    // a blog post body referencing that manifest asset token.
    [`${CONTENT}/blog/posts/post-1.json`]:
      '{"postBody":"<img src=\\"@asset:4e7bf9bad5-Inbox.png\\">"}',
  });

  // Must NOT throw — the blog-manifest @asset is satisfiable.
  const { scanned } = preflightRefs(CONTENT, { fs });
  assert.ok(scanned.includes(`${CONTENT}/blog/posts/post-1.json`));
});

test('preflight STILL THROWS for an @asset committed in NEITHER tree', () => {
  // Sanity: unification widened the accepted trees, it did not weaken the guard —
  // an @asset with bytes in neither content/assets/ nor content/blog/assets/ is
  // still unsatisfiable and names BOTH candidate paths.
  const fs = makeFakeFs({
    [`${CONTENT}/blog/posts/post-1.json`]: '{"img":"@asset:NoSuchFile.png"}',
  });
  let err;
  try {
    preflightRefs(CONTENT, { fs });
    assert.fail('preflight should have thrown');
  } catch (e) {
    err = e;
  }
  assert.match(err.message, /@asset:NoSuchFile\.png/);
  assert.match(err.message, /content\/assets\/NoSuchFile\.png/);
  assert.match(err.message, /content\/blog\/assets\/NoSuchFile\.png/);
});

test('preflight THROWS listing an @cta (no producer) and a missing @asset — and names every offender', () => {
  const fs = makeFakeFs({
    [`${CONTENT}/forms/contact.json`]: '{"key":"contact"}',
    // NOTE: no content/assets/Missing.png — its bytes are not committed.
    [`${CONTENT}/pages/home.widgets.json`]:
      '{"form":"@form:contact","cta":"@cta:book-demo","img":"@asset:Missing.png","menu":"@menu:main"}',
  });

  let err;
  try {
    preflightRefs(CONTENT, { fs });
    assert.fail('preflight should have thrown');
  } catch (e) {
    err = e;
  }
  // Aggregated, fail-closed message.
  assert.match(err.message, /push preflight/);
  assert.match(err.message, /unsatisfiable/);
  // Every offender is named: the @cta (no producer), the @menu (no producer), and the
  // @asset with missing committed bytes.
  assert.match(err.message, /@cta:book-demo/);
  assert.match(err.message, /@menu:main/);
  assert.match(err.message, /@asset:Missing\.png/);
  // The satisfied @form is NOT flagged.
  assert.doesNotMatch(err.message, /@form:contact/);
});

test('preflight CATCHES a missing-bytes @asset in content/blog/authors.json (the first-full-push escape)', () => {
  // The headline regression. On the first full push, preflightRefs only scanned
  // content/pages/*, content/blog/posts/*, and theme files — it NEVER scanned
  // content/blog/authors.json, so an author-avatar @asset with NO committed bytes
  // slipped past the fail-closed preflight and was only caught LATER by the assets
  // adapter (a mid-loop, post-network-write throw). The broadened recursive scan must
  // now flag it AT PREFLIGHT, before any write.
  const fs = makeFakeFs({
    // authors.json references an avatar whose bytes are committed in NEITHER tree.
    [`${CONTENT}/blog/authors.json`]:
      '{"authors":[{"slug":"ivan","avatar":"@asset:0af4d59ddc-ivanlabianca.jpg"}]}',
  });

  let err;
  try {
    preflightRefs(CONTENT, { fs });
    assert.fail('preflight should have thrown for the unsatisfiable authors.json avatar');
  } catch (e) {
    err = e;
  }
  assert.match(err.message, /push preflight/);
  assert.match(err.message, /@asset:0af4d59ddc-ivanlabianca\.jpg/);
  // It names the file it found the offending token in.
  assert.match(err.message, /authors\.json/);
});

test('preflight PASSES the authors.json avatar once its bytes are committed (in either tree)', () => {
  // Same authors.json, but now the avatar bytes ARE committed — once in the unified
  // assets tree, once in the blog byte tree — so the recursive scan + dual-tree
  // satisfiability accept both and the preflight passes.
  const fs = makeFakeFs({
    [`${CONTENT}/assets/0af4d59ddc-ivanlabianca.jpg`]: 'JPGBYTES',
    [`${CONTENT}/blog/assets/8b5126d203-lexie.jpg`]: 'JPGBYTES',
    [`${CONTENT}/blog/authors.json`]:
      '{"authors":[{"avatar":"@asset:0af4d59ddc-ivanlabianca.jpg"},{"avatar":"@asset:8b5126d203-lexie.jpg"}]}',
  });

  const { scanned } = preflightRefs(CONTENT, { fs });
  // The broadened scan actually visited authors.json.
  assert.ok(scanned.includes(`${CONTENT}/blog/authors.json`));
});

test('preflight RECURSIVELY scans nested blog + forms ref carriers (and EXEMPTS the byte/producer trees)', () => {
  const fs = makeFakeFs({
    // forms producer sources — EXEMPT from token scanning (and intentionally carry a
    // string that LOOKS like an unsatisfiable token; if they were scanned the preflight
    // would wrongly flag it).
    [`${CONTENT}/forms/guids.json`]: '{"demo":"e6510401-3265-44d4-88d5-a3c5c4670311"}',
    [`${CONTENT}/forms/properties.json`]: '{"note":"@cta:would-fail-if-scanned"}',
    // a real per-form file IS a ref carrier — its @asset must be satisfiable.
    [`${CONTENT}/forms/contact.json`]: '{"key":"contact","thanksImg":"@asset:thanks.png"}',
    [`${CONTENT}/assets/thanks.png`]: 'PNG',
    // a NESTED blog post (posts/ subdir) is reached by the recursion.
    [`${CONTENT}/blog/posts/post-1.json`]: '{"img":"@asset:thanks.png"}',
    // the blog BYTE tree is EXEMPT — its filename is not even .json, but prove a
    // .json-looking blob there is not scanned by planting a would-fail token in one.
    [`${CONTENT}/blog/assets/decoy.json`]: '{"x":"@cta:would-fail-if-scanned"}',
  });

  // Must NOT throw: guids/properties + the blog byte tree are exempt, and every real
  // carrier's @asset is satisfiable.
  const { scanned } = preflightRefs(CONTENT, { fs });
  assert.ok(scanned.includes(`${CONTENT}/forms/contact.json`), 'per-form file is scanned');
  assert.ok(scanned.includes(`${CONTENT}/blog/posts/post-1.json`), 'nested blog post is scanned');
  // The exempt producer/byte files are NOT in the scanned set.
  assert.ok(!scanned.includes(`${CONTENT}/forms/guids.json`), 'guids.json is exempt');
  assert.ok(!scanned.includes(`${CONTENT}/forms/properties.json`), 'properties.json is exempt');
  assert.ok(!scanned.includes(`${CONTENT}/blog/assets/decoy.json`), 'blog byte tree is exempt');
});

test('push fails CLOSED on a bad ref via the fs seam — NO adapter loads, NO push runs, registry never loaded', async () => {
  // push() calls preflightRefs(contentDir(), { fs }), so we key the fake fs to the REAL
  // contentDir() path and plant an unsatisfiable @cta in a pages file. The push must
  // throw from the preflight BEFORE loadAdapters/registry/any adapter.push is touched.
  const cdir = realContentDir();
  const fs = makeFakeFs({
    [`${cdir}/pages/home.widgets.json`]: '{"cta":"@cta:book-demo"}',
  });

  let loadAdaptersCalled = false;
  let registryLoaded = false;
  let anyAdapterPushed = false;
  const deps = {
    account: (n) => ({ name: n, portalId: '246389711' }), // non-prod: clears the prod guard
    fs,
    loadAdapters: async () => {
      loadAdaptersCalled = true;
      return {
        forms: {
          name: 'forms',
          dependsOn: [],
          push: async () => { anyAdapterPushed = true; return { pushed: 1 }; },
        },
      };
    },
    loadAccountRegistry: () => { registryLoaded = true; return { portalId: '246389711', map: {} }; },
    persistAccountRegistry: () => {},
  };

  await assert.rejects(() => push('dev', {}, deps), /push preflight.*@cta:book-demo/s);

  // Fail-closed BEFORE any network write: adapters never loaded, registry never loaded,
  // and no adapter.push() ran.
  assert.equal(loadAdaptersCalled, false, 'preflight must abort before loadAdapters');
  assert.equal(registryLoaded, false, 'preflight must abort before the registry loads');
  assert.equal(anyAdapterPushed, false, 'NO adapter push may run when the preflight fails');
});

test('push PROCEEDS past a satisfied preflight to the adapter loop (no offenders -> adapters run)', async () => {
  // Fake fs keyed to the REAL contentDir(): pages/blog/theme carry only satisfiable
  // tokens, so the preflight passes and push() reaches loadAdapters + the loop.
  const cdir = realContentDir();
  const fs = makeFakeFs({
    [`${cdir}/forms/contact.json`]: '{"key":"contact"}',
    [`${cdir}/assets/Logo.png`]: 'BYTES',
    [`${cdir}/pages/home.widgets.json`]: '{"f":"@form:contact","a":"@asset:Logo.png","p":"@portal"}',
  });

  let anyAdapterPushed = false;
  const deps = {
    account: (n) => ({ name: n, portalId: '246389711' }),
    fs,
    loadAdapters: async () => ({
      forms: {
        name: 'forms',
        dependsOn: [],
        push: async () => { anyAdapterPushed = true; return { pushed: 2 }; },
      },
    }),
    loadAccountRegistry: () => ({ portalId: '246389711', map: {} }),
    persistAccountRegistry: () => {},
  };

  const res = await push('dev', {}, deps);
  assert.equal(anyAdapterPushed, true, 'a satisfied preflight must let the adapter loop run');
  assert.equal(res.account, 'dev');
});
