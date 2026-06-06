# Skill Distribution Plan

The Codex skill should be a companion to the npm CLI, not a replacement for it.

## Skill Purpose

Help an agent operate `hubspot-cms-sync` correctly inside a project:

- inspect config and manifest
- run preflight and corpus checks
- perform pull/push/republish flows
- interpret common failures
- manage preview/deployment PR gates
- capture and compare screenshots through the consuming repo's configured tests

The npm CLI owns deterministic behavior. The skill owns agent procedure,
interpretation, and safe sequencing.

## Proposed Skill Layout

```text
hubspot-cms-sync/
├── SKILL.md
└── references/
    ├── commands.md
    ├── config.md
    ├── failures.md
    ├── github-actions.md
    └── screenshots-and-fidelity.md
```

Do not bundle the full sync implementation into the skill. The deterministic
engine lives in npm.

`SKILL.md` with YAML frontmatter is the portable core. Agent-specific metadata
files such as `agents/openai.yaml` can be generated later for marketplaces that
need them, but they should not be the primary source of truth.

## SKILL.md Scope

The skill body should stay short:

1. Confirm `hubspot-cms-sync` / `hcms` is installed.
2. Read `hubspot-cms-sync.config.mjs`.
3. Run `hcms doctor` before risky operations.
4. For pull: run pull, corpus, git diff, and summarize.
5. For push: run corpus, preflight, plan, push, republish if needed, verify.
6. For CI failures: inspect logs, classify failure, rerun the minimum command.
7. Never bypass read-only portal guards.
8. Surface v1 engine limits clearly: surviving `@cta:*` or `@menu:*` refs fail
   closed until producer adapters exist; global HubSpot writes are rerun-to-
   convergence, not transactional rollback.

## References

- `commands.md`: command matrix and expected outputs.
- `config.md`: config schema and examples.
- `failures.md`: HubSpot API failures and remediation text.
- `github-actions.md`: environment secrets, preview, deploy, PR gates.
- `screenshots-and-fidelity.md`: Playwright screenshot workflows and baseline
  update rules.

## Example User Prompts

- "Pull HubSpot prod into git and summarize the diff."
- "Deploy this PR to the HubSpot preview sandbox and run fidelity checks."
- "Why did `hcms preflight dev` fail?"
- "Republish all live pages after this template change."
- "Set up HubSpot CMS sync in this repo."

## Skill Guardrails

- The skill must not tell the agent to edit `.sync-state` manually.
- The skill must not suggest pushing to a read-only portal.
- The skill should prefer `hcms push --dry-run` and `hcms preflight` before any write.
- The skill should report verification gaps clearly if credentials or a live
  preview URL are unavailable.
- The skill should source common failure explanations from CLI output and
  package references, not invent parallel remediation text.
