import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  fingerprint,
  classifyChange,
  loadPublishSnapshot,
  savePublishSnapshot,
} from '../../src/lib/publish-snapshot.mjs';

test('fingerprint is stable + order-insensitive for object keys', () => {
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
  // arrays are order-sensitive (tag order is content)
  assert.notEqual(fingerprint([1, 2]), fingerprint([2, 1]));
});

test('classifyChange covers create/unchanged/update/drift', () => {
  assert.equal(classifyChange(null, 's1', 'r1', { remotePresent: false }), 'create');
  assert.equal(classifyChange(null, 's1', 'r1', { remotePresent: true }), 'update'); // present, no record
  assert.equal(classifyChange({ sourceFp: 's1', remoteFp: 'r1' }, 's1', 'r1'), 'unchanged');
  assert.equal(classifyChange({ sourceFp: 's1', remoteFp: 'r1' }, 's2', 'r1'), 'update'); // source edited
  assert.equal(classifyChange({ sourceFp: 's1', remoteFp: 'r1' }, 's1', 'r2'), 'drift'); // remote edited (UI)
});

test('save/load round-trips and sorts keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snap-'));
  try {
    const snap = { posts: { 'b': { id: '2', sourceFp: 'x', remoteFp: 'y' }, 'a': { id: '1', sourceFp: 'p', remoteFp: 'q' } }, pages: {} };
    savePublishSnapshot(dir, '529456', snap);
    const back = loadPublishSnapshot(dir, '529456');
    assert.deepEqual(back.posts.a, { id: '1', sourceFp: 'p', remoteFp: 'q' });
    assert.deepEqual(Object.keys(back.posts), ['a', 'b']); // sorted
    // missing portal -> empty shape
    assert.deepEqual(loadPublishSnapshot(dir, 'nope'), { version: 1, posts: {}, pages: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
