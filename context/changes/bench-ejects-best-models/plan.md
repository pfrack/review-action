# False-Negative Model Ejection Fix — Implementation Plan

## Overview

Fix the daily benchmark's false-negative model ejection: slow-but-healthy high-SWE NIM models (e.g. `minimax-m3` 0.805, HTTP 200 in 47.8s) are permanently ejected from `action.yml` into `removed-models.txt` because the all-failed gate (`bench-entry.ts:333`) + alive filter (`bench-reorder.ts:251`) conflate "slow but responsive" with "unavailable." The fix uses the existing probe (30s, maxTokens=8) as the availability signal — if a model is in the live NIM catalog AND passes the probe, it is demoted-but-kept (ranked lower by latency penalty) rather than ejected. Catalog-listed models no longer persist in `removed-models.txt`; each run re-admits any catalog-listed model that passes the probe.

## Current State Analysis

The benchmark pipeline (`bench-entry.ts` → `bench-reorder.ts` → `action.yml`) has three failure-handling layers, none of which can distinguish a slow-but-healthy model from a dead one:

1. **`bench-entry.ts:333`** (`allFailed = errCount === iterations`): If every benchmark iteration errors, the model is pushed to the `failed` array. For NIM, the replacement logic (`bench-entry.ts:349-392`) then probes the next-best SWE_BENCH_SCORES candidates. A model like `minimax-m3` may respond to a probe (47.8s, HTTP 200) but time out on the full 180s benchmark with `maxTokens: 1024` — classified as `allFailed` despite being available.

2. **`bench-reorder.ts:251`** (`alive = rows.filter(r => r.tokensPerSec > 0 && r.errors === 0)`): Even if a model completes *some* iterations successfully (1 of 2), the `errors === 0` check drops it from the ranked output entirely. So a model that responded but had one timeout iteration is silently removed from `action.yml`.

3. **`removed-models.txt` persistence** (`bench-entry.ts:218-225, 408-486`): Previously-removed models are re-checked each run via probe+full-benchmark. But if the full benchmark also times out (same 180s ceiling), the model stays in `removed-models.txt` indefinitely — a "drop-and-hope" loop with no escape. The cross-system convention from `probe-cap-and-stale-refs` explicitly rejects this: "degrade-then-recover, not drop-and-hope-it-comes-back."

The NIM catalog is still published for all three ejected models (`deepseek-v4-pro`, `minimax-m3`, `glm-5.2`), confirmed by the verification runbook's probe results (`minimax-m3` HTTP 200, `deepseek-v4-pro`/`glm-5.2` timeout past 120s).

### Key Discoveries:

- `OpenAIClient.probeModel` (`openai-client.ts:435`) uses `maxTokens: 8` with a 30s timeout — it tests *availability*, not *fitness*. This is the right signal for the ejection gate.
- `runBenchmark` (`bench.ts:23`) uses `maxTokens: 1024` with a 180s timeout — a healthy model can fail all iterations here while still being available via probe.
- `getEffectiveScore` (`bench-reorder.ts:228`) already computes `SWE × latency penalty` (≤60s: 1.0, 60-120s: linear to 0.7, >120s: 0.5) but is display-only — `rankModels` at `bench-reorder.ts:246` sorts by SWE-only, using latency as a tiebreaker only.
- `probeModels` (`model-chain.ts:141`) is already log-only with the 0.02 head-gap cap (`model-chain.ts:12`); `prioritizeChain` (`index.ts:433`) only logs, does not reorder the chain.
- `bench-entry.ts:348-351` already has `isNim = baseURL.includes('nvidia.com')` gating replacement logic to NIM only — the new catalog-driven re-admission follows the same pattern.
- The OR/Kilo benchmark jobs use separate files (`removed-openrouter-models.txt`, `removed-kilocode-models.txt`); eliminating NIM's `removed-models.txt` does not affect them.

## Desired End State

