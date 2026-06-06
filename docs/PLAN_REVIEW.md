# Plan Review Notes

This captures the read-only Claude review of the initial extraction plan.

## Critical Findings

1. **Move the tests with the engine.** The website repo unit/integration tests
   import `sync/**` directly. If the website deletes local sync code before the
   tests move or repoint to package exports, `npm run test:unit` will fail.

2. **Move the corpus scanner.** `hcms corpus` depends on
   `scripts/corpus-scan.mjs`, which lives outside `sync/` and was missing from
   the initial inventory.

3. **Make the read-only guard config-driven.** The current single hardcoded
   `READ_ONLY_PORTAL = '529456'` must become `config.readOnlyPortalIds` while
   preserving fail-closed behavior.

4. **Thread config explicitly.** Several modules resolve paths from `__dirname`;
   that will point into the npm package once installed. Build a resolved config
   object once in the CLI and pass it into commands/libs/adapters instead of using
   package-relative roots or global mutable config.

5. **Scrub publish artifacts.** Docs/examples currently mention private portal
   IDs. Before npm publication, scrub all shipped docs/examples or exclude them
   from `package.json#files`.

## Plan Updates Made

- Added `scripts/corpus-scan.mjs`, `test/unit/**`, and `test/integration/**` to
  the migration inventory.
- Added explicit root/config threading requirements and named the affected
  modules.
- Added acceptance gates for config loader behavior, known portal IDs, and
  read-only portal arrays.
- Added v1 limitations for CTA/menu producers, legacy asset hosts, and global
  transaction limits.
- Aligned the example config with the documented schema.
- Added `prepublishOnly` placeholder guard in `package.json`.
- Updated the skill plan to keep the deterministic engine in npm and use the
  skill only as an agent workflow wrapper.

