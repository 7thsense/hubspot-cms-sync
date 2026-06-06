# Migration Plan

This plan extracts the HubSpot CMS sync system from
`../7thsense-website/sync` into this standalone npm package.

The goal is not just moving files. The goal is to turn a repo-specific set of
working scripts into a reusable product surface:

- npm CLI for deterministic local and CI execution.
- Config-driven adapters instead of Seventh Sense constants in code.
- Clean import path from a consuming website repo.
- Optional Codex skill that uses the npm CLI rather than duplicating the engine.

---

## Current Source Inventory

Move or port these from `../7thsense-website/sync`:

| Source file | Package target | Notes |
| --- | --- | --- |
| `sync/pull.mjs` | `src/commands/pull.mjs` | Convert CLI parsing to shared command runner |
| `sync/push.mjs` | `src/commands/push.mjs` | Keep prod guard, make read-only portals config-driven |
| `sync/preflight.mjs` | `src/commands/preflight.mjs` | Make theme/blog expectations config-driven |
| `sync/republish.mjs` | `src/commands/republish.mjs` | Convert raw portal arg to account resolution |
| `sync/manifest.mjs` | `src/manifest.mjs` | Generalize theme name and page filters |
| `sync/cta-inventory.mjs` | `src/cta-inventory.mjs` | Keep as optional read-only CTA normalization helper |
| `sync/lib/*.mjs` | `src/lib/*.mjs` | Remove hardcoded repo roots and known portals |
| `sync/adapters/*.mjs` | `src/adapters/*.mjs` | Make paths and constants config-driven |
| `scripts/corpus-scan.mjs` | `src/commands/corpus.mjs` | Required for `hcms corpus`; currently outside `sync/` |
| `test/unit/**/*.test.mjs` | `test/unit/` | Engine tests move with the engine and import from `src/` |
| `test/integration/**/*.test.mjs` | `test/integration/` | Live/dev-account engine integration tests move with package |

Leave these behind or archive as legacy in the website repo:

| Legacy file | Action |
| --- | --- |
| `sync/blog-sync.mjs` | Remove after adapter parity is confirmed |
| `sync/cms-pull.mjs` | Remove after unified `pull` covers page definitions |
| `sync/forms-sync.mjs` | Remove after forms adapter handles push/pull |
| `sync/page-content.mjs` | Remove after content adapter covers widgets |

Keep these in the website repo:

| Website-local files | Reason |
| --- | --- |
| `verify/**/*.spec.mjs` | Site-specific Playwright fidelity/forms/links gates |
| `verify/**/*-snapshots/**` | Site-specific visual baselines |
| `content/**`, `templates/**`, `modules/**`, `css/**`, `js/**`, `images/**` | The consuming site source of truth |

---

## Target Package Layout

```text
hubspot-cms-sync/
├── bin/
│   └── hubspot-cms-sync.mjs
├── src/
│   ├── index.mjs
│   ├── cli.mjs
│   ├── config.mjs
│   ├── manifest.mjs
│   ├── commands/
│   │   ├── init.mjs
│   │   ├── pull.mjs
│   │   ├── push.mjs
│   │   ├── preflight.mjs
│   │   ├── republish.mjs
│   │   ├── corpus.mjs
│   │   └── verify.mjs
│   ├── adapters/
│   │   ├── assets.mjs
│   │   ├── blog.mjs
│   │   ├── content.mjs
│   │   ├── forms.mjs
│   │   ├── pages.mjs
│   │   └── theme.mjs
│   └── lib/
│       ├── canonical.mjs
│       ├── hub.mjs
│       ├── orchestrate.mjs
│       ├── refs.mjs
│       └── sync-state.mjs
├── examples/
│   ├── hubspot-cms-sync.config.mjs
│   └── site.manifest.json
├── test/
└── docs/
```

---

## Phase 1: Extract Without Generalizing Too Much

Objective: prove the package can run the Seventh Sense workflow from outside the
website repo.

Steps:

1. Copy unified sync files into `src/`.
2. Add a CLI wrapper with these commands:
   - `pull <account>`
   - `preflight <account>`
   - `push <account> [--publish]`
   - `republish <account|portalId> [--all] [--blog]`
   - `corpus [paths...]`
