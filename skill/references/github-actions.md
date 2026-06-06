# GitHub Actions Reference

Use the repository's workflow files first. If adding new workflows, start from
the package examples:

- `examples/github-actions/ci.yml`
- `examples/github-actions/preview.yml`
- `examples/github-actions/publish.yml`

## CI

CI should be read-only. It can run:

```bash
hcms doctor
hcms corpus
hcms preflight <non-prod-target> --read-only
```

Do not expose production credentials to `pull_request` events.

## Preview

Preview workflows should use a non-prod HubSpot target and PR-level
concurrency.

Typical sequence:

```bash
hcms doctor
hcms corpus
hcms preflight preview
hcms push preview --dry-run
hcms push preview --publish
the preview verification commands
```

Upload the plan and verification artifacts when available.

## Publish

Publish workflows should be manual or release-driven and protected by a GitHub
Environment.

Typical sequence:

```bash
hcms doctor
hcms corpus
hcms preflight prod
hcms push prod --dry-run
hcms push prod --publish
the production verification commands
```

Keep a dry-run option for validating the plan without writing to HubSpot.
