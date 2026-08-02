<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Security Hardening from Parallel Review Findings

- **Plan**: context/changes/parallel-review-security/plan.md
- **Scope**: Phase 1–2 of 2 (both phases implemented; Phase 2 progress not yet marked complete)
- **Date**: 2026-08-02
- **Verdict**: NEEDS ATTENTION
- **Findings**: 2 warnings 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | PASS |

## Findings

### F1 — customModelsBaseUrl bypasses SSRF/metadata validation

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Safety & Quality
- **Location**: src/config.ts:78
- **Detail**: `customModelsBaseUrl` is read from user input (`INPUT_CUSTOM_MODELS_BASE_URL`) and forwarded to `OpenAIClient` via `buildClients`, but `validateConfig` only validates `customApiUrl`, `openRouterBaseUrl`, `kiloBaseUrl`, `baseURL`, `mistralBaseUrl`, and `groqBaseUrl`. A user can set `customModelsBaseUrl` to an arbitrary endpoint — including cloud metadata IPs — without triggering the SSRF checks in `validateProviderUrl`. The sibling `customApiUrl` IS validated.
- **Fix**: Add `validateProviderUrl(config.customModelsBaseUrl, 'custom_models_base_url')` to `validateConfig` when `customModelsBaseUrl` is set and differs from `customApiUrl`.
  - Strength: Closes the gap using the same proven SSRF blocklist pattern already applied to other base URLs.
  - Tradeoff: Users who intentionally set non-HTTPS/internal URLs for custom model endpoints would need to use `customApiUrl` instead or request an exception.
  - Confidence: HIGH — identical pattern used for `customApiUrl`, `openRouterBaseUrl`, etc.
  - Blind spot: Haven't verified whether any existing users rely on arbitrary `custom_models_base_url` values.
- **Decision**: FIXED

### F2 — Duplicate nameInDiff closures in validation.ts

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Pattern Consistency
- **Location**: src/validation.ts:15-29, 84-97
- **Detail**: Two near-identical `nameInDiff` closures exist in `validateCodeContext` and `findContradictedNegativeClaims`. The logic is 95% the same but not shared. If the boundary logic is fixed in one copy but not the other, behavior becomes inconsistent. Both copies share the `\w` quirk where `_` is treated as part of identifiers.
- **Fix**: Extract `nameInDiff` to a shared helper at module level in `validation.ts`.
  - Strength: Eliminates duplication; ensures boundary logic stays consistent.
  - Tradeoff: Minor refactor; requires updating both call sites.
  - Confidence: HIGH — straightforward extraction.
  - Blind spot: None significant.
- **Decision**: FIXED

### F3 — Injection pattern false-positives on legitimate custom rules

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/rules.ts:39
- **Detail**: Pattern `/override\s+(?:your|the)\s+(?:system|default|prior)\s+(?:prompt|instructions|behavior)/i` matches legitimate rules like `"Override your system prompt with custom rules after review sign-off"`. The rule is blocked and silently dropped. Users writing legitimate security rules about prompt configuration may see their rules ignored with only a log-level message.
- **Fix**: Custom rules come from the trusted `custom_rules` workflow input, so they are not subject to prompt-injection filtering. `validateRules` now surfaces injection-like content as a **warning** (logged, not silently dropped) and the `safe:` bypass prefix has been **removed** — a full bypass was itself a security risk (flagged by the review bot as a critical). This keeps legitimate rules from being dropped while avoiding an injection-detection escape hatch.
  - Strength: No false-positive drops, no security-bypassing escape hatch.
  - Tradeoff: Injection-like custom rules now reach the model (owner is warned via `core.warning`).
  - Confidence: HIGH — trusted-config threat model.
- **Decision**: FIXED (superseded the earlier `safe:` escape-hatch approach after the bot flagged it as critical)
