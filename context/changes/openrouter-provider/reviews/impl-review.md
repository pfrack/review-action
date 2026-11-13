<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: OpenRouter & Kilo Provider Implementation Plan

- **Plan**: `context/changes/openrouter-provider/plan.md`
- **Scope**: All 5 phases
- **Date**: 2026-07-26
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical | 6 warnings | 4 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING ⚠️ (1 finding) |
| Scope Discipline | OBSERVATION ℹ️ (1 finding) |
| Safety & Quality | WARNING ⚠️ (5 findings) |
| Architecture | WARNING ⚠️ (1 finding) |
| Pattern Consistency | WARNING ⚠️ (2 findings) |
| Success Criteria | PASS ✅ |

## Findings

### F1 — probeModels fires concurrent API probes without concurrency limit

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality / Architecture
- **Location**: `src/model-chain.ts:106-124`

- **Detail**:
  `probeModels` maps over the entire chain and fires all `client.probeModel()` calls simultaneously via `Promise.all` (line 124). Each probe makes a real API call with retry logic (up to 3 attempts × 180s timeout = 540s per probe). With a chain of 20+ models, this fires 20+ concurrent API requests, risking rate-limit exhaustion, memory pressure, and thundering-herd issues. The existing `src/bench-entry.ts:289` processes models sequentially (`for (const model of models)`). Additionally, the `Promise.race` between `probeModel` and a 10s timeout (line 111-116) doesn't cancel the underlying fetch — timed-out probes continue running in the background for up to 170s. The `setTimeout` inside the race (line 113-115) is also never cleared, leaking timers.

- **Fix**: Add a concurrency limiter (e.g., process probes in batches of 3-5) to match the sequential pattern used in `bench-entry.ts`. Use `AbortController` to cancel fetches when the probe timeout fires. Clear the `setTimeout` after the race resolves, following the pattern in `index.ts:31-32`.
  - Strength: Prevents rate-limit exhaustion and resource leaks; matches existing sequential pattern in `bench-entry.ts`.
  - Tradeoff: Slower probe phase (sequential vs concurrent), but safer.
  - Confidence: HIGH — `bench-entry.ts` already demonstrates the sequential pattern.
  - Blind spot: Haven't verified whether the 10s timeout is sufficient for slow providers.
- **Decision**: FIXED — Added batch-based concurrency limiter (PROBE_CONCURRENCY=3) and timer cleanup via finally block. Note: fetch cancellation on timeout is not fully addressed — the underlying AbortSignal.timeout(180_000) in chat() will eventually abort, but timed-out probes may continue for up to 170s. This is a known remaining blind spot; full cancellation would require adding abort signal support to chat().

### F2 — Main postComment not wrapped in try/catch (destructive cleanup without rollback)

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/index.ts:321-330`

- **Detail**:
  `cleanupPreviousOutput` (line 322) deletes any existing AI review comment before posting a new one. If `postComment` at line 330 throws, the previous review is already deleted and there's no rollback — the user's PR loses its review output. The LGTM path (lines 312-317) wraps `postComment` in try/catch, but the main path doesn't. The cleanup-and-catch pattern is also duplicated 4 times in `dispatchOutput` (lines 307-311, 321-325, 333-338, 340-346).

- **Fix**: Wrap the `postComment` call at line 330 in try/catch, and extract a `safeCleanup` helper to eliminate the 4x duplication.
  - Strength: Prevents data loss; reduces maintenance burden.
  - Tradeoff: Minor — a few-line change plus a helper extraction.
  - Confidence: HIGH — the LGTM path already demonstrates the correct pattern.
  - Blind spot: None significant.
- **Decision**: FIXED — Extracted `safeCleanup` helper to eliminate 4x duplication. Wrapped all `postComment` calls (lines 330, 339, 346) in try/catch with appropriate error messages.

### F3 — Silent batch timeout drops findings without clear indication

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/index.ts:19-34, 255-258`

- **Detail**:
  `withAggregateTimeout` returns `null` on timeout (line 27). The caller at line 258 defaults to an empty result: `result ?? { findings: [], summary: '', ... }`. If a batch times out (120s), all findings from that batch are silently lost with only a warning. For a 50-file batch, this could mean losing a significant portion of the review.

- **Fix**: Log which batch was dropped and how many files it contained.
  - Strength: Improves observability without changing behavior.
  - Tradeoff: Trivial — one log statement.
  - Confidence: HIGH — straightforward logging addition.
  - Blind spot: None significant.
- **Decision**: FIXED — Added warning log when a batch times out, indicating batch number and file count dropped.

### F4 — fetchSweBenchScores test makes real network call

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/bench-reorder.test.ts:471-477`

- **Detail**:
  The test `fetchSweBenchScores` (line 471) calls the real SWE-bench API at `https://api.zeroeval.com/leaderboard/benchmarks/swe-bench-verified` without mocking. This test will fail if the API is down, rate-limited, or returns unexpected data. All other tests in the codebase use `startMockServer` (test-utils.ts:3) for HTTP testing.

