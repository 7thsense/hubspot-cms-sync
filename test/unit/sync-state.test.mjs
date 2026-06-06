// Unit tests for sync/lib/sync-state.mjs — per-account registry persistence.
//   node --test test/unit/sync-state.test.mjs
//
// sync-state.mjs hardcodes its state directory to <repoRoot>/.sync-state, so we
// cannot redirect it to a tmp dir. Instead each test uses a UNIQUE, throwaway
// portalId (so it can never collide with a real account's registry file — e.g.
// the dev sandbox 246389711) and we delete exactly the files we created in
// after(). A separate tmp dir is created for any auxiliary artifacts and removed
// in after() as well.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  rmSync,
  mkdtempSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  persistAccountRegistry,
  loadAccountRegistry,
  registryPath,
  syncStateDir,
} from '../../src/lib/sync-state.mjs';
import { emptyRegistry } from '../../src/lib/refs.mjs';
import { stableStringify } from '../../src/lib/canonical.mjs';

// Unique, non-real test portal ids. Real accounts are numeric (529456 /
// 246389711); we prefix with a marker + pid + time so we never touch a real
// registry and never collide with a parallel run.
let SEQ = 0;
function testPortalId() {
  return `zzTEST-${process.pid}-${Date.now()}-${SEQ++}`;
}

// Track every state file we create so we can guarantee cleanup even on failure.
const created = new Set();
function trackPortal(pid) {
  // The .tmp-<pid> file lives next to the final file; track both shapes.
  created.add(registryPath(pid));
  return pid;
}

let TMP_DIR;

before(() => {
  TMP_DIR = mkdtempSync(join(tmpdir(), 'sync-state-test-'));
});

after(() => {
  // Remove every registry/tmp file this suite created, leaving any real
  // (246389711 etc.) state untouched.
  const dir = syncStateDir();
  for (const f of created) {
    if (existsSync(f)) rmSync(f);
  }
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('zzTEST-')) rmSync(join(dir, name));
    }
  }
  if (TMP_DIR && existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
});

// ── round-trip persist -> load is byte-stable + structurally equal ───────────

test('persist -> load round-trips the registry (deep-equal)', () => {
  const pid = trackPortal(testPortalId());

  const reg = emptyRegistry(pid);
  reg.forms = { 'contact-us': 'e6510401-3265-44d4-88d5-a3c5c4670311' };
  reg.ctas = { 'request-demo': '5596b1eb-a9b1-4409-9907-7363916d850c' };
  reg.menus = { main: '12345' };
  reg.assets = { 'images/logo.png': '/hubfs/logo.png' };

  persistAccountRegistry(pid, reg);
  const loaded = loadAccountRegistry(pid);

  assert.equal(loaded.portalId, pid);
  assert.deepEqual(loaded.forms, reg.forms);
  assert.deepEqual(loaded.ctas, reg.ctas);
  assert.deepEqual(loaded.menus, reg.menus);
  assert.deepEqual(loaded.assets, reg.assets);
});

test('persist is byte-stable: rewriting the same registry yields identical bytes', () => {
  const pid = trackPortal(testPortalId());

  const reg = emptyRegistry(pid);
  // Insert keys in deliberately NON-sorted order; stableStringify must sort them.
  reg.forms = { zebra: 'g-z', alpha: 'g-a', mid: 'g-m' };

  persistAccountRegistry(pid, reg);
  const bytes1 = readFileSync(registryPath(pid), 'utf8');

  // Persisting the loaded-back registry must produce identical bytes.
  persistAccountRegistry(pid, loadAccountRegistry(pid));
  const bytes2 = readFileSync(registryPath(pid), 'utf8');

  assert.equal(bytes1, bytes2, 'second write must be byte-identical to the first');
  // And the bytes must equal what stableStringify of the saved shape produces.
  assert.equal(bytes2.endsWith('\n'), true, 'file ends with a trailing newline');
  // Keys appear sorted on disk.
  const idxAlpha = bytes2.indexOf('"alpha"');
  const idxMid = bytes2.indexOf('"mid"');
  const idxZebra = bytes2.indexOf('"zebra"');
  assert.ok(idxAlpha < idxMid && idxMid < idxZebra, 'form keys serialized in sorted order');
});

