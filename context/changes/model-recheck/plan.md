# Daily Model Recheck + Auto-Scoring Implementation Plan

## Overview

Add daily retry of failed models, provider catalog checks (outage vs. removal), and auto-scoring of new models via SWE-bench leaderboard API + LLM-based fuzzy matching. All changes fit within the existing `benchmark.yml` workflow — no new workflows needed.

## Current State Analysis

- **No failure persistence**: `failed` is a local variable in `bench-entry.ts:122`, discarded after each run
- **No retry mechanism**: Failed models are permanently replaced by next-best SWE-bench candidate
- **No provider awareness**: Can't distinguish "model had outage" from "model removed from NIM"
- **Hardcoded scores**: `SWE_BENCH_SCORES` in `bench-reorder.ts:58-104` has 37 manually maintained entries, no auto-update
- **Dead code**: `listModels()` at `openai-client.ts:240-255` exists but is never called
- **`probeModel()`** at `openai-client.ts:228-238` — cheap probe primitive, already uses `withRetry()`

### Key Discovery: SWE-bench API

`https://api.zeroeval.com/leaderboard/benchmarks/swe-bench-verified/details` returns clean JSON with 104 models, including `model_id`, `score`, `organization_id`. No HTML scraping needed.

Mapping challenge: NIM IDs (`deepseek-ai/deepseek-v4-pro`) don't match API IDs (`deepseek-v4-pro-max`). Solution: pass JSON to LLM prompt for fuzzy matching.

## Desired End State

After a daily benchmark run:
1. Failed models that are still in the provider catalog → saved to `removed-models.txt`, retried next day
2. Failed models removed from provider → permanently dropped, not retried
3. Models in `removed-models.txt` from previous days → probed first, benchmarked if alive, reinserted
4. New models discovered via `listModels()` → scored via SWE-bench API + LLM matching, benchmarked with provisional score
5. `removed-models.txt` auto-cleaned: models no longer in provider catalog are purged

## What We're NOT Doing

- No separate `recheck.yml` workflow — everything goes in existing `benchmark.yml`
- No HTML scraping — API returns clean JSON
- No TTL/date-based cleanup — cleanup is based on provider catalog presence
- No SWE-bench score caching across runs — fresh fetch each day (cheap, <1KB JSON)
- No changes to `model-chain.ts` or `review.ts` — runtime behavior unchanged

## Implementation Approach

Modify `bench-entry.ts` to add three capabilities in sequence:
1. **Provider catalog check** via `listModels()` — classify failures as outage vs. removal
2. **Removed-models recheck** — read `removed-models.txt`, probe, benchmark survivors
3. **New model discovery** — fetch SWE-bench API, match via LLM, benchmark with real score

Update `benchmark.yml` to persist `removed-models.txt` across runs.

## Critical Implementation Details

- **`listModels()` has no retry wrapper** (`openai-client.ts:241`). Wrap the call in `withRetry()` or handle failures gracefully (fall back to no catalog = treat all failures as transient).
- **API response is ~50KB JSON** — too large for a single LLM prompt. Filter to top ~30 models by score before sending to LLM, or extract only `model_id` + `score` fields.
- **LLM matching call adds latency** (~2-5s) and cost (~500 tokens). Only triggered when new models are discovered (infrequent).
- **`removed-models.txt` is committed to git** — consistent with existing pattern of committing `action.yml`. Must NOT be amended into the daily benchmark commit (separate logical concern).

## Phase 1: Track Failed Models + Provider Catalog Check

### Overview

Persist failed models to `removed-models.txt` and use `listModels()` to distinguish transient outages from permanent removals.

### Changes Required:

#### 1. Provider catalog fetch

**File**: `src/bench-entry.ts`

**Intent**: At the start of `main()`, after creating the OpenAI client, call `listModels()` to get the set of models currently available on the provider. Store as a `Set<string>`. If `listModels()` fails, log a warning and set to `null` (graceful degradation — treat all failures as transient).

**Contract**: `availableModels: Set<string> | null` — `null` means "catalog unknown, don't filter".

