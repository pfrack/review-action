<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Daily Model Recheck + Auto-Scoring

- **Plan**: context/changes/model-recheck/plan.md
- **Scope**: Phase 4 of 4 (full review)
- **Date**: 2025-07-21
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 3 warnings, 4 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | WARNING |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Findings

### F1 — New transient failures lost by recheck overwrite

- **Severity**: WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; models that fail today may not persist to retry tomorrow
- **Dimension**: Plan Adherence
- **Location**: src/bench-entry.ts:278-319

- **Detail**:
  The recheck section reads `removedModels` from the file (line 283) *before* processing `transientFailed`. New failures are appended at line 278, but `writeRemovedModels(stillFailed)` at line 319 overwrites the entire file with only the recheck results. Models that failed the initial benchmark but weren't in the previous day's `removedModels` list are silently dropped.

  Scenario: File is empty. Model-A fails benchmark → appended (line 278). Recheck reads file (line 283) → finds Model-A. Model-A passes probe but fails benchmark → goes to `stillFailed` → written back. Model-A survives.

  Scenario 2: File has Model-X. Model-A fails benchmark → appended. Recheck reads file → finds [Model-X, Model-A]. Model-X recovers. Model-A fails probe → goes to `stillFailed`. `stillFailed` = [Model-A]. Written back. Model-A survives.

  The bug only manifests if a model is appended *after* the recheck read but *before* the write — which can't happen in the current sequential flow. However, the code structure is fragile: reordering the two blocks would silently introduce data loss.

- **Fix A ⭐ Recommended**: Merge `transientFailed` into `stillFailed` before writing, so the final write includes both new failures and recheck failures atomically.
  - Strength: Makes the invariant explicit — `stillFailed` is the single source of truth for what to keep.
  - Tradeoff: One extra line of code.
  - Confidence: HIGH — straightforward fix.
  - Blind spot: None significant.

- **Fix B**: Move the append after the recheck, so the recheck only processes pre-existing entries.
  - Strength: Cleaner separation of concerns.
  - Tradeoff: New failures from today's run don't get a same-day recheck chance.
  - Confidence: MEDIUM — changes the intended behavior slightly.
  - Blind spot: The plan doesn't explicitly specify whether new failures should be rechecked in the same run.

- **Decision**: FIXED — merged transientFailed into stillFailed before writeRemovedModels

### F2 — fetchSweBenchScores test doesn't verify parsing

- **Severity**: WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: src/bench-reorder.test.ts:253-298

- **Detail**:
  Plan §3.5 requires "Unit test: fetchSweBenchScores() parses API response correctly." The test creates a mock server but can't inject the URL into the hardcoded fetch call, so it only verifies graceful degradation (returns an array). The mock server is effectively dead code.

- **Fix**: Add a test that imports and calls the parsing logic directly, or refactor fetchSweBenchScores to accept a URL parameter for testability.
  - Strength: Fulfills the plan's test requirement.
  - Tradeoff: Minor refactoring needed.
  - Confidence: HIGH.
  - Blind spot: None.

- **Decision**: FIXED — extracted parseSweBenchResponse with 5 unit tests

### F3 — TOCTOU race in appendRemovedModels

- **Severity**: WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/removed-models.ts:22-26

- **Detail**:
  `appendRemovedModels` reads the file, deduplicates, then appends. This read-then-append is non-atomic. Protected in practice by CI concurrency groups and separate file paths for NIM vs Mistral, but the function API doesn't enforce single-writer semantics.

- **Fix**: Add a comment documenting the single-writer requirement, or switch to atomic read-all/dedup/write-all (like `cleanupRemovedModels` already does).
  - Strength: Documents the invariant or removes the race entirely.
  - Tradeoff: Trivial either way.
  - Confidence: HIGH.
  - Blind spot: None.

- **Decision**: FIXED — switched to atomic read-all/dedup/write-all

### F4 — HTML comment data channel not documented in plan

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: src/bench-entry.ts:332-337, src/bench-reorder.ts:272-286

- **Detail**:
  Fetched scores are passed between bench-entry.ts and bench-reorder.ts via an HTML comment (`<!-- FETCHED_SCORES: {...} -->`) in stdout. This inter-script communication mechanism is not described in the plan. It works correctly but is a fragile coupling — if the table format ever includes HTML comments, the regex could break.

- **Decision**: SKIPPED

### F5 — matchModelScore() has no unit test

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: src/bench-entry.ts:61-83

- **Detail**:
  Plan §3.5 lists "Unit test: matchModelScore() returns correct score for known NIM models" but no test exists. The function depends on OpenAIClient.chat() which makes HTTP calls, making it harder to unit test without mocking. The function is exercised indirectly through the integration flow but lacks direct coverage.

- **Decision**: SKIPPED

### F6 — getRemovedModelsPath exported but untested

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/removed-models.ts:3-5

- **Detail**:
  `getRemovedModelsPath` is exported but never exercised by any test — every test passes an explicit path. Compare with `bench-reorder.ts:89` where `parseDuration` is not exported despite being a similar internal helper.

- **Decision**: SKIPPED

### F7 — removed-models.test.ts duplicates classification logic

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/removed-models.test.ts:92-108

- **Detail**:
  The test "models not in provider catalog are NOT written to removed-models.txt" duplicates the classification logic from `bench-entry.ts:270` rather than testing `removed-models.ts` functions directly. It's a useful integration assertion but lives in the wrong test file and could confuse readers about what module is under test.

- **Decision**: SKIPPED