1. A NIM model that responds to the probe but is slow (e.g. `minimax-m3`, 47.8s) is **demoted-but-kept** in `action.yml`, ranked by its effective score (SWE × latency penalty) rather than ejected.
2. A NIM model not in the live catalog OR failing the probe is **ejected** (dropped from the benchmark table). Previously-removed models that are still catalog-listed are re-probed each run and re-admitted if they pass the probe.
3. `removed-models.txt` is eliminated for the NIM benchmark job. Re-admission is catalog-driven: each run probes all NIM SWE_BENCH_SCORES models not currently in `action.yml`, benchmarks the ones that pass the probe, and includes them in the ranking.
4. `README.md` reflects the actual probe behavior (log-only, no reordering) and no longer hardcodes a stale model list. `shape-notes.md:15` ("effective score = SWE × latency penalty") is now correct because the latency penalty is implemented in `rankModels`.

### Key Discoveries:

- `probeModel` at `openai-client.ts:435` is the right availability signal — it already exists, uses appropriate timeouts
- `getEffectiveScore` at `bench-reorder.ts:228` already has the exact penalty logic described in shape-notes; it just isn't wired into ranking
- `bench-entry.ts:348` already gates NIM-specific logic via `isNim` check — new re-admission follows the same pattern
- The recheck path at `bench-entry.ts:408-473` re-runs full benchmarks on removed models, which is why slow-but-healthy models stay stuck
- `index.test.ts:509-526` locks probe as log-only + chain-order-preserving — the doc fix must match

## What We're NOT Doing

- NOT redoing the probe speed-cap (`probe-cap-and-stale-refs` already fixed this; `PROBE_PROMOTE_MAX_HEAD_GAP = 0.02`)
- NOT adding a probe latency tax (`review-speed` handles this separately)
- NOT changing the runtime model chain or review logic (`index.ts`, `model-chain.ts`, `review.ts`)
- NOT eliminating the OR/Kilo removed-models files (separate files, separate jobs, different flow)
- NOT changing the table format or adding columns to `formatMarkdownTable`
- NOT building a model health dashboard or historical stats tracking

## Implementation Approach

Two code changes + doc fixes, applied to the benchmark pipeline only (no runtime action code changes):

1. **Ranking fix** (`bench-reorder.ts`): Relax the alive filter and implement the latency penalty that `getEffectiveScore` already computes — this makes `shape-notes.md:15` correct by making the code match the design.
2. **Ejection gate fix** (`bench-entry.ts`): Replace the `allFailed`-only ejection logic with probe-based availability classification, and replace file-based removed-models recheck with catalog-driven re-admission for NIM.

## Phase 1: Ranking with Latency Penalty + Relaxed Alive Filter

### Overview

Modify `rankModels` in `bench-reorder.ts` to (a) allow models with partial errors in ranking (alive filter relaxation), and (b) sort by effective score (SWE × latency penalty) instead of SWE-only. This implements the design intent from `shape-notes.md:15` and ensures slow-but-healthy models are demoted, not dropped.

### Changes Required:

#### 1. Relax the alive filter in `rankModels`

**File**: `src/bench-reorder.ts`

**Intent**: The current filter `tokensPerSec > 0 && errors === 0` drops any model with even one errored iteration from the ranking. Change it to `tokensPerSec > 0` — if at least one iteration produced tokens, the model is alive and should be ranked. The `errors` count remains in the parsed row and feeds into the latency penalty (more errors → higher median latency → lower effective score). `tokensPerSec > 0` is equivalent to `errors < iterations` when at least one iteration ran, because a model with all iterations errored has `tokensPerSec = 0`.

**Contract**: `rankModels` alive filter changes from `r.tokensPerSec > 0 && r.errors === 0` to `r.tokensPerSec > 0`. No signature change; `rankModelsTwoTier` gets the same change for OR/Kilo consistency.

#### 2. Implement latency penalty in ranking

**File**: `src/bench-reorder.ts`