3. Add `--root <path>` and default it to `process.cwd()`.
4. Replace package-relative repo roots with an explicit resolved config object,
   built once in `src/cli.mjs` and passed into commands/libs/adapters. Do **not**
   use module-level `configure()` global state.
   Modules that currently need root/config threading:
   - `hub.mjs`: accounts path currently resolves from `__dirname`.
   - `manifest.mjs`: repo root and manifest path currently resolve from `__dirname`.
   - `sync-state.mjs`: `content/` and `.sync-state/` currently resolve from package source.
   - `theme.mjs`: theme root and temp `.sync-state` build path currently resolve from package source.
   - `preflight.mjs`: repo root and theme name currently resolve from package source.
   - `refs.mjs`: known portal IDs are currently hardcoded.
5. Keep the current adapter names and behavior.
6. Run the package against `../7thsense-website` using `node ../hubspot-cms-sync/bin/... --root .`.
7. Do not delete website repo scripts yet.

Acceptance:

```bash
cd ../7thsense-website
node ../hubspot-cms-sync/bin/hubspot-cms-sync.mjs corpus
node ../hubspot-cms-sync/bin/hubspot-cms-sync.mjs preflight dev
node ../hubspot-cms-sync/bin/hubspot-cms-sync.mjs push dev --dry-run
```

The first extraction is allowed to still require a Seventh Sense-shaped config.
It must also prove the engine works when `cwd` is the website repo and package
source lives elsewhere; no command may accidentally read/write inside
`node_modules/hubspot-cms-sync` or `../hubspot-cms-sync`.

---

## Phase 2: Config-Drive Repo-Specific Values

Objective: make the package reusable for another HubSpot CMS site.

Replace hardcoded values with `hubspot-cms-sync.config.mjs`:

- Account registry path.
- Key directory env var.
- Read-only portal IDs.
- Known portal IDs for canonicalization.
- Theme name.
- Theme roots and files.
- Content directory.
- Sync-state directory.
- Manifest path.
- Blog slug and template paths.
- UI-gated prerequisites.
- Asset host canonicalization policy.
- Forms desired-state path.
- CTA inventory behavior.
- Optional external adapter search paths, if plugin adapters are supported.

Acceptance:

- No `seventh-sense`, `theseventhsense`, `246389711`, or `529456` hardcoded in
  package source except examples/tests.
- Tests cover config loading and defaults.
- Package can run from a fixture project with a different theme name.
- `READ_ONLY_PORTAL` is replaced by `config.readOnlyPortalIds` membership checks.
- `KNOWN_PORTALS` is replaced by config-derived known portal IDs, or by a
  documented discovery rule from accounts + registry.
- Config loader behavior is tested: missing config, invalid config, missing
  accounts file, missing key file, and invalid manifest all print remediation
  and exit non-zero.

---

## Phase 3: Public CLI Surface

Objective: make the tool understandable and safe for normal users.

Add:

- `init`: writes example config and manifest.
- `doctor`: checks Node version, config, accounts, keys, manifest, and theme paths.
- `plan`: dry-run pull or push and print a resource summary.
- `push --dry-run`: resolves refs and preflights without writes.
- `verify`: orchestrates configured local/remote verification commands.
- `preview`: optional wrapper around push-to-dev plus verification.

Target command set:

```bash
hcms init
hcms doctor
hcms pull prod
hcms corpus
hcms preflight dev
hcms push dev --dry-run
hcms push dev --publish
hcms republish dev --all --blog
repo verification dev
```

Guardrails:

- Read-only portal IDs refuse push and preflight-by-default.
- Any unsupported logical ref fails before network writes.
- Missing UI-gated prerequisites produce remediation text.
- `--force-read-only` should not exist.
- Command outputs that agents/CI need to parse should have a stable JSON mode,
  e.g. `--json` for `doctor`, `plan`, `preflight`, and `verify`.

### Engine limitations carried into v1

The first public CLI should be honest about known limits:

- CTA and menu producer adapters do not exist yet. Any surviving `@cta:*` or
  `@menu:*` token fails closed at push preflight.
- Legacy image host canonicalization is best-effort and may need project policy
  for non-HubSpot or unrecoverable asset URLs.
