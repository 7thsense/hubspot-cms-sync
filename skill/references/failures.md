# Failure Reference

Prefer the CLI's error text and remediation output. Use this file to classify
failures and choose the next diagnostic step.

## Configuration

Symptoms:

- Missing `hubspot-cms-sync.config.mjs`.
- Invalid config shape.
- Target name is not present in `accountsFile`.
- `keyDirEnv` is unset or points at missing credentials.

Action: fix config or CI secret hydration before retrying sync commands.

## Read-Only Portal

Symptoms:

- Target portal ID is listed in `readOnlyPortalIds`.
- Preflight blocks write operations.

Action: do not bypass the guard. Choose a write-capable preview target or ask
for an explicit config change.

## Dependency References

Symptoms:

- Surviving `@cta:*` or `@menu:*` references.
- Missing producer adapter output.
- Manifest objects refer to absent content.

Action: fail closed until the producer adapter or source content exists.

## HubSpot API

Symptoms:

- Authentication failure.
- Rate limit or transient 5xx response.
- Validation error from a HubSpot object endpoint.

Action: distinguish credential/config failures from transient API failures. For
transient failures, retry the smallest failed operation. For validation errors,
fix the source object or adapter output.

## Verification

Symptoms:

- Missing `SITE_BASE_URL` or configured base URL env var.
- Playwright or link checks cannot reach the preview.
- Screenshots differ after a template or module change.

Action: report unavailable verification separately from failed verification.
When screenshots differ, include the affected page and artifact path.
