# GitHub Actions Examples

This package is currently a planning scaffold. The workflows in
`examples/github-actions/` are distribution templates for future consuming
repositories after the `hubspot-cms-sync` CLI is published.

Copy the examples into a consuming repo's `.github/workflows/` directory and
adjust portal names, credentials, branch policy, and verification commands to
match that repo's `hubspot-cms-sync.config.mjs`.

## Shared Assumptions

- The consuming repo has a committed `hubspot-cms-sync.config.mjs`.
- The consuming repo has a committed `site.manifest.json`.
- The CLI is available through either a project dependency or
  `npx --yes hubspot-cms-sync@latest`.
- `HUBSPOT_KEY_DIR` points at credentials hydrated during the workflow.
- Workflow targets such as `dev`, `preview`, and `prod` are examples. Use the
  names defined by the consuming repo's accounts file and config.
- Production portals should be protected by GitHub Environments and should not
  be used for pull request previews.

## Secrets

Use repository or environment secrets. Exact secret names can vary, but the
workflow should hydrate whatever credential files the consuming repo's
`accountsFile` expects.

Suggested baseline:

- `HUBSPOT_DEV_PRIVATE_APP_TOKEN`
- `HUBSPOT_PREVIEW_PRIVATE_APP_TOKEN`
- `HUBSPOT_PROD_PRIVATE_APP_TOKEN`
- `SITE_BASE_URL` or an environment-specific equivalent

Do not commit generated credential files or `.sync-state` mutations from CI
unless the consuming repo intentionally uses a reviewed pull flow for state
updates.

## Example Workflows

- `examples/github-actions/ci.yml`: read-only checks for pull requests and
  pushes.
- `examples/github-actions/preview.yml`: deploy a pull request to a non-prod
  preview portal and run verification.
- `examples/github-actions/publish.yml`: manually publish to a protected target.

## Command Policy

The examples prefer this sequence for write-capable operations:

1. `hcms doctor`
2. `hcms corpus`
3. `hcms preflight <target>`
4. `hcms push <target> --dry-run`
5. `hcms push <target> --publish`
6. `hcms redirects <target>`
7. `hcms redirects <target> --apply`
8. `the consuming repo verification commands`

For read-only CI, omit write steps and keep production credentials unavailable.

## Guardrails

- Do not bypass `readOnlyPortalIds`.
- Do not use production credentials in `pull_request` workflows.
- Keep publish workflows behind `workflow_dispatch` and a protected GitHub
  Environment.
- Treat surviving `@cta:*` and `@menu:*` references as closed failures until
  producer adapters exist.
- Treat HubSpot writes as rerun-to-convergence operations, not transactional
  rollbacks.
