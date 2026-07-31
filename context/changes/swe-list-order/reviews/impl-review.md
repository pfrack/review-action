<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: SWE List Order - Hybrid Model Management

- **Plan**: context/changes/swe-list-order/plan.md
- **Scope**: Phase 1–5 of 5
- **Date**: 2026-07-27
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 2 warnings, 3 observations

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

### F1 — No integration tests despite plan calling for them

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Success Criteria
- **Location**: src/model-history.test.ts, src/bench-reorder.test.ts (no integration test files)
- **Detail**: The plan's Testing Strategy section explicitly calls for integration tests: "Run benchmark on OR with mock catalog → verify new models added" and "Verify two-tier ordering in output". Only unit tests exist (model-history.test.ts, bench-reorder.test.ts). The full discover → benchmark → rank → update flow is untested.
- **Fix A ⭐ Recommended**: Add an integration test that mocks the provider catalog and verifies the full pipeline
  - Strength: Catches regressions in the end-to-end flow; matches the plan's stated testing strategy.
  - Tradeoff: Requires mocking the OpenAIClient and provider catalog, which is non-trivial.
  - Confidence: HIGH — the existing unit tests already mock `fetchSweBenchScores` and file I/O, so the patterns are established.
  - Blind spot: Haven't checked whether the OpenAIClient is easily mockable without refactoring.
- **Fix B**: Remove integration test requirement from the plan and accept unit-only coverage
  - Strength: Minimal effort; unit tests already cover the core logic.
  - Tradeoff: The discover → benchmark → rank → update pipeline could break without detection.
  - Confidence: MEDIUM — depends on how much the pipeline is expected to change.
  - Blind spot: Future changes to bench-entry.ts main() could introduce bugs not caught by unit tests.
- **Decision**: FIXED — added integration test in bench-reorder.test.ts verifying discover → patch scores → rank two-tier → update action.yml pipeline (367 tests pass)

### F2 — loadHistory does not handle malformed JSON

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/model-history.ts:15
- **Detail**: `loadHistory()` calls `JSON.parse(content)` without a try/catch. If the history JSON file is corrupted (e.g., partial write, manual edit), the function will throw an unhandled exception, crashing the benchmark. The function already handles missing files and empty files, but not malformed JSON.
- **Fix**: Wrap `JSON.parse` in a try/catch and return `{}` on parse failure, logging a warning to stderr.
  - Strength: Prevents benchmark crashes from corrupted history files; matches the graceful-degradation pattern used in `fetchSweBenchScores`.
  - Tradeoff: Silent corruption could mask data issues.
  - Confidence: HIGH — identical pattern used in `bench-reorder.ts` `readFetchedScores`.
  - Blind spot: None significant.
- **Decision**: FIXED — wrapped JSON.parse in try/catch with stderr warning in model-history.ts:15

### F3 — SYNTHETIC_REVIEW_PROMPT appears to be leftover debug code

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/bench-entry.ts:13-30
- **Detail**: A hardcoded Go code review prompt (`SYNTHETIC_REVIEW_PROMPT`) is used as the default `BENCH_PROMPT`. This appears to be leftover debug/test code — the prompt contains a Go function `processOrder` that is unrelated to benchmarking model latency. The plan does not mention this prompt. It's not harmful (users can override with `BENCH_PROMPT` env var), but it's confusing for anyone reading the code.
- **Fix**: Replace with a generic benchmark prompt or remove the default entirely (require `BENCH_PROMPT` to be set).
  - Strength: Removes confusion; makes the default behavior clear.
  - Tradeoff: Removing the default would break existing workflows that don't set `BENCH_PROMPT`.
  - Confidence: HIGH — the README documents `BENCH_PROMPT` as configurable.
  - Blind spot: Haven't checked whether any workflows rely on the default prompt.
- **Decision**: FIXED — replaced Go-specific debug prompt with generic Python code review prompt in bench-entry.ts:13

### F4 — patchScoresTable inserts Kilo models in OpenRouter section

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/bench-reorder.ts:521-544
- **Detail**: `patchScoresTable()` finds the marker `// OpenRouter free-tier models (estimated scores)` and inserts new entries before it. When Kilo models are discovered (via the kilocode benchmark job), they are also inserted in the OpenRouter section rather than the Kilo section (`// Kilo free-tier models (estimated scores)`). This is a minor organizational issue — the entries are functionally correct but grouped under the wrong comment.
- **Fix**: Use a provider-specific marker or insert before the appropriate section based on the model ID prefix.
  - Strength: Keeps the scores table organized by provider.
  - Tradeoff: Adds complexity to `patchScoresTable`; requires knowing which provider the models belong to.
  - Confidence: MEDIUM — the function currently doesn't take a provider parameter.
  - Blind spot: Haven't checked whether the workflow passes provider info to `--patch-scores`.
- **Decision**: FIXED — auto-detect provider from model ID prefix in patchScoresTable (kilo-auto/ → Kilo section, else OpenRouter section)

### F5 — Workflow does not set BENCH_SCORES_FILE, losing LLM-matched scores

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architecture
- **Location**: .github/workflows/benchmark.yml:270-307 (OpenRouter job), :347-384 (Kilo job)
- **Detail**: `bench-entry.ts` writes fetched LLM-matched scores either to `BENCH_SCORES_FILE` (if set) or as an HTML comment in stdout. The workflow does not set `BENCH_SCORES_FILE`, so scores go to the HTML comment. But the workflow then uses `grep '^|'` to extract only table rows, stripping the HTML comment. The LLM-matched scores are lost. This is not a functional bug (new models get 0.5 from `SWE_BENCH_SCORES` after `patchScoresTable` runs, matching the plan), but the LLM matching work in `bench-entry.ts` is wasted for ranking purposes.
- **Fix**: Set `BENCH_SCORES_FILE` in the workflow and pass it to `bench-reorder.js` via the `BENCH_SCORES_FILE` env var.
  - Strength: Preserves LLM-matched scores for two-tier ranking; makes the data flow explicit.
  - Tradeoff: Adds a file to the workflow; the scores are currently intentionally unused (plan says new models get 0.5).
  - Confidence: HIGH — the code already supports `BENCH_SCORES_FILE` in both `bench-entry.ts` and `bench-reorder.ts`.
  - Blind spot: Haven't verified that using LLM-matched scores for ranking is desired (plan says "New models get 0.5").
- **Decision**: FIXED — set BENCH_SCORES_FILE: 'fetched-scores.json' in OR and Kilo benchmark + reorder steps in benchmark.yml

## Manual Verification Status

- [ ] 1.3 Verify history JSON loads/saves correctly — **Pending**
- [ ] 2.3 Verify new models discovered and benchmarked — **Pending**
- [ ] 3.3 Verify known models rank above new models — **Pending**
- [ ] 4.3 Verify action.yml and SWE_BENCH_SCORES updated — **Pending**
- [ ] 5.3 Full end-to-end test: discover → benchmark → rank → commit — **Pending**
