<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Custom API Support

- **Plan**: context/changes/custom-api-support/plan.md
- **Scope**: Phase 1–3 of 3
- **Date**: 2026-07-20
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 4 warnings, 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | WARNING |

## Findings

### F1 — No SSRF protection on customApiUrl

- **Severity**: WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/index.ts:45-46, src/review.ts:47
- **Detail**: `customApiUrl` is accepted from workflow inputs with no validation. Combined with empty `customApiKey` being permitted (for keyless endpoints like local Ollama), this allows constructing a `NimClient` pointed at any URL including private/loopback addresses. In `pull_request_target` workflows, fork PR authors can influence these inputs.
- **Fix A ⭐ Recommended**: Validate `customApiUrl` scheme is `https://` (or `http://` for localhost only)
  - Strength: Blocks the most common SSRF vector (http://169.254.169.254 metadata, internal hosts) while still supporting local Ollama on localhost.
  - Tradeoff: Slightly reduces flexibility — users on plain HTTP endpoints behind a VPN would need to use localhost or add an explicit opt-in flag.
  - Confidence: HIGH — this is a standard SSRF mitigation pattern.
  - Blind spot: Haven't checked whether `pull_request_target` is actually used in this repo's workflow triggers.
- **Fix B**: Require `customApiKey` to be non-empty when `customApiUrl` is set
  - Strength: Eliminates the unauthenticated-request-to-arbitrary-URL path entirely.
  - Tradeoff: Breaks the documented keyless-endpoint use case (local Ollama).
  - Confidence: MEDIUM — the feature explicitly advertises empty-key support.
  - Blind spot: None significant.
- **Decision**: FIXED via Fix A — URL scheme validation added to src/index.ts

### F2 — buildCombinedChain has 6 positional parameters

- **Severity**: WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architecture
- **Location**: src/model-chain.ts:17-24, src/index.ts:55-62
- **Detail**: `buildCombinedChain()` now takes 6 positional parameters (`nimModels`, `mistralModels`, `hasNimKey`, `hasMistralKey`, `customModel?`, `hasCustomKey?`). Callers must pass `undefined` placeholders to skip optional params. The test file already shows the bug risk — positional args are easy to swap.
- **Fix**: Refactor to a single options object: `{ nimModels, mistralModels, hasNimKey, hasMistralKey, customModel?, hasCustomKey? }`.
  - Strength: Self-documenting call sites, no placeholder risk, easy to extend later.
  - Tradeoff: Touches 3 files (definition, call site, tests) but each change is mechanical.
  - Confidence: HIGH — standard refactor with no behavioral change.
  - Blind spot: None significant.
- **Decision**: FIXED — refactored to options object in model-chain.ts, index.ts, model-chain.test.ts

### F3 — hasCustomKey parameter name is misleading

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/model-chain.ts:23
- **Detail**: `hasCustomKey` suggests it checks for an API key, but it actually checks whether `customApiUrl && customModel` are both set (src/index.ts:61: `!!(config.customApiUrl && config.customModel)`). The `custom_api_key` input can be empty for keyless endpoints. A reader seeing `hasCustomKey` would assume the key is being validated.
- **Fix**: Rename to `hasCustomConfig` or `customEnabled` to match actual semantics.
  - Strength: Removes naming confusion; aligns parameter name with what it actually checks.
  - Tradeoff: Minor rename across 3 files.
  - Confidence: HIGH — no behavioral change.
  - Blind spot: None significant.
- **Decision**: FIXED — renamed to hasCustomConfig in model-chain.ts, index.ts, model-chain.test.ts

### F4 — Missing loadConfig test for custom fields

- **Severity**: WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: src/review.test.ts (no match for custom_api_url/custom_model/custom_api_key)
- **Detail**: The `loadConfig` test block in `src/review.test.ts` does not verify that `custom_api_url`, `custom_model`, or `custom_api_key` inputs are read correctly. The plan's testing strategy explicitly calls for extending the existing `loadConfig` test block. Existing test fixtures include the fields to keep TypeScript happy, but the actual `loadConfig()` function's reading behavior for these fields is untested.
- **Fix**: Add test cases in the `loadConfig` describe block verifying that `core.getInput('custom_api_url')`, `core.getInput('custom_model')`, and `core.getInput('custom_api_key')` are mapped to the correct Config fields.
  - Strength: Catches regressions if input names change; matches the plan's stated testing strategy.
  - Tradeoff: A few lines of test code.
  - Confidence: HIGH — follows the existing test pattern for mistral fields.
  - Blind spot: None significant.
- **Decision**: FIXED — added "loadConfig — custom fields" describe block with 2 tests in review.test.ts

### F5 — shouldExclude / globMatch duplicated across files

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/index.ts:7-20 vs src/review.ts (shouldExclude export)
- **Detail**: `src/index.ts` defines private `globMatch` and `shouldExclude` functions, while `src/review.ts` exports its own `shouldExclude`. The implementations are identical. If one is updated and the other isn't, behavior will silently diverge. This pre-dates the custom-api-support change but is relevant since it touches both files.
- **Fix**: Import `shouldExclude` from `src/review.ts` in `src/index.ts` and remove the local copies.
  - Strength: Single source of truth; prevents divergence.
  - Tradeoff: Minor refactor, no behavioral change.
  - Confidence: HIGH — the exported function is already available.
  - Blind spot: None significant.
- **Decision**: FIXED — removed local globMatch/shouldExclude from index.ts, imported from review.ts

### F6 — BASE_SYSTEM_PROMPT duplicated with subtle difference

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/index.ts:22-31 vs src/review.ts (BASE_SYSTEM_PROMPT)
- **Detail**: Two near-identical copies of the system prompt exist. The `review.ts` version is missing a space: "performance\nproblems" vs "performance problems". Both are used independently (one for combined review, one for per-file review). Consolidation would prevent future drift.
- **Fix**: Extract to a single shared constant in a common module, or have `index.ts` import from `review.ts`.
  - Strength: Single source of truth; fixes the whitespace inconsistency.
  - Tradeoff: Minor refactor.
  - Confidence: HIGH — no behavioral change beyond the whitespace fix.
  - Blind spot: None significant.
- **Decision**: FIXED — exported BASE_SYSTEM_PROMPT from review.ts, imported in index.ts, removed local copy

### F7 — Validation logic not DRY

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/index.ts:35-41
- **Detail**: The validation check at line 35 and the warning check at line 39 evaluate the same condition with inverted polarity (`!(customApiUrl && customModel)` vs `customApiUrl && customModel`). This could be expressed as a single computed boolean, reducing the chance of the two checks drifting out of sync.
- **Fix**: Compute `const hasCustom = !!(config.customApiUrl && config.customModel)` once and reuse.
  - Strength: DRY; prevents the two conditions from diverging.
  - Tradeoff: Minor refactor, no behavioral change.
  - Confidence: HIGH — straightforward extraction.
  - Blind spot: None significant.
- **Decision**: FIXED — extracted hasCustom boolean, reused in validation, warning, client creation, and chain building

## Manual Verification Status

- [ ] 3.3 Custom endpoint used first and model name shown in PR comment — **Pending** (requires running the action with a live endpoint)
