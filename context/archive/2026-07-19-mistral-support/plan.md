# First-Class Mistral Support — Implementation Plan

## Overview

Add Mistral as a first-class provider with its own `mistral_api_key` and `mistral_models` inputs, mirroring the existing NIM pattern. At runtime, when both keys are present, merge both providers' model lists into a single combined fallback chain sorted by SWE-bench score — routing each model to the correct `NimClient` instance. When only one key is present, use that provider's chain alone.

## Current State Analysis

- `NimClient` (`src/nim-client.ts`) takes `(baseURL, apiKey)` and uses OpenAI-compatible `/chat/completions` — works with Mistral's API as-is.
- `action.yml` has `nim_api_key` (required), `nim_models` (CSV fallback chain), and related inputs.
- `src/index.ts` iterates `config.models` sequentially — first success wins.
- `src/review.ts` defines `Config` interface and `reviewFileWithFallback()` which also iterates the model list.
- `src/bench-reorder.ts` has `SWE_BENCH_SCORES` map with NIM-proxy IDs only.
- `.github/workflows/benchmark.yml` runs a single NIM benchmark job.

### Key Discoveries:

- `NimClient` constructor at `src/nim-client.ts:56-57` — reusable for Mistral with `baseURL='https://api.mistral.ai/v1'`
- `src/index.ts:71-88` — model fallback loop, needs replacement with combined chain logic
- `src/bench-entry.ts:77` — reads `NIM_API_KEY` env; benchmark is endpoint-agnostic (just env vars)
- `src/bench-reorder.ts:63-92` — score map has NIM-proxy Mistral IDs (e.g. `mistralai/mistral-medium-3.5-128b`) but NOT direct API IDs (`mistral-medium-3.5`)
- `action.yml` — `nim_api_key` is currently `required: true`

## Desired End State

Users can provide `mistral_api_key` alone, `nim_api_key` alone, or both. When both are present, the action merges both model lists into a single fallback chain ordered by SWE-bench score and tries them one by one — routing each model to the correct client. A separate benchmark job tracks Mistral model performance independently, and the reorder system updates `mistral_models` in `action.yml` just as it does for `nim_models`.

**Verification**: Run `npm test` — all existing + new tests pass. Set only `mistral_api_key` → action uses Mistral chain. Set only `nim_api_key` → action uses NIM chain (existing behavior). Set both → action uses combined chain sorted by score.

## What We're NOT Doing

- Generic custom API support (separate `custom-api-support` change)
- Changing `NimClient` internals (it already works for Mistral)
- Adding streaming support for Mistral (it works, just not exercised differently)
- Renaming `NimClient` to something generic (future refactor)
- Adding Mistral-specific error handling beyond what NIM already does

## Implementation Approach

1. Add inputs and make `nim_api_key` optional (require at least one key at runtime).
2. Introduce a `TaggedModel` type that pairs a model ID with its provider, and a function that merges both lists by SWE-bench score.
3. Replace the flat model iteration loop with a combined-chain loop that routes each tagged model to the correct client.
4. Add Mistral direct-API model IDs to the SWE-bench score map.
5. Add a `benchmark-mistral` workflow job + reorder logic for `mistral_models`.

---

## Phase 1: Config & Inputs

### Overview

Add `mistral_api_key` and `mistral_models` to `action.yml` and the `Config` interface. Make `nim_api_key` optional — validate at runtime that at least one key is present.

### Changes Required:

#### 1. Action inputs

**File**: `action.yml`

**Intent**: Add two new inputs (`mistral_api_key`, `mistral_models`) and change `nim_api_key` from required to optional.

**Contract**: `mistral_api_key` — string, default `''`. `mistral_models` — string, default `'mistral-medium-3.5,mistral-large-2512,mistral-small-2603,codestral-2508'`. `nim_api_key` — change `required: true` to `required: false` with default `''`.

#### 2. Config interface and loader

**File**: `src/review.ts`

**Intent**: Extend `Config` with `mistralApiKey` and `mistralModels` fields. Load them from action inputs in `loadConfig()`.

**Contract**: Add to `Config` interface:
```typescript
mistralApiKey: string;
mistralModels: string[];
```
Add to `loadConfig()` return object — same `splitCSV` + `core.getInput` pattern as existing fields.

