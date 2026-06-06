---
name: hubspot-cms-sync
description: Use when operating the hubspot-cms-sync CLI in a repository: inspect config and manifest files, run doctor/corpus/preflight/pull/push/republish/verify flows, debug GitHub Actions failures, and safely manage HubSpot CMS preview or publish workflows.
---

# HubSpot CMS Sync

Use this skill to operate `hubspot-cms-sync` or `hcms` inside a consuming repo.
The CLI owns deterministic sync behavior; the agent owns sequencing,
interpretation, and clear reporting.

## First Checks

1. Confirm the repo has `hubspot-cms-sync.config.mjs` and `site.manifest.json`.
2. Confirm `hubspot-cms-sync` or `hcms` is available. If not, use the package
   command documented by the repo.
3. Read the config before choosing targets, credential environment variables, or
   verification commands.
4. Run `hcms doctor` before risky operations.
5. Never bypass read-only portal guards or write to a production portal from a
   pull request workflow.

## Common Flows

- Pull: run `hcms pull <target>`, `hcms corpus`, inspect `git diff`, then
  summarize content changes and verification gaps.
- Push: run `hcms corpus`, `hcms preflight <target>`, `hcms push <target> --dry-run`,
  then `hcms push <target> --publish` only after the checks match intent.
- Republish: run `hcms preflight <target>`, then `hcms republish <target>` with
  the narrowest flags needed.
- Verify: use the consuming repo's configured tests after the CLI checks pass.
- CI failure: inspect logs, classify the failure, rerun the smallest local
  command that reproduces it, and avoid broad retries until the cause is known.

## References

Load only the reference needed for the task:

- `references/commands.md`: command matrix and expected sequencing.
- `references/config.md`: config and manifest fields to inspect.
- `references/failures.md`: common failure classes and remediation.
- `references/github-actions.md`: CI, preview, and publish workflow policy.
- `references/screenshots-and-fidelity.md`: visual verification workflows.

## Guardrails

- Do not edit `.sync-state` by hand.
- Do not suggest pushing to a configured read-only portal.
- Prefer `hcms push --dry-run` and `hcms preflight` before any write.
- Report missing credentials or preview URLs as verification gaps.
- Treat surviving `@cta:*` or `@menu:*` references as closed failures until
  producer adapters exist.
- Treat HubSpot writes as rerun-to-convergence operations, not transactional
  rollbacks.