- HubSpot writes are not globally transactional. A transient API failure after
  earlier writes can leave a partial target state; rerun-to-convergence is the
  recovery model.

---

## Phase 4: Move Website Repo To The Package

Objective: remove local sync implementation from `../7thsense-website`.

Website repo changes:

1. Add package dependency:
   ```json
   "devDependencies": {
     "hubspot-cms-sync": "file:../hubspot-cms-sync"
   }
   ```
2. Add `hubspot-cms-sync.config.mjs`.
3. Update `package.json` scripts:
   ```json
   {
     "sync:pull": "hcms pull",
     "sync:push": "hcms push",
     "sync:preflight": "hcms preflight",
     "sync:republish": "hcms republish",
     "corpus": "hcms corpus"
   }
   ```
4. Delete local unified sync files after parity:
   - `sync/pull.mjs`
   - `sync/push.mjs`
   - `sync/preflight.mjs`
   - `sync/republish.mjs`
   - `sync/manifest.mjs`
   - `sync/cta-inventory.mjs`
   - `sync/lib/**`
   - `sync/adapters/**`
5. Delete legacy scripts:
   - `sync/blog-sync.mjs`
   - `sync/cms-pull.mjs`
   - `sync/forms-sync.mjs`
   - `sync/page-content.mjs`
6. Keep only project-local config, content, theme, tests, and docs.
7. Repoint or remove website unit tests before deleting `sync/**`. Engine tests
   should have moved to the package; website repo tests should import package
   exports only if they are validating website-specific integration behavior.

Acceptance in website repo:

```bash
npm ci
npm run test:unit
npm run corpus
npm run sync:preflight -- dev
npm run sync:push -- dev --dry-run
```

This gate is only valid after test ownership is resolved. Do not delete
`sync/**` while website tests still import `../../sync/...`.

If credentials are present and the operator intends to write:

```bash
npm run sync:push -- dev --publish
npm test
```

---

## Phase 5: CI And PR Gates

Objective: make preview and deploy flows package-owned.

Package should provide reusable CI examples:

- `examples/github-actions/ci.yml`
- `examples/github-actions/publish.yml`
- `examples/github-actions/preview.yml`

Website repo should use:

- Unit/corpus checks on every PR.
- Optional `hcms preview dev --publish --verify` for preview environment.
- Manual `Publish` workflow for deployment.
- Environment-scoped `HUBSPOT_PORTAL_KEY`.

PR gates should include:

- `hcms corpus`
- `hcms push dev --dry-run`
- `npm run test:unit` or package-provided unit fixtures
- Playwright fidelity/forms/links checks against the preview URL

---

## Phase 6: npm Publication

Objective: publish as an installable CLI.

Before publication:

- Rename package if needed (`@seventhsense/hubspot-cms-sync` vs `hubspot-cms-sync`).
- Set `"private": false`.
- Add `LICENSE`.
- Add full README.
- Add fixture tests.
- Add provenance-capable GitHub release workflow.
- Add semver policy.
- Scrub private portal IDs from `examples/` and docs shipped in the npm tarball,
  or exclude those docs from `package.json#files`.
- Flip `"private": false`.
- Bump from `0.0.0` to an intentional prerelease version.
- Add `prepublishOnly` that runs the real test suite, lint, and `npm pack --dry-run`.
- Confirm package tarball contents contain no keys, `.sync-state`, private portal
  IDs, or customer-specific docs.

Release commands:

```bash
npm pack --dry-run
npm publish --provenance
```

---

## Phase 7: Codex Skill Companion

Objective: create a `hubspot-cms-sync` skill that tells Codex how to operate the
npm CLI safely.

The skill should not duplicate the sync engine. It should:

- Detect whether the npm CLI is installed.
- Read `hubspot-cms-sync.config.mjs`.
- Run `hcms doctor`, `hcms corpus`, `hcms preflight`, `hcms push --dry-run`, `hcms push`,
  and `repo verification`.
- Interpret common HubSpot errors.
- Guide PR preview/deployment workflows.
- Capture screenshots via the consuming repo's Playwright commands.

See [SKILL_DISTRIBUTION.md](./SKILL_DISTRIBUTION.md).
