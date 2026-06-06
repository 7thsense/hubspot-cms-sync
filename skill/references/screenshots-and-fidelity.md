# Screenshots And Fidelity Reference

Use the consuming repo's configured verification commands before inventing new
checks. The config usually exposes them under `verification.commands`.

## Before Capture

1. Confirm the preview or production base URL from the configured env var.
2. Confirm the target has been published or republished.
3. Run link and form checks when the repo provides them.

## Screenshot Workflow

Use Playwright or the repo's chosen browser test runner.

```bash
the consuming repo verification commands
npx playwright test verify/fidelity.spec.mjs
```

Compare screenshots against the repo's accepted baselines. If baselines need to
change, keep that diff separate from content sync changes when possible.

## Reporting

Report:

- target name and base URL
- pages checked
- failed selectors, links, forms, or screenshot names
- artifact paths
- checks skipped because credentials, base URLs, or browser dependencies were
  unavailable
