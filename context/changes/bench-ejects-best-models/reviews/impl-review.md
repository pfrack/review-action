<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: bench-ejects-best-models

- **Plan**: context/changes/bench-ejects-best-models/plan.md
- **Scope**: Full re-review (all 6 phases). Prior review at HEAD `20b93ff` found 5 WARNINGs (F1–F5); this pass verifies their committed resolution in `7cdfb0d` + the Phase 6 workflow split (`0948114`).
- **Date**: 2026-08-06
- **Verdict**: APPROVED
- **Findings**: 0 critical | 0 warnings | 2 observations
- **Automated checks**: `npm run build` green; `npm test` 586/586 pass (bench-reorder 69/69, bench-entry 28/28); 5 workflow YAMLs valid; `benchmark.yml` removed; `grep "moved to the front" README.md` → not found.

## Verdicts

| Dimension | Verdict | Notes |
|---|---|---|
| Plan Adherence | PASS | Phases 1–6 implemented as planned; F1–F5 follow-up fixes applied and verified; success criteria met. |
| Scope Discipline | PASS | No scope creep; OR/Kilo removed-models files preserved; runtime chain (index.ts/model-chain.ts/review.ts) untouched. |
| Safety & Quality | PASS | Concurrency validated (no `i+=0` hang); three-way classifier correct; `--force-with-lease` + fail-fast on all push paths. |
| Architecture | PASS | `classifyFailedModels` extracted as pure exported function; `mapWithConcurrency` reused for both batches; catalog-driven re-admission cleanly separated from file-based recheck. |
| Pattern Consistency | PASS | Both inconsistencies resolved during triage (BENCH_ITERATIONS validation; workflow pull guards). |
| Success Criteria | PASS | Build + 586/586 tests green; YAML valid; benchmark.yml removed; README greps clean. |

## Findings

### O1 — `BENCH_ITERATIONS` bypasses `parsePositiveIntEnv` validation

- **Severity**: ⚠️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped. Pre-existing (not introduced by this change).
- **Dimension**: Pattern Consistency
- **Location**: src/bench-entry.ts:445-451
- **Detail**: The F1 fix standardized concurrency env parsing via `parsePositiveIntEnv` (used for `BENCH_CONCURRENCY`, `BENCH_READMIT_LIMIT`, `BENCH_RECHECK_CONCURRENCY`), but `BENCH_ITERATIONS` (445-451) still uses bare `parseInt` + `isNaN` only — it does not reject `0` or negatives. A misconfiguration to `0` makes `allFailed = errCount === iterations` evaluate `errCount === 0` (always true), misclassifying every model as all-failed. Currently a non-issue because every workflow hardcodes `BENCH_ITERATIONS: '1'`.
- **Fix**: Switch `BENCH_ITERATIONS` to `parsePositiveIntEnv('BENCH_ITERATIONS', 2)` for consistency.
  - Strength: One-line change; matches the pattern the F1 fix just established for the other env vars.
  - Tradeoff: Default changes from implicit `2` to explicit `2` — behavior identical.
  - Confidence: HIGH — identical call pattern already in use.
  - Blind spot: None significant.
- **Decision**: FIXED — switched to `parsePositiveIntEnv('BENCH_ITERATIONS', 2)` (one line; verified build green + bench-entry tests pass after change).

### O2 — Workflow rebase error-handling inconsistency (Groq/Mistral vs NIM/OR/Kilo)

- **Severity**: ⚠️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; cosmetic, not a safety gap.
- **Dimension**: Pattern Consistency
- **Location**: .github/workflows/benchmark-groq.yml:72,78; .github/workflows/benchmark-mistral.yml:65,71 (vs benchmark-nim.yml:72-76, benchmark-openrouter.yml:93-97, benchmark-kilocode.yml:93-97)
- **Detail**: F4 hardened push safety across all 5 split workflows (`--force-with-lease` everywhere; rebase conflicts fail the job). NIM/OpenRouter/Kilocode use an explicit `if ! git pull --rebase origin main; then echo "..."; git rebase --abort; exit 1; fi`. Groq and Mistral use a bare `git pull --rebase origin main` relying on GHA's default `set -e` to fail the step. Functionally equivalent for safety (a failing pull aborts the step before the force-with-lease push, so no clobbering occurs), but inconsistent: Groq/Mistral do not emit the friendly "Rebase conflict — aborting… Next run will pick up changes." message and never call `git rebase --abort`.
- **Fix**: Replace the bare `git pull --rebase origin main` lines in Groq/Mistral with the same explicit guarded block used by NIM/OR/Kilo (or, to reduce duplication, extract a shared `reorder-and-push` composite action).
  - Strength: Matches the pattern in 3 sibling workflows; gives operators a clear failure message.
  - Tradeoff: Minor extra YAML lines; a shared composite action would need a new file.
  - Confidence: HIGH — the guarded block is duplicated verbatim in NIM/OR/Kilo already.
  - Blind spot: Hasn't been run against an actual concurrent-push conflict in CI.