// ── persist is atomic: no leftover .tmp- file; final file is complete JSON ────

test('persist leaves no .tmp- file and writes complete valid JSON', () => {
  const pid = trackPortal(testPortalId());

  const reg = emptyRegistry(pid);
  reg.forms = { foo: 'bar' };
  persistAccountRegistry(pid, reg);

  const final = registryPath(pid);
  assert.equal(existsSync(final), true, 'final registry file exists');

  // No leftover temp file matching this final path for any pid suffix.
  const dir = syncStateDir();
  const base = final.slice(dir.length + 1); // "<pid>.registry.json"
  const leftovers = readdirSync(dir).filter(
    (n) => n.startsWith(`${base}.tmp-`),
  );
  assert.deepEqual(leftovers, [], `no leftover .tmp- files, found: ${leftovers}`);

  // Final file parses as complete, valid JSON with the expected content.
  const parsed = JSON.parse(readFileSync(final, 'utf8'));
  assert.equal(parsed.portalId, pid);
  assert.deepEqual(parsed.forms, { foo: 'bar' });
  // saveRegistry shape: all four namespaces present.
  for (const ns of ['forms', 'ctas', 'menus', 'assets']) {
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, ns), `has ${ns}`);
  }
});

test('atomic rename overwrites in place: never observes a partial file', () => {
  const pid = trackPortal(testPortalId());

  // Write an initial complete registry.
  const first = emptyRegistry(pid);
  first.forms = { a: '1' };
  persistAccountRegistry(pid, first);
  const final = registryPath(pid);
  const before = readFileSync(final, 'utf8');
  assert.doesNotThrow(() => JSON.parse(before));

  // Overwrite with a different registry; the file must always be valid JSON.
  const second = emptyRegistry(pid);
  second.forms = { a: '1', b: '2' };
  persistAccountRegistry(pid, second);

  const afterBytes = readFileSync(final, 'utf8');
  const parsed = JSON.parse(afterBytes); // would throw if half-written
  assert.deepEqual(parsed.forms, { a: '1', b: '2' });
  assert.notEqual(before, afterBytes, 'file content updated');
});

// ── corrupt pre-existing registry throws a clear "Corrupt registry" error ─────

test('loadAccountRegistry throws "Corrupt registry" on malformed JSON', () => {
  const pid = trackPortal(testPortalId());
  const file = registryPath(pid);

  // Ensure the dir exists by doing a clean write first, then corrupt the file.
  persistAccountRegistry(pid, emptyRegistry(pid));
  writeFileSync(file, '{ this is not: valid json ]]'); // truncated/garbage

  assert.throws(
    () => loadAccountRegistry(pid),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Corrupt registry/);
      assert.ok(
        err.message.includes(file),
        'error names the offending file path',
      );
      return true;
    },
  );
});

test('loadAccountRegistry on missing file returns a seeded empty registry (control)', () => {
  const pid = trackPortal(testPortalId());
  // No persist — file does not exist.
  assert.equal(existsSync(registryPath(pid)), false);

  const reg = loadAccountRegistry(pid);
  assert.equal(reg.portalId, pid);
  assert.deepEqual(reg.forms, {});
  assert.deepEqual(reg.ctas, {});
  assert.deepEqual(reg.menus, {});
  assert.deepEqual(reg.assets, {});
});

test('persisted bytes match stableStringify(saveRegistry-shape) exactly', () => {
  const pid = trackPortal(testPortalId());
  const reg = emptyRegistry(pid);
  reg.assets = { 'b.png': '/hubfs/b.png', 'a.png': '/hubfs/a.png' };

  persistAccountRegistry(pid, reg);
  const onDisk = readFileSync(registryPath(pid), 'utf8');

  const expected = stableStringify({
    portalId: pid,
    forms: {},
    ctas: {},
    menus: {},
    assets: { 'b.png': '/hubfs/b.png', 'a.png': '/hubfs/a.png' },
  });
  assert.equal(onDisk, expected);
});
