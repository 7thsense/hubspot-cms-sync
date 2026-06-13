// scripts/posts-roundtrip.mjs — proves the frontmatter codec is LOSSLESS against
// the real corpus before any live content file is touched. For every post:
//   fileToWire(wireToFile(json)) must deep-equal json
// HubSpot is the primary target; this is the gate that says the reshaping can't
// regress the blog push.
//
//   node scripts/posts-roundtrip.mjs [siteDir]

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { deepStrictEqual } from 'node:assert';
import { wireToFile, fileToWire } from '../src/lib/posts-format.mjs';

const siteDir = resolve(process.argv[2] || '../7thsense-website');
const postsDir = join(siteDir, 'content/blog/posts');
const files = (await readdir(postsDir)).filter((f) => f.endsWith('.json')).sort();

let ok = 0;
const failures = [];
for (const f of files) {
  const original = JSON.parse(await readFile(join(postsDir, f), 'utf8'));
  try {
    deepStrictEqual(fileToWire(wireToFile(original)), original);
    ok++;
  } catch (err) {
    failures.push({ f, msg: err.message.split('\n').slice(0, 6).join('\n') });
  }
}

console.log(`Round-tripped ${ok}/${files.length} posts losslessly.`);
if (failures.length) {
  console.log(`\n${failures.length} FAILURES:`);
  for (const { f, msg } of failures.slice(0, 5)) console.log(`\n--- ${f} ---\n${msg}`);
  process.exit(1);
}
// Show one rendered file so the human-readability win is visible.
const sample = wireToFile(JSON.parse(await readFile(join(postsDir, files[0]), 'utf8')));
console.log('\n=== sample file head ===');
console.log(sample.split('\n').slice(0, 16).join('\n'));
