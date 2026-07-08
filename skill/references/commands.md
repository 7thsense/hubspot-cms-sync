# Command Reference

Commands are shown with the short alias `hcms`. Use `hubspot-cms-sync` if the
repo has not installed the alias.

## Inspection

- `hcms doctor`: validate config, credentials, target definitions, and local
  filesystem assumptions.
- `hcms corpus`: validate the local content corpus and adapter references.
- `hcms push <target> --dry-run`: produce a write plan without applying it.

## Pull

Use pull when HubSpot is the source of truth for the current task.

```bash
hcms doctor
hcms pull <target>
hcms corpus
git diff --stat
git diff
```

Summarize changed files, content objects, and any verification that could not be
run.

## Push

Use push when git is the source of truth and the target is write-capable.

```bash
hcms doctor
hcms corpus
hcms preflight <target>
hcms push <target> --dry-run
hcms push <target> --publish
hcms redirects <target>
hcms redirects <target> --apply
the consuming repo verification commands
```

Stop before `push` if preflight or plan output indicates a read-only portal,
unresolved dependency, missing credential, or unexpected destructive change.
Run `hcms redirects` without `--apply` first when redirects are part of the
deployment surface.

## Republish

Use the narrowest republish scope that satisfies the change.

```bash
hcms preflight <target>
hcms republish <target> --all
the consuming repo verification commands
```

Prefer explicit page, blog, or template scopes when the CLI supports them.

## Beefree email import (≥ 0.26.2)

Import Beefree **Download HTML** exports into manifest-scoped DnD campaigns.
Full runbook: `docs/BEEFREE_ZIP_IMPORT.md`.

```bash
# Dry-run import
hcms emails import beefree-zip /path/to/export.zip --key <campaign> \
  --name "Display name" --subject "Subject" --preview-text "Preview"

# Write campaign + assets + provenance
hcms emails import beefree-zip /path/to/export.zip --key <campaign> --write

# Re-apply copy overlay after editing content.spec.json
hcms emails import beefree-apply-content --key <campaign> --write

# Push (assets before emails)
hcms push <target> --dry-run --only assets,emails
hcms push <target> --only assets,emails
```

Stop before push if `hcms doctor` reports missing keys, if `@asset:` bytes are
not committed under `content/assets/`, or if the manifest entry is missing.
Prod requires `HCMS_ALLOW_PROD_PUSH=1` when the portal is read-only.