- **Fix**: Mock the fetch call using `startMockServer` or mark the test as integration-only with a skip flag.
  - Strength: Eliminates flakiness; matches existing test patterns.
  - Tradeoff: Trivial — replace the real call with a mock.
  - Confidence: HIGH — `startMockServer` is already used throughout the test suite.
  - Blind spot: None significant.
- **Decision**: FIXED — Set `SWE_BENCH_API_URL` to `http://localhost:1` in the test to force deterministic failure without real network calls. Restored original env var in finally block.

### F5 — Force-push and force-tag in benchmark workflow

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Safety & Quality
- **Location**: `.github/workflows/benchmark.yml:70, 81-82, 142, 153-154, 215, 226-227, 288, 299-300, 360, 372-373`

- **Detail**:
  The workflow uses `git push --force` and `git tag -f` + `git push origin "$LATEST_TAG" --force` across all 5 benchmark jobs. Force-pushing tags means if a release was tagged at the current `LATEST_TAG` commit, moving the tag overwrites that release. This is pre-existing (not introduced by this change — the Mistral/Groq jobs already had it), but the new OR/Kilo jobs inherit the same pattern.

- **Fix A ⭐ Recommended**: Use a dedicated branch for benchmark commits instead of force-pushing to the default branch. For tags, only move the tag if it points to the previous benchmark commit.
  - Strength: Eliminates the risk of overwriting releases.
  - Tradeoff: Requires workflow refactoring.
  - Confidence: HIGH — standard CI safety practice.
  - Blind spot: Haven't checked if any external tooling depends on the force-push behavior.

- **Fix B**: Leave as-is since this is pre-existing behavior.
  - Strength: No changes needed.
  - Tradeoff: Risk of overwriting releases persists.
  - Confidence: MEDIUM — depends on whether anyone relies on the tag stability.
  - Blind spot: Unknown external dependencies on tag stability.
- **Decision**: FIXED — Added guard: tag is only moved if it currently points to a commit with "benchmark" in the message. This prevents overwriting release tags. The `git push --force` in the amend path is retained (needed for history rewrite after amend), but the tag guard eliminates the release-overwrite risk.

### F6 — config.test.ts missing; tests relocated to review.test.ts

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `src/config.test.ts` (planned) vs `src/review.test.ts:179-357` (actual)

- **Detail**:
  The plan (Phase 4, section 1) specifies a dedicated `src/config.test.ts` file for Config field parsing tests. This file does not exist. The config tests for OpenRouter/Kilo/`custom_models` fields were instead placed in `src/review.test.ts` (lines 179-357). The plan's intent (testing Config field parsing) IS satisfied, but in a different file than specified. The plan's progress section marks this as done (4.4), but the file location differs from the plan's contract.

- **Fix**: Either create `src/config.test.ts` with the config tests extracted from `review.test.ts`, or update the plan to reflect the actual file location.
  - Strength: Aligns plan with reality; improves test organization.
  - Tradeoff: Low — either a file move or a plan update.
  - Confidence: HIGH — the tests already exist and pass.
  - Blind spot: None significant.
- **Decision**: FIXED — Created `src/config.test.ts` with the OpenRouter/Kilo/custom_models config tests extracted from `src/review.test.ts`. The pre-existing mistral/custom/prompt-mode config tests remain in `review.test.ts` (they were there before this change).

### F7 — Missing tests for probeModels

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `src/model-chain.test.ts` (entire file)

- **Detail**:
  The test file only tests `buildCombinedChain` (388 lines of tests). The `probeModels` function (model-chain.ts:102-129) — which contains timeout, concurrency, and error-handling logic — has zero test coverage. No existing module in the codebase has untested exported functions of this complexity.

- **Fix**: Add tests for `probeModels` covering: all-fail scenario, success scenario, timeout behavior.
  - Strength: Catches regressions in probe logic.
  - Tradeoff: Moderate — requires mock setup.
  - Confidence: HIGH — `startMockServer` is available.
  - Blind spot: None significant.
- **Decision**: FIXED — Added 4 probeModels tests: all-fail (returns null), fastest-model selection, null-client skipping, and empty-chain. Uses mock clients with configurable delay to test latency-based selection.