#### 3. Runtime key validation

**File**: `src/index.ts`

**Intent**: Replace the hard `throw` on missing `NIM_API_KEY` with a check that at least one of `config.apiKey` or `config.mistralApiKey` is present. Fail with a clear message if neither is set.

**Contract**: Error message: `'At least one of nim_api_key or mistral_api_key is required'`.

### Success Criteria:

#### Automated Verification:

- TypeScript compiles: `npm run build`
- Existing tests pass: `npm test`
- Config correctly reads new inputs (unit test)

#### Manual Verification:

- Action fails with clear message when neither key is provided

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Combined Fallback Chain

### Overview

Build the unified model fallback logic: merge Mistral + NIM models into a single list sorted by SWE-bench score, try each model in order, route to the correct client.

### Changes Required:

#### 1. TaggedModel type and merge function

**File**: `src/model-chain.ts` (new file)

**Intent**: Define a `TaggedModel` type (model ID + provider tag) and a `buildCombinedChain()` function that merges two model lists, sorting by SWE-bench score descending.

**Contract**:
```typescript
export type Provider = 'nim' | 'mistral';

export interface TaggedModel {
  id: string;
  provider: Provider;
}

export function buildCombinedChain(
  nimModels: string[],
  mistralModels: string[],
  hasNimKey: boolean,
  hasMistralKey: boolean,
): TaggedModel[];
```

Logic: include only models whose provider key is available. Sort by `getSweBenchScore(id)` descending. Stable sort — preserve original order within same score.

#### 2. Update main fallback loop

**File**: `src/index.ts`

**Intent**: Replace the flat `for (const model of config.models)` loop with a loop over `buildCombinedChain()` output, instantiating the correct client per model.

**Contract**: Create both clients conditionally at the top:
```typescript
const nimClient = config.apiKey ? new NimClient(config.baseURL, config.apiKey) : null;
const mistralClient = config.mistralApiKey ? new NimClient(MISTRAL_BASE_URL, config.mistralApiKey) : null;
```
Loop over `TaggedModel[]`, pick client by `model.provider`. On failure, log and continue to next. `MISTRAL_BASE_URL = 'https://api.mistral.ai/v1'` constant.

#### 3. Update reviewFileWithFallback

**File**: `src/review.ts`

**Intent**: Change `reviewFileWithFallback()` to accept a `TaggedModel[]` chain and a client map, instead of a single client + model list.

