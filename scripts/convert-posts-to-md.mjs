// scripts/convert-posts-to-md.mjs — one-time migration of a site's blog posts
// from HubSpot wire JSON to frontmatter+HTML (.md), in place.
//
// SAFETY: per file, convert json -> md, then immediately assert
// fileToWire(md) deep-equals the original parsed json. If ANY post would not
// survive byte-identical, NOTHING is written and the run aborts — the HubSpot
// push payload must be provably unchanged. Pass --apply to delete the .json
// after a verified .md is written; without it the run is a dry verification.
//
//   node scripts/convert-posts-to-md.mjs [siteDir] [--apply]

import { readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deepStrictEqual } from 'node:assert';
import { wireToFile, fileToWire } from '../src/lib/posts-format.mjs';

const apply = process.argv.includes('--apply');
const siteDir = resolve(process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) || '../7thsense-website');
const postsDir = join(siteDir, 'content/blog/posts');

const jsonFiles = readdirSync(postsDir).filter((f) => f.endsWith('.json'));
const planned = [];
for (const f of jsonFiles) {
  const jsonPath = join(postsDir, f);
  const original = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const md = wireToFile(original);
  // Hard gate: the md must reconstruct the EXACT wire object.
  deepStrictEqual(fileToWire(md), original);
  planned.push({ base: f.replace(/\.json$/, ''), jsonPath, mdPath: join(postsDir, f.replace(/\.json$/, '.md')), md });
}

console.log(`Verified ${planned.length}/${jsonFiles.length} posts reconstruct byte-identically.`);
if (!apply) {
  console.log('Dry run — pass --apply to write .md files and remove .json.');
} else {
  for (const p of planned) {
    writeFileSync(p.mdPath, p.md);
    rmSync(p.jsonPath);
  }
  console.log(`Applied: wrote ${planned.length} .md files, removed ${planned.length} .json files.`);
}