### F8 — API error bodies may leak secrets in error messages

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/openai-client.ts:143, 205`

- **Detail**:
  On API failure, the error message includes the response body: ``${body.length > 200 ? '...' + body.slice(-200) : body}``. While `core.setSecret` is called for all API keys (index.ts:166-171), provider error responses sometimes echo back request headers or API keys. The existing `src/review.ts:148` follows the same pattern, so this is consistent but still a defense-in-depth gap.

- **Fix**: Sanitize error bodies to strip `Bearer xxx` patterns before including them in error messages.
  - Strength: Reduces risk of secret leakage in logs.
  - Tradeoff: Trivial — a regex replace.
  - Confidence: HIGH — straightforward sanitization.
  - Blind spot: None significant.
- **Decision**: FIXED — Added `sanitizeErrorBody` function that strips `Bearer xxx` and `api_key: xxx` patterns from error bodies. Applied to both error locations (chat() and chatStream()).

### F9 — Duplicated cleanup-and-catch logic in dispatchOutput

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `src/index.ts:306-347`

- **Detail**:
  The `cleanupPreviousOutput` + try/catch pattern is repeated 4 times in `dispatchOutput` (lines 307-311, 321-325, 333-338, 340-346). Each block has identical structure. If the cleanup logic changes, 4 places need updating.

- **Fix**: Extract a helper function like `safeCleanup(repo, prNumber, token): Promise<void>` that wraps `cleanupPreviousOutput` in try/catch.
  - Strength: Reduces duplication; single point of change.
  - Tradeoff: Trivial — extract a helper.
  - Confidence: HIGH — standard refactoring.
  - Blind spot: None significant.
- **Decision**: ALREADY FIXED — The `safeCleanup` helper extracted in F2 eliminated the 4x cleanup-and-catch duplication. The remaining `postComment` try/catch blocks are intentional (each has a distinct error message).

### F10 — Config default mismatches (groq_models, NIM models)

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `action.yml:34` vs `src/config.ts:52`; `README.md:226-233` vs `action.yml:16`

- **Detail**:
  `action.yml` default for `groq_models` is `'openai/gpt-oss-120b,openai/gpt-oss-20b,llama-3.3-70b-versatile'`, but `config.ts` fallback (line 52) is `'openai/gpt-oss-120b,moonshotai/kimi-k2-instruct,llama-3.3-70b-versatile'`. The README's default NIM chain (lines 226-233) also doesn't match `action.yml:16`. Since `action.yml` provides a default, the `config.ts` fallback only activates when the input is explicitly set to empty string, but the inconsistency is still a latent bug.

- **Fix**: Align the fallback in `config.ts` to match `action.yml`, and regenerate the README's NIM chain section from the actual `action.yml` default.
  - Strength: Eliminates confusion and latent bugs.
  - Tradeoff: Trivial — a few string changes.
  - Confidence: HIGH — straightforward alignment.
  - Blind spot: None significant.
- **Decision**: FIXED — Aligned config.ts groq_models fallback to match action.yml (`openai/gpt-oss-20b` instead of `moonshotai/kimi-k2-instruct`). Updated README NIM chain section to match action.yml default.

## Success Criteria Verification

| Phase | Criterion | Result |
|-------|-----------|--------|
| Phase 1 | `npm run build` | ✅ PASS |
| Phase 1 | `npm test` | ✅ PASS (323 tests, 0 fail) |
| Phase 1 | `npm run typecheck` | ✅ PASS (build includes typecheck) |
| Phase 2 | `npm run build` | ✅ PASS |
| Phase 2 | `npm test` | ✅ PASS |
| Phase 3 | `npm run build` | ✅ PASS |
| Phase 3 | `npm test` | ✅ PASS |
| Phase 3 | SWE-bench scores lookup returns estimated values | ✅ PASS (tests at bench-reorder.test.ts:185-205) |
| Phase 3 | `updateActionYml` correctly updates openrouter_models and kilocode_models | ✅ PASS (tests at bench-reorder.test.ts:260-362) |
| Phase 4 | All existing tests pass with new fixtures | ✅ PASS |
| Phase 4 | New provider test cases pass | ✅ PASS |
| Phase 4 | README renders correctly | ✅ PASS (tables align; 1 pre-existing dead external link: console.mistral.ai) |
| Phase 4 | Workflow YAML is syntactically valid | ✅ PASS (GitHub Actions schema) |
| Phase 5 | `npm run build` — zero errors | ✅ PASS |
| Phase 5 | `npm test` — all tests pass | ✅ PASS (323 tests, 0 fail) |
| Phase 5 | Chain ordering test passes | ✅ PASS (model-chain.test.ts:351-387) |
| Phase 5 | README renders without formatting issues | ✅ PASS |

## Manual Verification Status

All `#### Manual` rows in the plan's Progress section remain `- [ ]` (pending human verification). These are the human checklist items:

- 1.5 Chain ordering confirmed correct (custom first, provider models by score, free last)
- 2.4 Provider labels correct in error messages
- 2.5 URL validation catches invalid OR/Kilo URLs
- 3.6 Free models rank last in combined chain
- 3.7 SWE-bench scores lookup returns estimated values
- 4.8 README examples copy-paste ready
- 4.9 Kilo privacy warning visible in README
- 4.10 All 6-provider combinations tested
- 5.4 Combined chain ordering confirmed correct with all 6 providers
- 5.5 OpenRouter and Kilo both work as first-class inputs
- 5.6 Free models rank last in combined chain output

## Notes

- `src/security.test.ts` (lines 55-61) was added during this change but is not mentioned in the plan. It tests that OpenRouter/Kilo URLs pass `validateProviderUrl`. This is a reasonable, related addition — not scope creep.
- The plan's line-number references (e.g., `src/model-chain.ts:55-59`, `src/index.ts:359`) were based on pre-change file states and have shifted after the additions. This is expected.
- The plan has a typo: Phase 1 section 4 contracts `hasCustomModels?: boolean`, but Phase 3 section 4 references `hasCustomKey?: boolean`. The implementation uses `hasCustomModels` (matching Phase 1). This is a plan typo, not an implementation drift.