**Contract**: New signature:
```typescript
export async function reviewFileWithFallback(
  clients: Record<Provider, NimClient | null>,
  filePath: string,
  diff: string,
  chain: TaggedModel[],
  config: Config,
): Promise<string>;
```
Iterates `chain`, picks `clients[model.provider]`, calls `reviewFile()`. Skips if client is null (shouldn't happen given `buildCombinedChain` filtering).

### Success Criteria:

#### Automated Verification:

- TypeScript compiles: `npm run build`
- All tests pass: `npm test`
- New unit tests for `buildCombinedChain()` cover: NIM-only, Mistral-only, combined, empty cases
- New unit tests for updated `reviewFileWithFallback()` verify routing

#### Manual Verification:

- With only `mistral_api_key` set, action uses Mistral models
- With only `nim_api_key` set, action uses NIM models (existing behavior preserved)
- With both keys, combined chain is used in SWE-bench score order

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: SWE-bench Score Map

### Overview

Add direct Mistral API model IDs (and their aliases) to the `SWE_BENCH_SCORES` map so the combined chain sorts them correctly against NIM models.

### Changes Required:

#### 1. Add Mistral direct-API entries

**File**: `src/bench-reorder.ts`

**Intent**: Add entries for `mistral-medium-3.5`, `mistral-large-2512`, `mistral-small-2603`, `codestral-2508` and their `-latest` aliases to `SWE_BENCH_SCORES`.

**Contract**: New entries in `SWE_BENCH_SCORES`:
```typescript
// Direct Mistral API model IDs
'mistral-medium-3.5': 0.776,
'mistral-medium-latest': 0.776,
'mistral-large-2512': 0.720,
'mistral-large-latest': 0.720,
'mistral-small-2603': 0.680,
'mistral-small-latest': 0.680,
'codestral-2508': 0.650,
'codestral-latest': 0.650,
```

#### 2. Add Mistral reorder function

**File**: `src/bench-reorder.ts`

**Intent**: Add `updateActionYmlMistral()` function that updates the `mistral_models` default in `action.yml`, mirroring `updateActionYml()` for `nim_models`.

**Contract**: Same regex-replace pattern as `updateActionYml()` but targeting the `mistral_models` input block.

### Success Criteria:

#### Automated Verification:

- `npm run build` passes
- `npm test` passes
- Existing `bench-reorder.test.ts` tests still pass
- New test: `getSweBenchScore('mistral-medium-3.5')` returns `0.776`
- New test: `updateActionYmlMistral()` correctly replaces `mistral_models` default

#### Manual Verification:

- None required — pure data + function addition

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 4: Benchmark Workflow

### Overview

Add a `benchmark-mistral` job to the daily benchmark workflow, guarded by `secrets.MISTRAL_API_KEY`. Add a reorder step that updates `mistral_models` in `action.yml`.

### Changes Required:

#### 1. Add benchmark-mistral job

**File**: `.github/workflows/benchmark.yml`

**Intent**: Add a new job that benchmarks Mistral models via the same `bench-entry.js` script, using `NIM_BASE_URL=https://api.mistral.ai/v1` and `NIM_API_KEY=${{ secrets.MISTRAL_API_KEY }}`.

**Contract**: Job structure mirrors existing `benchmark` job. Guarded by `if: ${{ secrets.MISTRAL_API_KEY != '' }}`. Uses `NIM_MODELS` env var set to current `mistral_models` default from `action.yml`. Reorder step pipes table output through a new `bench-reorder-mistral.js` or reuses `bench-reorder.js` with an env var to target `mistral_models`.

#### 2. Support target input in bench-reorder

**File**: `src/bench-reorder.ts`

**Intent**: Read an `ACTION_TARGET` env var (default: `nim_models`) to choose which input block to reorder. When `ACTION_TARGET=mistral_models`, use the `updateActionYmlMistral()` function.

**Contract**: `main()` checks `process.env.ACTION_TARGET || 'nim_models'` and calls the appropriate update function.

#### 3. Commit step handles both inputs

**File**: `.github/workflows/benchmark.yml`

**Intent**: The commit step in the Mistral job commits `action.yml` changes for `mistral_models` with the same amend-or-create logic as the NIM job.

**Contract**: Same git commit pattern; message: `"chore: update mistral model order from daily benchmark [skip ci]"`.

### Success Criteria:

#### Automated Verification:

- `npm run build` passes
- `npm test` passes
- Workflow YAML is valid (no syntax errors)

#### Manual Verification:

- Trigger `workflow_dispatch` on benchmark workflow — both jobs run (or Mistral skips if secret not set)
- Mistral reorder updates `mistral_models` in `action.yml` correctly

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 5: Tests & Documentation

### Overview

Add comprehensive tests for the new combined chain logic and update the README with Mistral usage examples.

### Changes Required:

#### 1. Combined chain unit tests

**File**: `src/model-chain.test.ts` (new file)

**Intent**: Test `buildCombinedChain()` for all provider combinations: NIM-only, Mistral-only, combined. Verify sort order matches SWE-bench scores.

**Contract**: Use `node:test` + `node:assert` pattern matching existing test files.

#### 2. Update review.test.ts

**File**: `src/review.test.ts`

**Intent**: Add tests for the updated `reviewFileWithFallback()` signature — verify it routes to correct client and falls through on failure.

**Contract**: Mock clients, verify call routing by provider tag.

#### 3. Update bench-reorder.test.ts

**File**: `src/bench-reorder.test.ts`

**Intent**: Add tests for new Mistral score entries and `updateActionYmlMistral()`.

**Contract**: Test `getSweBenchScore('mistral-medium-3.5')` returns `0.776`. Test `updateActionYmlMistral()` with sample action.yml content.

#### 4. README update

**File**: `README.md`

**Intent**: Document Mistral support — new inputs, usage examples for Mistral-only and combined modes.

**Contract**: Add a "Mistral Support" section showing workflow YAML examples.

### Success Criteria:

#### Automated Verification:

- `npm test` passes with all new tests
- `npm run build` passes

#### Manual Verification:

- README examples are accurate and clear

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Testing Strategy

### Unit Tests:

- `buildCombinedChain()` — NIM-only, Mistral-only, combined, empty arrays, unknown models (score 0.5)
- `reviewFileWithFallback()` — routes to correct client, falls through on error, returns first success
- `getSweBenchScore()` — returns correct scores for new Mistral IDs
- `updateActionYmlMistral()` — regex replacement works
- `loadConfig()` — reads new inputs correctly

### Integration Tests:

- Full action run with mock server — Mistral-only config
- Full action run with mock server — combined config
- Fallback behavior — first model fails, second succeeds across providers

### Manual Testing Steps:

1. Set only `mistral_api_key` in a test workflow → verify action runs with Mistral chain
2. Set only `nim_api_key` → verify existing behavior unchanged
3. Set both keys → verify combined chain order matches expected SWE-bench sort
4. Set neither key → verify clear error message

## Performance Considerations

- Combined chain adds negligible overhead — it's a sort of ~11 items at startup.
- No additional API calls beyond what the current fallback loop does — just routing to different clients.
- Mistral API has similar latency characteristics to NIM; no timeout changes needed.

## Migration Notes

- Existing users with only `nim_api_key` → zero changes needed, behavior identical.
- `nim_api_key: required: true` → `required: false` is a non-breaking change (GitHub Actions treats missing optional inputs as empty string).
- No data migration required.

## References

- Related research: `context/changes/mistral-support/research.md`
- NIM client reuse: `src/nim-client.ts:56-57`
- Existing fallback loop: `src/index.ts:71-88`
- Config interface: `src/review.ts:28-44`
- SWE-bench scores: `src/bench-reorder.ts:63-92`
- Benchmark workflow: `.github/workflows/benchmark.yml`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Config & Inputs

#### Automated

- [x] 1.1 TypeScript compiles: `npm run build` — 9b8d8c0
- [x] 1.2 Existing tests pass: `npm test` — 9b8d8c0
- [x] 1.3 Config correctly reads new inputs (unit test) — 9b8d8c0

#### Manual

- [ ] 1.4 Action fails with clear message when neither key is provided

### Phase 2: Combined Fallback Chain

#### Automated

- [x] 2.1 TypeScript compiles: `npm run build` — f59fd8b
- [x] 2.2 All tests pass: `npm test` — f59fd8b
- [x] 2.3 Unit tests for `buildCombinedChain()` cover NIM-only, Mistral-only, combined, empty — f59fd8b
- [x] 2.4 Unit tests for updated `reviewFileWithFallback()` verify routing — f59fd8b

#### Manual

- [ ] 2.5 Mistral-only key: action uses Mistral models
- [ ] 2.6 NIM-only key: existing behavior preserved
- [ ] 2.7 Both keys: combined chain in SWE-bench score order

### Phase 3: SWE-bench Score Map

#### Automated

- [x] 3.1 `npm run build` passes — e4c70df
- [x] 3.2 `npm test` passes — e4c70df
- [x] 3.3 `getSweBenchScore('mistral-medium-3.5')` returns `0.776` — e4c70df
- [x] 3.4 `updateActionYmlMistral()` correctly replaces `mistral_models` default — e4c70df

### Phase 4: Benchmark Workflow

#### Automated

- [x] 4.1 `npm run build` passes — 5b0c25b
- [x] 4.2 `npm test` passes — 5b0c25b
- [x] 4.3 Workflow YAML is valid — 5b0c25b

#### Manual

- [ ] 4.4 Workflow dispatch — both jobs run
- [ ] 4.5 Mistral reorder updates `mistral_models` in `action.yml`

### Phase 5: Tests & Documentation

#### Automated

- [x] 5.1 `npm test` passes with all new tests — 25a4264
- [x] 5.2 `npm run build` passes — 25a4264

#### Manual

- [ ] 5.3 README examples are accurate and clear
