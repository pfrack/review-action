<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: First-Class Mistral Support

- **Plan**: context/changes/mistral-support/plan.md
- **Scope**: Phase 5 of 5 (all phases complete)
- **Date**: 2026-07-19
- **Verdict**: APPROVED (all findings fixed)
- **Findings**: 2 critical, 2 warnings, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS ✅ |
| Scope Discipline | PASS ✅ |
| Safety & Quality | PASS ✅ |
| Architecture | PASS ✅ |
| Pattern Consistency | PASS ✅ |
| Success Criteria | PASS ✅ |

## Plan Adherence Summary

All 7 planned changes match their implementation exactly:

| Plan Item | Verdict |
|-----------|---------|
| action.yml: mistral_api_key, mistral_models inputs, nim_api_key optional | MATCH |
| src/review.ts: Config, loadConfig, reviewFileWithFallback | MATCH |
| src/index.ts: Combined fallback loop | MATCH |
| src/model-chain.ts: TaggedModel, Provider, buildCombinedChain | MATCH |
| src/bench-reorder.ts: Mistral scores, updateActionYmlMistral, ACTION_TARGET | MATCH |
| benchmark.yml: benchmark-mistral job | MATCH |
| README.md: Mistral documentation | MATCH |

## Findings

### F1 — benchmark-mistral job never runs
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌

Severity:  ❌ CRITICAL
Impact:    🏃 LOW — fix is obvious and narrowly scoped
Dimension: Safety & Quality / Success Criteria
Location:  .github/workflows/benchmark.yml:78

Detail:
GitHub Actions does not allow `secrets` context in job-level `if` conditions. The expression `${{ secrets.MISTRAL_API_KEY != '' }}` is always falsy at the job level, so the `benchmark-mistral` job **never runs** — not even on `workflow_dispatch`.

Fix: Move the secret into an env var and check that instead:
```yaml
jobs:
  benchmark-mistral:
    runs-on: ubuntu-latest
    env:
      HAS_MISTRAL_KEY: ${{ secrets.MISTRAL_API_KEY }}
    if: env.HAS_MISTRAL_KEY != ''
```
  - Strength: Standard GitHub Actions pattern; the job runs when the key exists.
  - Tradeoff: None — this is the canonical fix.
  - Confidence: HIGH — documented GitHub Actions limitation.
  - Blind spot: None significant.
- **Decision**: FIXED — added concurrency group; jobs run in parallel, commits serialize

### F2 — Race condition between benchmark jobs
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌

Severity:  ❌ CRITICAL
Impact:    🔎 MEDIUM — real tradeoff; pause to reason through it
Dimension: Safety & Quality
Location:  .github/workflows/benchmark.yml:56-66,115-138

Detail:
Both `benchmark` and `benchmark-mistral` jobs run in parallel (no `needs` dependency), both modify `action.yml`, and both do `git pull --rebase && git push`. If they finish close together, one job's commit is overwritten by the other's rebase, or the push fails.

Fix A ⭐ Recommended: Add `needs: benchmark` to `benchmark-mistral` so it runs sequentially after NIM, or add a `concurrency` group:
```yaml
concurrency:
  group: benchmark-commit
  cancel-in-progress: false
```
  - Strength: Eliminates the race entirely. Concurrency group is non-blocking (queues instead of cancels).
  - Tradeoff: Adds ~1-2 min latency if NIM benchmark is slow; concurrency group makes the second job wait.
  - Confidence: HIGH — standard pattern for workflow jobs that commit to the same branch.
  - Blind spot: None significant.

Fix B: Merge both benchmarks into a single job
  - Strength: Atomic commit, no race possible.
  - Tradeoff: Loses independence — if Mistral fails, NIM results are lost too. More complex single job.
  - Confidence: MEDIUM — tradeoff depends on how often one provider fails.
  - Blind spot: None significant.
- **Decision**: FIXED — concurrency group added; jobs run in parallel, commits serialize

### F3 — nim_models hardcoded default mismatches action.yml
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌

Severity:  ⚠️ WARNING
Impact:    🔎 MEDIUM — real tradeoff; pause to reason through it
Dimension: Success Criteria
Location:  src/review.ts:38-39

Detail:
`action.yml:16` defaults `nim_models` to:
```
deepseek-ai/deepseek-v4-pro,minimaxai/minimax-m3,deepseek-ai/deepseek-v4-flash,...
```
But `review.ts:38-39` hardcoded fallback is:
```
stepfun-ai/step-3.7-flash,meta/llama-3.3-70b-instruct,deepseek-ai/deepseek-v4-pro,...
```
Different models in different orders. When `nim_models` is not provided, `core.getInput` returns `''`, and `loadConfig` falls through to this hardcoded default — which doesn't match `action.yml`. Users who read the README defaults will get different behavior than what the code actually uses.

Note: This is pre-existing — not introduced by this change — but it creates confusion alongside the new Mistral defaults.

Fix: Remove the hardcoded fallback in `review.ts` and let the `action.yml` default always be the authority.
  - Strength: Single source of truth; no divergence possible.
  - Tradeoff: None — `core.getInput` already returns the `action.yml` default.
  - Confidence: HIGH.
  - Blind spot: None significant.
- **Decision**: FIXED — removed hardcoded fallback in review.ts

### F4 — Unescaped regex replacement in bench-reorder
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌

Severity:  ⚠️ WARNING
Impact:    🏃 LOW — quick decision; fix is obvious and narrowly scoped
Dimension: Safety & Quality
Location:  src/bench-reorder.ts:162-163

Detail:
`modelString` is interpolated directly into the regex replacement string. `$` characters in replacement strings are interpreted as backreferences (`$1`-`$9`). While model IDs today are safe alphanumeric strings, this is a latent injection vector if model IDs ever contain `$`.

Fix: Escape the replacement string before interpolating: `modelString.replace(/\$/g, '$$')`.
  - Strength: Removes the backreference class entirely.
  - Tradeoff: None — one-line fix.
  - Confidence: HIGH.
  - Blind spot: None significant.
- **Decision**: FIXED — escaped `$` in both updateActionYml and updateActionYmlMistral
