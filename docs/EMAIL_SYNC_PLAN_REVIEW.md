# Email Sync Plan — Review Log

Reviews of `docs/EMAIL_SYNC_PLAN.md`. The plan document is the source of truth;
this file captures reviewer findings and what changed between versions.

---

## Review 1 — Codex (gpt-5.5), 2026-07-07

**Verdict:** Proceed with changes.

**Blocking issues addressed in v2:**

1. Identity: collision-safe `emailKey` + registry-only HubSpot ids
2. Push preflight must scan `content/emails/**`
3. No `registry.subscriptions` without `@subscription` ref grammar — omit on push v1
4. CTA linkify is lossy; default `ctaPolicy: fail`
5. Template mappings require `verified: true` + preflight

**Full output:** `/tmp/codex-email-plan-review.md` (local session artifact)

---

## Review 2 — Claude Fable (`claude-fable-5[1m]`), 2026-07-07

**Status:** Not executed — Claude Code returned monthly spend limit for Fable 5.

```
You've hit your monthly spend limit. Run /usage-credits to manage your limit
and keep using Fable 5 or switch models to continue this chat.
```

**Fallback:** Independent adversarial review using the same output contract (below).

---

## Review 2 (fallback) — Independent adversarial, 2026-07-07

**Verdict:** Pull-first OK (Phase 0–3). **Block push** until file-level fixes land.

### Blocking issues

1. **`registry.emails` not in `refs.mjs` contract** — `persistAccountRegistry` would drop email ids after each adapter.
2. **Third asset tree** (`content/emails/assets/`) specified but `assetRepoCandidates` only knows `content/assets/` and `content/blog/assets/`.
3. **Reconcile `keyOf` needs registry reverse-lookup** — `buildGitIndex` alone cannot map numeric HubSpot ids to `emailKey`.
4. **CTA pipeline missing** — pull must use `resolveCtaEmbeds` (blog parity); `@cta` in canonical JSON will fail `preflightRefs`.
5. **Two preflight layers conflated** — `preflightRefs` is account-independent; verified mappings and manifest gates need a separate manifest-aware check.
6. **Upsert name fallback** contradicts identity doctrine — registry-primary only, with uniqueness proof.

### High-risk gaps

- No `live()` predicate for marketing emails → reconcile orphan flood (311 vs ~10 git keys)
- Phase 0 “95% verified mappings” unrealistic in 1–2 days
- `semantic equality` undefined without `canonicalEmail()` normalization spec
- Fresh clone without `.sync-state/` cannot map email ids (unlike forms `guids.json`)

### Incorporated into v3

See “v3 changes from review #2” in `EMAIL_SYNC_PLAN.md` §Review history.

---

## Current plan status

**Document:** `docs/EMAIL_SYNC_PLAN.md` (v3)

**Safe to start:** Phase 0 spike, Phase 1 pull-only (after PR2 registry fix)

**Not safe to start:** Phase 4 push, full reconcile without manifest-scoped mode