**Intent**: Change the sort comparator in `rankModels` and `rankModelsTwoTier` from SWE-only (`getSweBenchScore`) to effective score (`getEffectiveScore`), which already exists at `bench-reorder.ts:228` and computes `SWE × latency multiplier` (≤60s: 1.0, 60-120s: linear to 0.7, >120s: 0.5). When latency data is available for a model, it is ranked by effective score; when no latency data, it falls back to SWE-only (via `getEffectiveScore`'s existing `if (!latencies || !(model in latencies)) return swe` path at `bench-reorder.ts:230`).

**Contract**: Sort comparator in `rankModels` (line 255-261) and `rankModelsTwoTier` (line 288-295) change from `sweB - sweA` (with latency tiebreaker) to `effB - effA` (effective score descending, no separate tiebreaker needed since penalty encodes latency). The `DEFAULT_MAX_LATENCY_MS = 60_000` constant (line 226) governs the penalty thresholds.

#### 3. Unit tests for ranking changes

**File**: `src/bench-reorder.test.ts`

**Intent**: Add tests covering the relaxed alive filter (model with partial errors stays in ranking, ranked by effective score) and the latency penalty in sorting (slow high-SWE model ranks below fast lower-SWE model when penalty crosses the threshold).

**Contract**: New test cases in the `describe('rankModels')` block:
- "includes model with partial errors when tokensPerSec > 0"
- "ranks fast lower-SWE model above slow higher-SWE model under latency penalty"
- "relaxes alive filter in rankModelsTwoTier too"

### Success Criteria:

#### Automated Verification:

- `npm run build` succeeds (TypeScript compiles)
- All bench-reorder tests pass: `node --test dist/src/bench-reorder.test.js`
- `rankModels` and `rankModelsTwoTier` both use `getEffectiveScore` for sorting

#### Manual Verification:

- Rankings with latency data show slower models ranked lower than same-SWE faster models
- A model with 1/2 iterations errored still appears in the ranked output

## Phase 2: Catalog-Driven Re-admission + Eliminate removed-models.txt (NIM)

### Overview

Replace the file-based `removed-models.txt` persistence with a catalog-driven re-admission pass for the NIM benchmark job. Each run: after the main benchmark, probe all NIM models from `SWE_BENCH_SCORES` that are (a) in the live catalog and (b) not currently in `action.yml`. Models that pass the probe are benchmarked and included in the table; models that fail the probe or are not in the catalog are skipped. The NIM `removed-models.txt` file is deleted and the workflow no longer sets `REMOVED_MODELS_PATH` for the NIM job.

### Changes Required:

#### 1. Refactor failure classification in `bench-entry.ts`

**File**: `src/bench-entry.ts`

**Intent**: Replace the binary `allFailed = errCount === iterations` → `failed.push(model)` → "transient if in catalog, permanent if not" classification with a three-way classification using the probe:

- **Probe-pass + catalog-listed** → demote-but-keep: include in the benchmark table (even if some iterations errored), let `rankModels` sort it by effective score. The model stays in `action.yml` at its penalized position.
- **Probe-fail + catalog-listed** → transient: skip from this run's table, but re-probe next run (catalog-driven, no file persistence needed).
- **Probe-fail + not-in-catalog** → permanently unavailable: exclude from rotation entirely.

The probe already exists at `client.probeModel(model)` (`openai-client.ts:435`, 30s timeout, maxTokens=8). The catalog is already fetched at `bench-entry.ts:207` (`client.listModels()`).

**Contract**: In the failure-classification block (`bench-entry.ts:394-406`), restructure as:
- For each model in `failed` (all-failed iterations), call `client.probeModel(model)`.
  - If probe passes: log "demoted — slow but healthy," do NOT add to `failed` for replacement. Instead, keep the result in the table (it will be ranked by effective score with latency penalty).
  - If probe fails and `availableModels.has(model)`: log "transient — will re-probe next run" (no file write needed).
  - If probe fails and `!availableModels.has(model)`: log "permanently unavailable" (no file write needed).
- Replace the `writeRemovedModels` calls (lines 423, 476, 485) with no-ops for NIM (the file is eliminated).

#### 2. Add catalog-driven re-admission pass

**File**: `src/bench-entry.ts`

**Intent**: Before the existing "replace failed models" logic, add a re-admission pass: for NIM, probe all `SWE_BENCH_SCORES` models that are in the live catalog AND not currently in `action.yml`'s `nim_models` list. For each that passes the probe, benchmark it and add the result to the table. This replaces what the removed-models.txt recheck path did, but is driven by the catalog each run rather than file state.

**Contract**: New function `readmitCatalogModels(opts)` that:
- Takes `availableModels`, `actionPath`, `client`, `benchPrompt`, `iterations`, `benchModels` limit (env `BENCH_READMIT_LIMIT`, default 5)
- Gets NIM models from `SWE_BENCH_SCORES` that are in `availableModels` and not in `readCurrentModels(actionPath)`
- Sorts by SWE score descending, limits to `BENCH_READMIT_LIMIT`
- Probes each; if probe passes, runs `runBenchmark` and pushes the result to `results`
- Returns the list of re-admitted model IDs for logging

Called from `main()` after the main benchmark loop and before the failure-classification block, gated by `isNim` (same pattern as replacement logic at `bench-entry.ts:348`).

#### 3. Remove removed-models.txt dependency for NIM

**File**: `src/bench-entry.ts`

**Intent**: Remove the `readRemovedModels` import and calls for the NIM path. The recheck path (`bench-entry.ts:408-473`) is no longer needed for NIM — re-admission is handled by the new catalog-driven pass. The recheck path remains for OR/Kilo jobs that set their own `REMOVED_MODELS_PATH`.

**Contract**: Wrap the removed-models recheck path in a guard: only run if `process.env.REMOVED_MODELS_PATH` is set AND the file exists. For the NIM job (which no longer sets it), the path is skipped entirely. Remove the `writeRemovedModels` calls for the NIM path. Keep `readRemovedModels`/`writeRemovedModels` in `removed-models.ts` — they're still used by OR/Kilo jobs.

#### 4. Update benchmark workflow

**File**: `.github/workflows/benchmark.yml`

**Intent**: Remove `REMOVED_MODELS_PATH: 'removed-models.txt'` from the NIM benchmark job (line 36). The NIM job no longer uses a removed-models file.

**Contract**: Delete `REMOVED_MODELS_PATH: 'removed-models.txt'` from the `benchmark-nim` job's env block. No other changes to the NIM job. OR/Kilo jobs retain their `REMOVED_MODELS_PATH` env vars.

#### 5. Delete removed-models.txt

**File**: `removed-models.txt`

**Intent**: Remove the file from the repo. It contained `mistralai/mistral-medium-3.5-128b`, `deepseek-ai/deepseek-v4-pro`, `minimaxai/minimax-m3`, `deepseek-ai/deepseek-v4-flash`, `z-ai/glm-5.2` — all of which will be re-discovered from the catalog on the next run.

**Contract**: `git rm removed-models.txt` (or just delete — the workflow won't reference it for NIM anymore). The `cleanupRemovedModels` call at `bench-entry.ts:219-225` becomes a no-op for NIM (empty removedModels list).

### Success Criteria:

#### Automated Verification:

- `npm run build` succeeds
- `bench-entry.test.ts` tests pass for the new re-admission function
- OR/Kilo benchmark jobs' tests still pass (unchanged removed-models logic)
- Workflow YAML is valid: `yamllint .github/workflows/benchmark.yml` or `actionlint`

#### Manual Verification:

- NIM benchmark run without `removed-models.txt`: catalog-listed models not in action.yml are probed and re-admitted
- A slow-but-healthy model (probe passes, full benchmark times out) appears in the table with latency penalty, not ejected
- A genuinely-unavailable model (not in catalog) is skipped without error

## Phase 3: Documentation Reconciliation

### Overview

Fix the stale documentation identified in the frame: `README.md:274` claims the probe promotes the fastest model to the front of the chain (no longer true), and `README.md:258-262` hardcodes a model list that no longer matches `action.yml`. `shape-notes.md:15` ("effective score = SWE × latency penalty") becomes correct once Phase 1 implements the latency penalty — verify it matches.

### Changes Required:

#### 1. Fix stale probe description

**File**: `README.md:272-274`

**Intent**: The "Model Probing" section claims: "The fastest probed model is moved to the front of the chain." This is false — `prioritizeChain` (`index.ts:433`) only logs the probe result; it does not reorder the chain. `index.test.ts:509` locks this: "does not change chain order regardless of probe results."

**Contract**: Replace the "fastest probed model is moved to the front" text with: "The probe result is logged for observability but does not change the chain order. The SWE-bench-sorted chain head is always tried first." Remove or correct the `PROBE_PROMOTE_MAX_HEAD_GAP` mention — the cap still exists (`model-chain.ts:12`) but it gates logging, not reordering.

#### 2. Fix stale default chain listing

**File**: `README.md:256-262`

**Intent**: The "Default NIM Fallback Chain" lists `deepseek-v4-pro`, `minimax-m3`, `glm-5.2` as positions 1-3, but these were ejected from `action.yml` by commit `e8f50b4`. The current `action.yml:16` default starts with `stepfun-ai/step-3.7-flash`. Since the benchmark auto-updates the list daily, hardcoding specific models is inherently fragile.

**Contract**: Replace the numbered static list with: "The default NIM fallback chain is auto-ranked daily by the benchmark workflow. The current order in `action.yml` is always the source of truth. Models are sorted by SWE-bench Verified score with a latency penalty." Then list the general ordering principle rather than specific model IDs.

#### 3. Verify shape-notes.md alignment

**File**: `context/foundation/shape-notes.md:14-15`

**Intent**: `shape-notes.md:15` says: `"effective score = SWE × latency penalty; no historical win tracking needed"`. With Phase 1 implementing the latency penalty in `rankModels`, this decision is now correct rather than stale. Add a note that this was implemented.

**Contract**: Add a comment near `shape-notes.md:15` or in the plan's references that this decision is now implemented in `bench-reorder.ts:rankModels`. No shape-notes edit needed if the code now matches — but add a brief note if the file is treated as a living document.

### Success Criteria:

#### Automated Verification:

- `grep -n "moved to the front" README.md` returns no results
- `grep -n "deepseek-ai/deepseek-v4-pro" README.md:258` reflects that it is no longer in the default (or the section is restructured)
- shape-notes.md:15 statement matches `rankModels` behavior

#### Manual Verification:

- A reader of README "Model Probing" section understands that probes are log-only
- A reader of README "Default NIM Fallback Chain" section understands the list is auto-ranked

## Phase 4: End-to-End Verification

### Overview

Full test suite + manual verification that the ejection gate fix works end-to-end.

### Changes Required:

None (verification-only phase).

### Success Criteria:

#### Automated Verification:

- Full test suite passes: `npm test` (all existing tests + new tests)
- `npm run build` succeeds (TypeScript + ncc bundle)
- `rankModels` test suite confirms latency penalty sorting: `node --test dist/src/bench-reorder.test.js`
- `bench-entry` test suite confirms re-admission logic: `node --test dist/src/bench-entry.test.js`

#### Manual Verification:

- Trace through the flow with the `minimax-m3` scenario: model probes OK (47.8s), full benchmark may timeout → model appears in table with high latency → `rankModels` ranks it by effective score (0.805 × 0.5 = 0.4025 for >120s) → stays in `action.yml` at a low rank, not ejected
- Trace the `deepseek-v4-pro` scenario: model not in catalog or probe fails → excluded from table → stays out of `action.yml`, not re-admitted
- Verify `removed-models.txt` is not created/committed by the NIM benchmark job
- Verify the README "Model Probing" and "Default NIM Fallback Chain" sections no longer contradict the code

## Phase 5: Parallel Benchmark Execution

### Overview

The NIM benchmark runs models sequentially (`bench-entry.ts:387-410`). With 11 models in `action.yml`, a single run takes 20-40 minutes because each model can burn up to 230s (a failed model times out on the full benchmark). This makes the daily job slow and made manual verification of Phase 2 impractical — the re-admission/failure-classification logic only runs *after* the whole loop completes. This phase parallelizes the main benchmark loop with bounded concurrency so the full run (including re-admission) completes in roughly `ceil(N / concurrency) × worst-case-model-time` instead of `N × worst-case-model-time`.

### Changes Required:

#### 1. Parallelize the main benchmark loop

**File**: `src/bench-entry.ts`

**Intent**: Replace the sequential `for (const model of models)` loop (lines 387-410) with bounded-concurrency execution using the same batch pattern already used by the recheck path (`bench-entry.ts:546-551`, `BENCH_RECHECK_CONCURRENCY` default 3). Each model's benchmark is independent, so they can run concurrently. Results and per-model status must be preserved.

**Contract**:
- Add env `BENCH_CONCURRENCY` (default `1` = sequential). Parallelism is opt-in per provider: rate-limited providers (Groq, Mistral, OR, Kilo) stay sequential unless explicitly enabled, so concurrent 429s can't be misclassified as failures and demote healthy models. Only the NIM job opts in (workflow sets `BENCH_CONCURRENCY: '3'`).
- Process models in batches of `BENCH_CONCURRENCY` with `Promise.all`, same shape as the recheck path:
  ```
  for (let i = 0; i < models.length; i += concurrency) {
    const batch = models.slice(i, i + concurrency);
    const outcomes = await Promise.all(batch.map(async (model) => { ... }));
    for (const o of outcomes) { ... }   // preserves input order within batch
  }
  ```
- Each batch element runs `runBenchmark`, classifies `allFailed`, and returns `{ model, result, allFailed }` (or equivalent). Interleaved `process.stderr.write` calls from concurrent models may interleave — acceptable for a CLI, but keep each model's status line to a single write (build the string first).
- Preserve existing log output semantics: "done in Xs (Y errors)" vs "FAILED (Xs)". The `failed` array and `results` array must end up identical to the sequential version (same membership, results in input order).

#### 2. Parallelize `readmitCatalogModels` probe+benchmark loop

**File**: `src/bench-entry.ts`

**Intent**: The new re-admission pass (lines 100-124) is also sequential. Parallelize it with the same `BENCH_CONCURRENCY` limit so probe+benchmark for up to 5 candidates doesn't add up to ~25 minutes when a candidate is slow.

**Contract**: Add `concurrency?: number` to `readmitCatalogModels` opts (default 3). Replace the sequential `for (const model of candidates)` with the bounded-batch pattern. Each candidate's probe→benchmark→classify step runs independently; return `{ results, reAdmitted }` with `results` in candidate order. Logging per candidate stays single-write-per-step (probe line, then benchmark line).

#### 3. Update workflow + docs for concurrency knob

**File**: `.github/workflows/benchmark.yml`, `README.md`

**Intent**: Surface the new env var in the NIM job and document it.

**Contract**: Add `BENCH_CONCURRENCY: '3'` to the NIM job's env block (opt-in). Document `BENCH_CONCURRENCY` in the README's benchmark section, noting the default is `1` (sequential). No change to OR/Kilo jobs — they inherit the sequential default.

### Success Criteria:

#### Automated Verification:

- `npm run build` succeeds
- `node --test dist/src/bench-entry.test.js` passes; add a unit test that the batch loop processes all models and preserves input order (test the pure helper if the loop is extracted, otherwise test via `readmitCatalogModels` with a mock client and short iterations)
- `readmitCatalogModels` respects `concurrency` (verified by counting in-flight calls in a mock)
- Full test suite passes: `npm test`

#### Manual Verification:

- `BENCH_MODELS=model-a,model-b` NIM run completes in roughly `ceil(2/3) × worst-case` time instead of `2 × worst-case`
- Full 11-model run completes in ~⅓ the sequential wall-clock time (rate-limit permitting: NIM is ~40 RPM; concurrency 3 ≈ 3 requests per model per iteration, within budget)
- Re-admission + failure classification now observable in a single manual run

## Testing Strategy

### Unit Tests:

- **`bench-reorder.test.ts`**: 
  - `rankModels` with partial errors (1/2 iterations errored) — model stays in output
  - `rankModels` sorting by effective score — slow high-SWE model ranks below fast lower-SWE model when penalty applies
  - `rankModelsTwoTier` same relaxed filter + latency penalty
  - `getEffectiveScore` already has tests (lines 78-98) — verify `rankModels` uses it

- **`bench-entry.test.ts`** (new tests):
  - `readmitCatalogModels` — probes catalog-listed models not in action.yml, benchmarks probe-passing ones
  - Failure classification — probe-pass + catalog = demote-but-keep (not ejected)
  - Failure classification — probe-fail + not-in-catalog = permanent skip
  - removed-models.txt elimination for NIM — recheck path skipped when REMOVED_MODELS_PATH unset

### Integration Tests (manual):

- Full NIM benchmark pipeline: bench-entry → table → bench-reorder → action.yml, with a slow-but-healthy model in the mix
- Verify `minimax-m3` (if still in catalog) would be re-admitted if previously ejected
- Verify OR/Kilo jobs still work with their removed-models files intact

## Performance Considerations

- The new `readmitCatalogModels` pass adds a probe call (30s timeout) for each candidate not in action.yml. With `BENCH_READMIT_LIMIT` defaulting to 5, this adds at most ~150s of probe time — acceptable given the NIM benchmark already takes 5-8 minutes.
- The relaxed alive filter may include more models in `action.yml` (slow-but-healthy ones stay). This could grow the chain length — but the latency penalty ensures slow models rank low, so they're only tried as last-resort fallbacks, same as before.
- Eliminating `removed-models.txt` removes a file I/O operation from the NIM job. No performance impact.
- Phase 5 (parallel execution) bounds the wall-clock time by `ceil(N / concurrency) × worst-case-model-time` instead of `N × worst-case-model-time`. With 11 models, concurrency 3, and a 230s worst case, that's ~4×230s ≈ 15min worst case vs ~42min sequential. NIM's ~40 RPM budget is respected at concurrency 3 (each model makes ~3 requests per iteration: warmup + 1 chat + 1 stream; retries on 429 may add more).

## Migration Notes

- `removed-models.txt` is deleted from the repo. The NIM benchmark job no longer sets `REMOVED_MODELS_PATH`. If the file exists locally, it is ignored.
- Existing `removed-models.txt` contents (the 5 ejected models) are effectively reset — all will be re-discovered from the catalog on the next NIM benchmark run. This is the desired behavior: catalog-listed models should not persist in an ejection file.
- The latency penalty change in `rankModels` affects all providers (NIM, Mistral, OR, Kilo) since both `rankModels` and `rankModelsTwoTier` use `getEffectiveScore`. This is intentional — slow-but-healthy models should be demoted across all providers, not just NIM.
- `shape-notes.md:15` transitions from "stale" to "implemented" — no edit needed to the file itself, but the plan should reference it as resolved.

## References

- Frame brief: `context/changes/bench-ejects-best-models/frame.md`
- Prior change (probe cap, already done): `context/changes/probe-cap-and-stale-refs/change.md`
- Parent feature: `context/changes/daily-benchmark/plan-brief.md`
- `src/bench-reorder.ts:246-263` — `rankModels` (alive filter at 251, SWE-only sort at 255-261)
- `src/bench-reorder.ts:228-239` — `getEffectiveScore` (display-only, needs ranking integration)
- `src/bench-entry.ts:333` — `allFailed = errCount === iterations` (failure gate to fix)
- `src/bench-entry.ts:394-406` — failure classification (transient vs permanent)
- `src/bench-entry.ts:408-486` — recheck path (to be replaced by catalog-driven re-admission)
- `src/bench-entry.ts:348-392` — NIM-only replacement logic (pattern for new re-admission)
- `src/bench-entry.ts:207-209` — catalog fetch (`client.listModels()`)
- `src/openai-client.ts:435-444` — `probeModel` (30s timeout, maxTokens=8)
- `src/bench-entry.ts:218` — `readRemovedModels()` (to be eliminated for NIM)
- `src/removed-models.ts` — file I/O helpers (kept for OR/Kilo)
- `src/model-chain.ts:12` — `PROBE_PROMOTE_MAX_HEAD_GAP = 0.02` (already-fixed, not touching)
- `src/model-chain.ts:141-202` — `probeModels` (log-only consumer, not touching)
- `src/index.ts:433-444` — `prioritizeChain` (log-only, not touching)
- `src/index.test.ts:509-526` — locks probe as log-only, chain order preserved
- `action.yml:16` — current NIM default chain (no deepseek-v4-pro/minimax-m3/glm-5.2)
- `action.yml:25` — Mistral chain (`mistral-medium-3.5` is legitimate SWE head of merged chain)
- `README.md:258-262` — stale default chain listing
- `README.md:274` — stale probe promotion claim
- `shape-notes.md:15` — "effective score = SWE × latency penalty" (now implemented, no longer stale)
- `.github/workflows/benchmark.yml:36` — NIM job's `REMOVED_MODELS_PATH` (to be removed)
- `src/bench-entry.ts:387-410` — sequential main benchmark loop (to be parallelized in Phase 5)
- `src/bench-entry.ts:546-551` — existing bounded-concurrency batch pattern (`BENCH_RECHECK_CONCURRENCY`, default 3) to reuse in Phase 5

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Ranking with Latency Penalty + Relaxed Alive Filter

#### Automated

- [x] 1.1 `npm run build` succeeds (TypeScript compiles) — d9cf9f6
- [x] 1.2 `rankModels` alive filter relaxed to `tokensPerSec > 0` only — d9cf9f6
- [x] 1.3 `rankModels` sorts by `getEffectiveScore` (SWE × latency penalty) — d9cf9f6
- [x] 1.4 `rankModelsTwoTier` gets same alive filter + latency penalty change — d9cf9f6
- [x] 1.5 All bench-reorder tests pass (existing + new): `node --test dist/src/bench-reorder.test.js` — d9cf9f6

#### Manual

- [ ] 1.6 Rankings with latency data show slower models ranked lower than same-SWE faster models
- [ ] 1.7 A model with partial errors (1/2 iterations) still appears in ranked output

### Phase 2: Catalog-Driven Re-admission + Eliminate removed-models.txt (NIM)

#### Automated

- [x] 2.1 `npm run build` succeeds — 436fe05
- [x] 2.2 `readmitCatalogModels` function added to `bench-entry.ts` — 436fe05
- [x] 2.3 Failure classification restructured (probe + catalog three-way) — 436fe05
- [x] 2.4 removed-models.txt recheck path guarded by `REMOVED_MODELS_PATH` existence — 436fe05
- [x] 2.5 `bench-entry.test.ts` tests pass: `node --test dist/src/bench-entry.test.js` (5 new tests for readmitCatalogModels) — 436fe05
- [x] 2.6 `benchmark.yml` NIM job no longer sets `REMOVED_MODELS_PATH` — 436fe05
- [x] 2.7 `removed-models.txt` deleted from repo — 436fe05

#### Manual

- [ ] 2.8 NIM benchmark runs without removed-models.txt: catalog-listed models probed and re-admitted
- [ ] 2.9 Slow-but-healthy model (probe passes, full benchmark times out) stays in table with latency penalty
- [ ] 2.10 Genuinely-unavailable model (probe fails, not in catalog) excluded from table

### Phase 3: Documentation Reconciliation

#### Automated

- [x] 3.1 `grep -n "moved to the front" README.md` returns no results — 7a38960
- [x] 3.2 README default chain section no longer hardcodes ejected models — 7a38960
- [x] 3.3 `shape-notes.md:15` matches `rankModels` behavior (marked status: "implemented") — 7a38960

#### Manual

- [ ] 3.4 README "Model Probing" section accurately describes log-only probe behavior
- [ ] 3.5 README "Default NIM Fallback Chain" section explains auto-ranking

### Phase 4: End-to-End Verification

#### Automated

- [x] 4.1 Full test suite passes: `npm test` (578 tests, 0 failures) — 949e7bc
- [x] 4.2 `npm run build` succeeds (TypeScript + ncc bundle) — 949e7bc
- [x] 4.3 All bench-reorder and bench-entry tests pass — 949e7bc

#### Manual

- [ ] 4.4 Trace minimax-m3 scenario: probe OK → demoted-but-kept via latency penalty
- [ ] 4.5 Trace deepseek-v4-pro scenario: probe fail or not in catalog → excluded
- [ ] 4.6 Verify removed-models.txt not created by NIM benchmark job
- [ ] 4.7 Verify OR/Kilo benchmark jobs still use their removed-models files

### Phase 5: Parallel Benchmark Execution

#### Automated

- [x] 5.1 Main benchmark loop runs with bounded concurrency (`BENCH_CONCURRENCY`, default 1 sequential, NIM opts into 3) — 276349b
- [x] 5.2 `readmitCatalogModels` probe+benchmark loop parallelized with same limit — 276349b
- [x] 5.3 `npm run build` succeeds — 276349b
- [x] 5.4 New tests pass: `node --test dist/src/bench-entry.test.js` (order-preserving + concurrency) — 276349b
- [x] 5.5 Full test suite passes: `npm test` — 276349b

#### Manual

- [ ] 5.6 `BENCH_MODELS=model-a,model-b` run completes in ~⅓ sequential time
- [ ] 5.7 Full 11-model run completes without rate-limit failure
- [ ] 5.8 Re-admission + failure classification observable in a single run