- **Decision**: FIXED — guarded both bare `git pull --rebase` calls in benchmark-groq.yml (lines 72, 82) and benchmark-mistral.yml (lines 72, 82) with the `if ! … exit 1; git rebase --abort` block; all 5 workflow YAMLs re-validated as parseable; no bare pulls remain.

### O3 — Flaky probe-order assertion under concurrent probing (discovered during final verification)

- **Severity**: ⚠️ OBSERVATION
- **Impact**: 🏃 LOW — test-only fragility; production `mapWithConcurrency` preserves result order correctly.
- **Dimension**: Success Criteria / Test Hygiene
- **Location**: src/bench-entry.test.ts:503-504
- **Detail**: The `readmitCatalogModels` re-admission test asserts `probeOrder[0] === 'mistralai/mistral-large'` and `probeOrder[1] === 'nvidia/nemotron-3-super-120b-a12b'` while the function probes candidates concurrently (default `concurrency: 3`). `probeOrder` is populated in the mock server's request handler, so its entries reflect HTTP-request *arrival* order within a `Promise.all` batch — non-deterministic under load. The test passes 28/28 in isolation but flaked once under the parallel full-suite run (`npm test`: 1 failure, then 586/586 on re-run). The production code is correct (`mapWithConcurrency` preserves result order); only the test's assertion of *call* order is fragile.
- **Fix A ⭐ Recommended**: Assert on the candidates list order directly (before probing) or sort `probeOrder` before comparing — verifies score-desc ranking without depending on arrival order.
  - Strength: Removes fragility; still verifies candidate ranking.
  - Tradeoff: Slightly weaker — asserts selection order, not probe dispatch order.
  - Confidence: HIGH — the order source is `candidates.sort((a,b)=>b[1]-a[1])` (bench-entry.ts:162), which is deterministic.
  - Blind spot: None significant.
- **Fix B**: Run this test with `concurrency: 1` to make probe order deterministic.
  - Strength: Minimal change to the existing assertion.
  - Tradeoff: Loses concurrency coverage for the order check (the sibling test at line 507 already covers concurrency bounds).
  - Confidence: HIGH.
  - Blind spot: Doesn't catch future regressions in concurrent probe-dispatch ordering.
- **Decision**: FIXED — replaced order-dependent `probeOrder[0]/[1]` strictEqual assertions with a set-equality check (`deepStrictEqual([...probeOrder].sort(), …)`); rebuild + 3 consecutive full-suite runs at 586/586, 0 flake.

## Prior Review Findings (F1–F5) — Resolved & Verified

The prior review (HEAD `20b93ff`) flagged 5 WARNINGs. All are present in `7cdfb0d` and verified here:

- **F1 — concurrency validation**: `parsePositiveIntEnv` added (bench-entry.ts:13-18), applied to all 3 concurrency envs (455, 496, 621). Verified: `mapWithConcurrency` (44-56) cannot receive `0`/`NaN`. ✓
- **F2 — classifyFailedModels extracted**: exported (73-97), consumed in `main()` (517-521); 6 unit tests (bench-entry.test.ts:188-259). Verified: 28/28 bench-entry tests pass. ✓
- **F3 — README probe claim**: README.md:75 reads "diagnostic only: it never reorders the chain"; README.md:309 confirms log-only. `grep "moved to the front"` → absent. ✓
- **F4 — workflow force-push hardening**: all 5 workflows use `--force-with-lease`; amend path force-pushes, new-commit path plain-pushes; rebase conflicts fail the job. ✓
- **F5 — shape-notes checkpoint**: shape-notes.md:16-17 carries `status: "implemented"` + `implemented_in` matching `main`. ✓

## Carry-forward Note (O1 from prior review — probe timeout)

The prior review's probe-timeout observation (probeModel uses the 180s default via `chat()`, not 30s) remains valid. This is by-design for the current behavior (minimax-m3 at 47.8s passes the probe → demoted-but-kept, ranked by effective score), so it is not flagged as a finding — a dedicated probe timeout would improve latency but is a perf enhancement, not a correctness gap.

## Triage Summary

```
═══════════════════════════════════════════════════════════
  TRIAGE COMPLETE
═══════════════════════════════════════════════════════════

  Fixed:     O1, O2, O3      (3)
  Skipped:   —               (0)
  Accepted:  —               (0)

  All 5 prior findings (F1–F5) verified resolved + committed in 7cdfb0d.
  Phase 6 workflow split verified (5 YAMLs valid, benchmark.yml removed).
  Final state: 586/586 tests pass (3 consecutive runs, 0 flake); npm run build green.
═══════════════════════════════════════════════════════════
```
