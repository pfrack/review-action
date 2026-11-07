<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: EOL Model Handling — Runtime Deadness Skip

- **Plan**: context/changes/eol-model-handling/plan.md
- **Scope**: Full plan (all 4 phases)
- **Date**: 2026-09-07
- **Verdict**: NEEDS ATTENTION
- **Findings**: 1 critical, 2 warnings, 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING ⚠️ |
| Scope Discipline | PASS ✅ |
| Safety & Quality | FAIL ❌ |
| Architecture | PASS ✅ |
| Pattern Consistency | WARNING ⚠️ |
| Success Criteria | PASS ✅ |

## Findings

### F1 — `probeModel` boolean inversion at 4 sites in `bench-entry.ts`

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/bench-entry.ts:170, src/bench-entry.ts:319, src/bench-entry.ts:567, src/bench-entry.ts:633
- **Detail**: Phase 1 changed `OpenAIClient.probeModel` to return `Promise<ProbeResult>` (object). One call site (line 524, `classifyFailedModels` callback) was updated to `.then(r => r.ok)`. Four other call sites in the same file still use `const ok = await client.probeModel(model)` followed by `if (!ok)` / `if (ok)`. Since `ProbeResult` is an object that is always truthy, every skip/branch is inverted:
  - L170 `readmitCatalogModels`: dead models with status 410 are admitted instead of skipped — defeats the runtime deadness defense for the benchmark readmission path.
  - L319 `--probe` CLI: always reports `"ok"` regardless of status, hiding failures from operators.
  - L567 NIM replacement loop: every candidate passes the probe gate and is benchmarked.
  - L633 removed-models recheck: previously-removed models are reported as `"back"` and dropped from `removed-*.txt`, corrupting the file across providers.

  Existing test at `bench-entry.test.ts:444` ("does not re-admit models that fail the probe") still passes only because the mock server returns 500 and the subsequent benchmark *also* fails — masking the inversion. No test exists for the L633 recheck path.
- **Fix**: Extract `.ok` at all four sites, e.g. `const ok = (await client.probeModel(model)).ok;`. Add a regression test for the recheck path that asserts a 410-returning model is NOT marked recovered.
  - Strength: Matches the line 524 adapter pattern already in the file; mechanical 1-token change per site.
  - Tradeoff: 4 sites × 1-line edit; adds a small test.
  - Confidence: HIGH — Phase 1 already established the `.then(r => r.ok)` pattern in the same file.
  - Blind spot: Other files outside this diff that also call `probeModel` (none found in current source).
- **Decision**: FIXED — extracted `.ok` at all four sites; updated the pre-existing concurrency test mock that returned bare boolean (was being skipped by the fix); added regression test `does NOT re-admit models whose probe returns 410` at `src/bench-entry.test.ts:587`

### F2 — Stale `probeModel` mocks in `prioritizeChain` tests

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence / Pattern Consistency
- **Location**: src/index.test.ts:541-543, src/index.test.ts:559-560
- **Detail**: Five `probeModel` mocks still return bare booleans (`async () => true`) instead of the new `ProbeResult` shape. Tests pass because they only assert chain-order preservation, but the mocks no longer reflect the real client contract. A future maintainer reading these tests will be misled about what `probeModel` actually returns. The new EOL integration tests at `src/index.test.ts:1104, 1151` already use the correct shape.
- **Fix**: Update the five mocks to return `{ ok: true, permanent: false }` to match the rest of the file and the real client contract.
- **Decision**: FIXED — 5 mocks in src/index.test.ts:541-543, :559-560 updated to return { ok: true, permanent: false }; all 624 tests pass

### F3 — `attemptedCount` overcounts models with no provider client

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (observability)
- **Location**: src/index.ts:750-752
- **Detail**: The log line `Skipped N dead models, attempted M healthy models` computes `attemptedCount = chain.length - skippedCount`. Models lacking a provider client (e.g. `mistral_models` configured without `mistral_api_key`) are filtered out in `runModelChainForBatch:265` but counted here, so `attemptedCount` is larger than the actual models the chain will try.
- **Fix**: Subtract the clientless-model count (or use the chain length *after* the `clients[tagged.provider]` filter) when building the log.
- **Decision**: FIXED — src/index.ts:750-751 now computes attemptedCount from chain.filter(t => clients[t.provider]).length - skippedCount; 624/624 tests pass

