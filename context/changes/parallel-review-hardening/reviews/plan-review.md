<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Pipeline Hardening Implementation Plan

- **Plan**: `context/changes/parallel-review-hardening/plan.md`
- **Brief**: `context/changes/parallel-review-hardening/plan-brief.md`
- **Mode**: Deep
- **Date**: 2026-08-02
- **Verdict**: REVISE
- **Findings**: 1 critical, 1 warning, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | PASS |
| Architectural Fitness | PASS |
| Blind Spots | WARNING (1 finding) |
| Plan Completeness | FAIL (1 finding) |

## Grounding
Grounding: 9/9 paths ✓, 5/5 symbols ✓, brief↔plan ✓

## Findings

### F1 — Phase 1.3 has Intent but no Contract: implementer has no specification

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Completeness
- **Location**: Phase 1.3 — Guard undefined `usage` and `finishReason`

Detail:
Section 1.3 states the intent ("Prevent downstream crashes when a
provider omits `usage` or `finish_reason`…") but provides **no
Contract** — no file:line target, no specified defaults. Every other
Phase-1 section (1.1 error-type swap, 1.2 jitter formula, 1.4 try/catch
shape, 1.5 log text) has a concrete Contract. The implementer must guess
how to default `usage` (zeroed object? null?) and `finishReason` (null?
'stop'?). Two success criteria depend on this (1.6, 1.7) but the actual
code change is unspecified. The plan does state the *expected return*
("returns `finishReason: null`" in the success criteria), but not the
*implementation*.

Fix: Add a concrete Contract line under 1.3:
  In `openai-client.ts:361-366`, default `usage` to
  `{ completion_tokens: 0, prompt_tokens: 0, total_tokens: 0 }` and
  `finishReason` to `null`. Note that `index.ts:133` and `:175`
  `finishReason === 'length'` checks already handle `null` safely
  (evaluates false → no false truncation), and `bench.ts:59,65`
  `chatResult.usage.completion_tokens` will read `0` instead of
  crashing.
  - Strength: Consistent with the success-criteria expectations already written.
  - Tradeoff: None — defaults are non-controversial, and the downstream consumers are already surveyed.
  - Confidence: HIGH — plan already states the desired return values; this just pins the implementation.
  - Blind spot: None significant.
- **Decision**: FIXED — Added concrete Contract specifying defaults at `openai-client.ts:361-366`, referencing the existing `ChatCompletionUsage` type shape.

### F2 — Benchmark-path `.json()` parses are unguarded despite hardening goal

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 3.1 — `.json()` guard scope (github-review.ts only)

Detail:
The change's stated goal is to harden benchmark/CLI paths ("those are the
paths that most need retry — leaderboard/SWE-bench APIs are flaky"). Phase
3.1 guards `.json()` parses only in `github-review.ts`, but the two
benchmark callers have the **identical** crash-prone pattern:
- `bench-reorder.ts:66` — `const data = await resp.json() as SweBenchApiResponse`
  (inside `fetchSweBenchScores`, after a successful `withRetry` on a 200)
- `swe-resolver.ts:34` — `const data = await resp.json() as { models?: … }`
  (inside `fetchLeaderboard`, after a successful `withRetry` on a 200)

Both fetch from the flaky SWE-bench leaderboard API. Phase 1.1 fixes the
*dead retry* (fetch now retries on 5xx), but a 200-with-HTML-body
(maintenance page, proxy error) still crashes at `.json()` — the exact
failure the `.json()` guard exists to prevent in github-review.ts.
Leaving these unguarded breaks the consistency of the hardening for the
paths the plan explicitly says are the priority.

Fix A ⭐ Recommended: Extend the `.json()` guard pattern to
  `bench-reorder.ts:66` and `swe-resolver.ts:34` — wrap in try/catch,
  throw `RetryableError` with status 502 on parse failure. This matches
  the pattern already established for github-review.ts in Phase 3.1 and
  the pattern already used at `openai-client.ts:326`
  (`throw new RetryableError('…non-JSON response', 502)`).
  - Strength: Consistent; covers all flaky-API `.json()` sites; the 502 pattern already exists in the codebase.
  - Tradeoff: Two more files + 2 more tests.
  - Confidence: HIGH — exact pattern exists in `openai-client.ts:326`.
  - Blind spot: None significant.

  Fix B: Leave benchmark-path `.json()` unguarded; document that a
  non-JSON 200 from the leaderboard API is treated as a hard failure
  (acceptable because `fetchSweBenchScores` already catches errors at
  `bench-reorder.ts:69` and returns a degraded result, and
  `fetchLeaderboard` is wrapped by callers).
  - Strength: Fewer files touched.
  - Tradeoff: Inconsistent — github-review.ts gets the guard but the flakeier benchmark APIs don't.
  - Confidence: MEDIUM — depends on downstream error handling that hasn't been fully traced.
  - Blind spot: Whether `fetchSweBenchScores`'s catch block (line 69+)
    degrades gracefully or silently returns empty is unverified.
- **Decision**: FIXED — Applied Fix A: extended the `.json()` guard to
  `bench-reorder.ts:66` and `swe-resolver.ts:34`. Updated Phase 3.1
  Contract with corrected call-site count (3 in github-review, 2 in
  benchmark paths), added Success Criteria test for benchmark `.json()`
  failures, and updated Progress section (3.3-3.7+).

### F3 — `.json()` call-site count for github-review.ts is inaccurate

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 3.1 (lines 203, 26)

Detail:
The plan states "the other 6 call sites in `github-review.ts`" (line 26)
and lists "~100, ~131, ~171, ~264, ~300" (line 203). Grep for `\.json()`
in `github-review.ts` finds **3** call sites, not 7:
  - Line 100: `const data = await resp.json() as { id: number }`
  - Line 137: `const reviews = await resp.json() as { id: number; body?: string }[]`
  - Line 264: `const comments = await resp.json() as { id: number; body: string }[]`

There are no `.json()` calls at ~131, ~171, or ~300. The "7 total" figure
inflates the blast radius; the fix count is 3, not 7.

Fix: Correct the count and line numbers in Phase 3.1 and the Current
State Analysis. (Phase 3.1 Contract corrected to 3 read sites + 2
benchmark-path sites; Current State Analysis line 26 updated.)
- **Decision**: FIXED — Corrected call-site count in Phase 3.1 Contract
  (3 github-review read sites, not ~7) and Current State Analysis line 26
  (now lists `github-review.ts:137`, `:264`, `bench-reorder.ts:66`,
  `swe-resolver.ts:34`).