#### 2. Classify failures by provider status

**File**: `src/bench-entry.ts`

**Intent**: In the failure detection section (after line 147), check each failed model against `availableModels`. If the model is NOT in the catalog, log it as "permanently removed" and skip adding to `removed-models.txt`. If it IS in the catalog (or catalog is null), treat as transient and add to `removed-models.txt`.

**Contract**: Failed models produce two categories — `permanentlyRemoved[]` (logged, skipped) and `transientFailed[]` (written to `removed-models.txt`).

#### 3. Write removed-models.txt

**File**: `src/bench-entry.ts`

**Intent**: After the replacement loop, append transient-failed model IDs to `removed-models.txt` (one per line). Skip duplicates. Use `REMOVED_MODELS_PATH` env var with default `removed-models.txt`.

**Contract**: File format is one model ID per line, no headers, no timestamps. Append-only during benchmark run.

#### 4. Cleanup removed-models.txt

**File**: `src/bench-entry.ts`

**Intent**: After fetching the provider catalog, read `removed-models.txt` and remove any model ID that is NOT in `availableModels` (if catalog is available). This purges permanently-removed models automatically.

**Contract**: Read file → filter against `availableModels` → write back. If catalog is null, skip cleanup (don't accidentally empty the file).

### Success Criteria:

#### Automated:

- `npm run build` passes
- `npm test` passes
- Unit test: `removed-models.txt` is created with correct entries after mock benchmark with failures
- Unit test: models not in provider catalog are NOT written to `removed-models.txt`
- Unit test: `removed-models.txt` is cleaned of models not in provider catalog

#### Manual:

- Run `node dist/src/bench-entry.js` with `NIM_API_KEY` set — verify `removed-models.txt` is created/updated
- Verify stderr shows "permanently removed" vs "transient failure" classification

---

## Phase 2: Daily Recheck of Removed Models

### Overview

At the end of the daily benchmark run, read `removed-models.txt`, probe each model, benchmark survivors, and reinsert them into the active list.

### Changes Required:

#### 1. Recheck removed models

**File**: `src/bench-entry.ts`

**Intent**: After the main benchmark + replacement loop (and after writing new entries to `removed-models.txt`), read the file back, probe each model, and if alive, run a full benchmark. Survivors are added to the `results` array and their IDs replace entries in `removed-models.txt`.

**Contract**: Recheck runs AFTER the main benchmark so it doesn't delay the primary results. Rechecked models are appended to the results table. `removed-models.txt` is rewritten with only the models that still failed.

#### 2. Reorder with rechecked models

**File**: No changes needed — `bench-reorder.js` already handles any model in the results table.

**Contract**: Rechecked models flow through the same `rankModels()` → `updateActionYml()` pipeline as normally-benchmarked models.

### Success Criteria:

#### Automated:

- `npm run build` passes
- Unit test: models in `removed-models.txt` that pass probe are benchmarked and appear in results
- Unit test: models that fail probe are left in `removed-models.txt`
- Unit test: models that pass probe but fail benchmark are removed from `removed-models.txt`

#### Manual:

- Create a `removed-models.txt` with a known-good model, run benchmark, verify it's re-tested and reinserted

---

## Phase 3: Auto-Scoring New Models via SWE-bench API + LLM

### Overview

When `listModels()` discovers models not in `SWE_BENCH_SCORES`, fetch scores from the SWE-bench leaderboard API and use an LLM call to match NIM model IDs to API model IDs.

### Changes Required:

#### 1. Fetch SWE-bench leaderboard

**File**: `src/bench-reorder.ts` (new exported function)

**Intent**: Add a `fetchSweBenchScores()` async function that GETs `https://api.zeroeval.com/leaderboard/benchmarks/swe-bench-verified/details`, parses the JSON, and returns an array of `{ modelId: string; score: number }` for the top ~30 models by score. Wrap in `withRetry()`. On failure, return empty array (graceful degradation).

**Contract**: Returns `Array<{ modelId: string; score: number; org: string }>` sorted by score descending. Only includes models with score > 0.5 to filter noise.

#### 2. LLM-based model matching

**File**: `src/bench-entry.ts` (new function)

**Intent**: Add a `matchModelScore()` function that takes a NIM model ID and the fetched leaderboard data, constructs a prompt ("Given these SWE-bench scores: [JSON]. What is the score for NIM model 'org/model-name'? Return just the numeric score."), and calls the best available model to get the match. Uses the first working model from the active list as the "matcher".

**Contract**: Returns `number | null` — the matched score or null if no match found. Uses `maxTokens: 16` for minimal cost. The prompt includes the filtered top-30 leaderboard data as context.

#### 3. Integrate into benchmark flow

**File**: `src/bench-entry.ts`

**Intent**: After `listModels()` discovers new models not in `SWE_BENCH_SCORES`, call `fetchSweBenchScores()` once, then for each new model call `matchModelScore()` to get a real score. If score is found, add to a temporary score map. New models with scores are included in the benchmark run and ranked using their fetched score instead of the default 0.5.

**Contract**: Fetched scores are ephemeral (used only for this run's ranking). They do NOT modify the hardcoded `SWE_BENCH_SCORES` constant. The `getSweBenchScore()` function checks the fetched-score map before falling back to the hardcoded table.

#### 4. Update getSweBenchScore to check fetched scores

**File**: `src/bench-reorder.ts`

**Intent**: Modify `getSweBenchScore()` to accept an optional `fetchedScores` parameter. If provided, check it before the hardcoded `SWE_BENCH_SCORES`. This keeps the function backward-compatible.

**Contract**: `getSweBenchScore(model: string, fetchedScores?: Map<string, number>): number` — checks `fetchedScores?.get(model)` first, then `SWE_BENCH_SCORES[model]`, then 0.5.

### Success Criteria:

#### Automated:

- `npm run build` passes
- Unit test: `fetchSweBenchScores()` parses API response correctly
- Unit test: `matchModelScore()` returns correct score for known NIM models
- Unit test: `getSweBenchScore()` prefers fetched scores over hardcoded
- Unit test: new models with fetched scores are ranked above 0.5 defaults

#### Manual:

- Run with a new NIM model not in `SWE_BENCH_SCORES`, verify it gets a real score and appears in benchmark results

---

## Phase 4: Workflow Updates

### Overview

Update `benchmark.yml` to persist `removed-models.txt` across runs and add the recheck step.

### Changes Required:

#### 1. Checkout with removed-models.txt

**File**: `.github/workflows/benchmark.yml`

**Intent**: The existing `actions/checkout@v4` already checks out the full repo, so `removed-models.txt` (if committed) will be present. No checkout changes needed. Just ensure the commit step includes `removed-models.txt` in `git add`.

**Contract**: `git add action.yml removed-models.txt` in the commit step.

#### 2. Commit removed-models.txt

**File**: `.github/workflows/benchmark.yml`

**Intent**: In the "Commit updated model order" step, add `removed-models.txt` to `git add`. The file should be committed alongside `action.yml` since both are updated in the same run.

**Contract**: Both `action.yml` and `removed-models.txt` are committed together with the same message pattern.

#### 3. Same for Mistral job

**File**: `.github/workflows/benchmark.yml`

**Intent**: The `benchmark-mistral` job should also track removed Mistral models in a separate file `removed-mistral-models.txt` and follow the same pattern.

**Contract**: Separate file for Mistral to avoid cross-contamination of provider catalogs.

### Success Criteria:

#### Automated:

- YAML lint passes on `benchmark.yml`
- `git diff` shows expected changes to commit step

#### Manual:

- Trigger workflow via `workflow_dispatch`, verify `removed-models.txt` appears in the commit

---

## Testing Strategy

### Unit Tests:

- `bench-entry.ts`: mock `OpenAIClient` to simulate failures, verify `removed-models.txt` write/cleanup
- `bench-reorder.ts`: test `fetchSweBenchScores()` with mock API response
- `bench-reorder.ts`: test `getSweBenchScore()` with fetched scores parameter
- `bench-entry.ts`: test `matchModelScore()` with sample leaderboard data

### Integration Tests:

- Full benchmark run with mocked API: verify end-to-end flow (failure → removed-models.txt → recheck → reinsert)

### Manual Testing Steps:

1. Run `node dist/src/bench-entry.js` with real `NIM_API_KEY` — verify full flow
2. Check `removed-models.txt` contents after run
3. Run again — verify recheck of previous failures
4. Verify `action.yml` is updated with correct model order

## Performance Considerations

- `listModels()` adds ~1-2s to benchmark runtime (single HTTP call)
- `fetchSweBenchScores()` adds ~1-2s (single HTTP call to API)
- LLM matching adds ~2-5s per new model (only when new models are discovered)
- Recheck of removed models adds ~5-15s per model (probe + benchmark)
- Total overhead: ~5-30s on a typical daily run (acceptable)

## Migration Notes

- `removed-models.txt` must be committed to the repo on the first run
- Existing models in `action.yml` are unaffected — no migration needed
- `SWE_BENCH_SCORES` hardcoded table remains as fallback — no breaking changes

## References

- Research: `context/changes/model-recheck/research.md`
- API endpoint: `https://api.zeroeval.com/leaderboard/benchmarks/swe-bench-verified/details`
- `listModels()`: `src/openai-client.ts:240-255`
- `probeModel()`: `src/openai-client.ts:228-238`
- `SWE_BENCH_SCORES`: `src/bench-reorder.ts:58-104`
- `getSweBenchScore()`: `src/bench-reorder.ts:109-111`
- `getReplacements()`: `src/bench-entry.ts:48-54`
- Replacement loop: `src/bench-entry.ts:149-193`
- `withRetry()`: `src/retry.ts:10-29`
- Daily benchmark workflow: `.github/workflows/benchmark.yml`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Track Failed Models + Provider Catalog Check

#### Automated

- [x] 1.1 Provider catalog fetch via `listModels()` with graceful degradation — 31ae28c
- [x] 1.2 Failure classification: outage vs. permanent removal — 31ae28c
- [x] 1.3 Write transient failures to `removed-models.txt` — 31ae28c
- [x] 1.4 Cleanup `removed-models.txt` of models no longer in provider catalog — 31ae28c
- [x] 1.5 Unit tests for failure tracking and cleanup — 31ae28c

#### Manual

- [ ] 1.6 Verify `removed-models.txt` is created/updated after real benchmark run

### Phase 2: Daily Recheck of Removed Models

#### Automated

- [x] 2.1 Recheck logic: probe + benchmark survivors from `removed-models.txt` — 94d168d
- [x] 2.2 Update `removed-models.txt` after recheck (remove recovered, keep failed) — 94d168d
- [x] 2.3 Unit tests for recheck flow — 94d168d

#### Manual

- [ ] 2.4 Verify rechecked model is reinserted into action.yml

### Phase 3: Auto-Scoring New Models via SWE-bench API + LLM

#### Automated

- [x] 3.1 `fetchSweBenchScores()` — fetch leaderboard API, parse JSON — 57a4fe0
- [x] 3.2 `matchModelScore()` — LLM-based fuzzy matching of NIM IDs to API IDs — 57a4fe0
- [x] 3.3 Integrate fetched scores into benchmark ranking — 57a4fe0
- [x] 3.4 Update `getSweBenchScore()` to accept fetched scores parameter — 57a4fe0
- [x] 3.5 Unit tests for API fetch, LLM matching, score integration — 57a4fe0

#### Manual

- [ ] 3.6 Verify new model gets real score and appears in benchmark results

### Phase 4: Workflow Updates

#### Automated

- [x] 4.1 Update `benchmark.yml` commit step to include `removed-models.txt` — bd6ea2b
- [x] 4.2 Add `removed-mistral-models.txt` for Mistral job — bd6ea2b
- [x] 4.3 YAML lint passes — bd6ea2b

#### Manual

- [ ] 4.4 Trigger `workflow_dispatch`, verify commit includes `removed-models.txt`