### F4 — `probeModels` does not abort in-flight probe on timeout

- **Severity**: OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality (performance)
- **Location**: src/model-chain.ts:169-184
- **Detail**: `Promise.race` rejects at `PROBE_TIMEOUT_MS` (10s) but `probeModel` does not accept an `AbortSignal`. A hanging probe continues in the background until the underlying 180s `fetch` timeout fires; the result is discarded. In Node this does not surface as an unhandled rejection (the catch in `probeModel` swallows the error), but up to 180s of provider quota is burned per stalled probe and the discarded probe may overlap with the next batch.
- **Fix**: Either pass an `AbortSignal` through `probeModel` (signature change — touches Phase 1's contract) or document the waste as an accepted trade-off and accept the regression is pre-existing in `withRetry`.
- **Decision**: FIXED — src/openai-client.ts:452 probeModel now accepts `{signal?: AbortSignal}`; src/model-chain.ts:163-184 probeModels creates per-probe AbortController that aborts at PROBE_TIMEOUT_MS, cancelling the underlying fetch (was previously Promise.race that didn't cancel); 624/624 tests pass

### F5 — `403` classified as permanent may be transient on some providers

- **Severity**: OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality (reliability)
- **Location**: src/openai-client.ts:461
- **Detail**: `permanent = status === 410 || status === 403 || status === 413`. 403 is ambiguous — OpenRouter/Groq can return 403 for transient per-model rate limits or per-key restrictions that resolve on the next run. A model classified permanent here is excluded from the chain for the rest of the run with no retry path; a single bad response silently drops a healthy model.
- **Fix A ⭐ Recommended**: Narrow the permanent set to just `410` (Gone is unambiguous). Treat `403` and `413` as transient so they are surfaced via the existing `transient` bucket in `classifyFailedModels` rather than the runtime skip set.
  - Strength: Matches the plan-brief's documented choice but tightens the operational blast radius of a single 403.
  - Tradeoff: 403-as-transient means dead-permission models keep getting probed every run (acceptable cost vs. silent exclusion).
  - Confidence: MEDIUM — depends on observed frequency of true vs. transient 403s on NIM.
  - Blind spot: Have not measured how often NIM returns 403 for transient vs. permanent reasons in production.
- **Fix B**: Keep the current 403-as-permanent classification but document it as a one-way decision in the plan and accept that 403 hits must be re-checked manually.
  - Strength: Preserves the plan's stated behavior exactly.
  - Tradeoff: Same risk of silent permanent exclusion as today.
  - Confidence: HIGH — preserves current behavior.
  - Blind spot: Operationally fragile to provider-side rate-limit changes.
- **Decision**: FIXED — src/openai-client.ts:461 narrowed permanent to status === 410 only; 403 and 413 now classify as transient (permanent=false). Updated src/openai-client.test.ts tests for 403/413 to assert transient; 624/624 tests pass

### F6 — `BENCH_AUTO_FREE` zero-row outcome is silent skip

- **Severity**: OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality (reliability)
- **Location**: src/bench-reorder.ts:455-497, src/bench-entry.ts:373-385
- **Detail**: `wasModelAttempted()` only inspects `process.env.BENCH_MODELS`. In `BENCH_AUTO_FREE=true` mode, `bench-entry.ts:373` auto-discovers models from the catalog. If the catalog fetch itself returns zero free models, no rows are produced, `wasModelAttempted()` returns false, and the reorder exits 0 with "no models to bench" — silent skip on what is effectively a provider outage. Plan does not address this interaction.
- **Fix**: Have `classifyAllModelFailure` also treat `BENCH_AUTO_FREE=true` as "models were attempted" so a zero-row outcome in auto-free mode exits 1 instead of 0.
- **Decision**: FIXED — src/bench-reorder.ts:455-462 wasModelAttempted() now also returns true when BENCH_AUTO_FREE === 'true'; 624/624 tests pass