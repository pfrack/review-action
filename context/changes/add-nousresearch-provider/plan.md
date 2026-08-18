---
change_id: add-nousresearch-provider
title: Add NousResearch as a first-class provider with free models
status: planning
created: 2025-08-18
updated: 2026-08-18
archived_at: null
---

# Implementation Plan: Add NousResearch Provider

## Overview

Add NousResearch inference API (`https://inference-api.nousresearch.com/v1`) as a 6th first-class provider slot in the NIM Code Review GitHub Action, following the exact same pattern as the kilocode and openrouter additions. The provider is OpenAI-compatible. The default model list contains only free-tier models (those with `:free` suffix). A `nousresearch_free_only` input mirrors `kilocode_free_only`.

### API Details (confirmed via live API probe)

- **Base URL**: `https://inference-api.nousresearch.com/v1`
- **Auth**: Bearer token via `NOUSRESEARCH_API_KEY` secret
- **Endpoint**: Standard OpenAI `/chat/completions` + `/models`

### Free model IDs (from `/v1/models`, all priced at $0.00)

| Model ID | Pricing |
|---|---|
| `poolside/laguna-s-2.1:free` | prompt=$0, completion=$0 |
| `poolside/laguna-xs-2.1:free` | prompt=$0, completion=$0 |
| `tencent/hy3:free` | prompt=$0, completion=$0 |
| `stepfun/step-3.7-flash:free` | prompt=$0, completion=$0 |
| `upstage/solar-pro4:free` | prompt=$0, completion=$0 |
| `meituan/longcat-2.0:free` | prompt=$0, completion=$0 |

### Paid models (NOT in the free-only default chain)

| Model ID | Pricing |
|---|---|
| `nousresearch/hermes-4-70b` | $0.05/M in / $0.20/M out |
| `nousresearch/hermes-4-405b` | $0.09/M in / $0.37/M out |

> **Note**: The Hermes-4 models are NOT free through the NousResearch API. They are paid. Only the `:free` suffixed models are free. This was confirmed by querying the live `/v1/models` pricing endpoint.

## Current State Analysis

The action currently supports 5 first-class provider slots + 1 custom slot:

| Provider | key input | base_url input | models input | free_only input |
|---|---|---|---|---|
| NIM | `nim_api_key` | `nim_base_url` | `nim_models` | — |
| Mistral | `mistral_api_key` | `mistral_base_url` | `mistral_models` | — |
| Groq | `groq_api_key` | `groq_base_url` | `groq_models` | — |
| OpenRouter | `openrouter_api_key` | `openrouter_base_url` | `openrouter_models` | `openrouter_free_only` |
| Kilo | `kilocode_api_key` | `kilocode_base_url` | `kilocode_models` | `kilocode_free_only` |
| Custom | `custom_api_url`+`custom_api_key` | `custom_model`/`custom_models` | — | — |

Each first-class provider touches exactly these files (the Groq/Mistral/OpenRouter/Kilo precedent — ~10 files, ~150 LOC per provider):

1. `action.yml` — 3 new inputs + 1 free_only input
2. `src/config.ts` — Config interface fields + loadConfig() parsing
3. `src/model-chain.ts` — Provider union type + ChainOptions + buildCombinedChain inclusion
4. `src/index.ts` — buildClients() + validateConfig() + buildCombinedChain call args
5. `src/openai-client.ts` — providerLabel/providerKey auto-detection by domain
6. `src/bench-reorder.ts` — SWE_BENCH_SCORES + ActionTarget + TARGET_CONFIG + updateActionYml helper
7. `.github/workflows/benchmark-nousresearch.yml` — daily benchmark job
8. `nousresearch-model-history.json` — model availability tracking
9. Tests across config.test.ts, model-chain.test.ts, bench-reorder.test.ts, openai-client.test.ts, review.test.ts, index.test.ts
10. `README.md` — documentation section

## What We're Doing

Add NousResearch as a first-class provider with **free-only** default model list. Mirrors the kilocode pattern exactly — the user can set `nousresearch_api_key` and get free models auto-configured, with a `nousresearch_free_only` filter input.

## What We're NOT Doing

- **Paid Hermes-4 models are not in the default chain.** They are available if a user explicitly lists them in `nousresearch_models`, but the default chain contains only `:free` models. This matches the kilocode pattern where defaults are free-tier only.
- **No daily benchmark job initially.** Free models are volatile (IDs change frequently). We follow the OpenRouter pattern of auto-discovering free models via the `/models` endpoint rather than benchmarking (see `config.ts:170-175` — `fetchFreeModels()` is called when no explicit model list is provided). The benchmark workflow can be added later if stable free model identities emerge.
- **No SWE-bench scores for free models.** Free models are forced to rank last in the chain regardless of score. Estimated scores (0.5) are returned by `getSweBenchScore()` for unknown IDs (`bench-reorder.ts:220-222`). This is the same pattern as kilo's `kilo-auto/free` (score 0.5).

## Implementation Steps

### Phase 1: Config + Chain Infrastructure

#### Step 1 — action.yml inputs

Add after the kilocode block (`action.yml:58-60`) and before `custom_models`:

```yaml
  nousresearch_api_key:
    description: 'NousResearch inference API key (enables NousResearch free-tier models in fallback chain)'
    required: false
    default: ''
  nousresearch_base_url:
    description: 'NousResearch inference API base URL'
    default: 'https://inference-api.nousresearch.com/v1'
  nousresearch_models:
    description: 'Comma-separated NousResearch model fallback chain (defaults to all free-tier models from provider when empty)'
    default: 'poolside/laguna-s-2.1:free,poolside/laguna-xs-2.1:free,tencent/hy3:free,stepfun/step-3.7-flash:free,upstage/solar-pro4:free,meituan/longcat-2.0:free'
  nousresearch_free_only:
    description: 'Filter NousResearch models to only use free-tier (:free suffix) models'
    default: 'false'
```

#### Step 2 — Config interface + loadConfig (`src/config.ts`)

Add to the `Config` interface (after `kiloFreeOnly`):
```ts
nousApiKey: string;
nousBaseUrl: string;
nousModels: string[];
nousFreeOnly: boolean;
```

Add in `loadConfig()` initial config object (after kilo fields):
```ts
nousApiKey: core.getInput('nousresearch_api_key') || '',
nousBaseUrl: core.getInput('nousresearch_base_url') || 'https://inference-api.nousresearch.com/v1',
nousModels: [],
nousFreeOnly: core.getInput('nousresearch_free_only') === 'true',
```

Add in the model-fetching section (after the kilo block at `config.ts:170-175`):
```ts
const nousInput = splitCSV(core.getInput('nousresearch_models'));
if (nousInput.length > 0) {
  config.nousModels = filterFreeOnly(nousInput, config.nousFreeOnly, 'NousResearch');
} else if (config.nousApiKey) {
  config.nousModels = await fetchFreeModels(config.nousBaseUrl, config.nousApiKey, 'NousResearch');
}
```

#### Step 3 — Provider type + ChainOptions + buildCombinedChain (`src/model-chain.ts`)

- Line 4: `'nousresearch'` added to `Provider` union type
- `ChainOptions`: add `nousModels?: string[]`, `hasNousKey?: boolean`
- `buildCombinedChain()`: add a block mirroring the kilo block (`model-chain.ts:94-98`):
```ts
if (hasNousKey) {
  for (const id of nousModels) {
    providerModels.push({ id, provider: 'nousresearch' });
  }
}
```

#### Step 4 — Custom models CSV (already implemented)

The `custom_models` CSV was added in the `openrouter-provider` change. No new work needed — it already benefits NousResearch.

### Phase 2: Client + Index Integration

#### Step 1 — OpenAIClient provider detection (`src/openai-client.ts`)

Lines 229-235 (providerLabel) and 236-242 (providerKey): add:
```ts
baseURL.includes('nousresearch') ? 'NousResearch' :
// and
baseURL.includes('nousresearch') ? 'nousresearch' :
```

#### Step 2 — buildClients + validateConfig (`src/index.ts`)

- `buildClients()` (line 453-462): add:
  ```ts
  nousresearch: config.nousApiKey ? new OpenAIClient(config.nousBaseUrl, config.nousApiKey, 'NousResearch') : null,
  ```
- `validateConfig()`: add `if (config.nousApiKey) core.setSecret(config.nousApiKey);` and URL validation
- Update the "at least one key required" check (line 438) to include `!config.nousApiKey`
- Update key-gate fallbacks (lines 441, 444) to include NousResearch

#### Step 3 — Chain building (`src/index.ts:661-677`)

Add to the `buildCombinedChain()` call:
```ts
nousModels: config.nousModels,
hasNousKey: !!config.nousApiKey,
```

### Phase 3: SWE-Bench Scores + Bench Reorder

#### Step 1 — SWE_BENCH_SCORES (`src/bench-reorder.ts`)

Add entries for the free models (all estimated at 0.5, same as kilo's free models):
```ts
// NousResearch free-tier models (estimated scores)
'poolside/laguna-s-2.1:free': 0.5,
'poolside/laguna-xs-2.1:free': 0.5,
'tencent/hy3:free': 0.5,
'stepfun/step-3.7-flash:free': 0.5,
'upstage/solar-pro4:free': 0.5,
'meituan/longcat-2.0:free': 0.5,
```

#### Step 2 — ActionTarget + TARGET_CONFIG (`src/bench-reorder.ts:307-318`)

Add `'nousresearch_models'` to the `ActionTarget` type and `TARGET_CONFIG` record.

#### Step 3 — updateActionYml helper (`src/bench-reorder.ts:359-365`)

Add:
```ts
export function updateActionYmlNousResearch(actionPath: string, orderedModels: string[]): void {
  updateActionYml(actionPath, orderedModels, 'nousresearch_models');
}
```

### Phase 4: Tests

Update all `Record<Provider, OpenAIClient | null>` literals in tests to include `nousresearch: null`:

- **`src/config.test.ts`** — Add NousResearch-specific test fixtures (config parsing for new fields, free-only filtering)
- **`src/model-chain.test.ts`** — Add NousResearch chain test cases (free-last ordering, no key exclusion). Already has kilo test patterns at lines 268-289, 423-446.
- **`src/bench-reorder.test.ts`** — Add `updateActionYmlNousResearch` test case mirroring `updateActionYmlKilocode` (line 331-372)
- **`src/openai-client.test.ts`** — Verify `nousresearch` domain auto-detection
- **`src/review.test.ts`** — Add `nousresearch: null` to all `clients` Record<Provider> literals

### Phase 5: Docs + Workflow

#### Step 1 — README.md

Add a "NousResearch Support" section after the Kilo section (after line 262), + Inputs table rows. Include the privacy note (free models route through third-party providers).

#### Step 2 — Benchmark workflow (optional, deferred)

Following the OpenRouter pattern (`benchmark-openrouter.yml`), a `benchmark-nousresearch.yml` can be added later with `auto_free: true` and `action_target: nousresearch_models`. Not included in v1 since free models are volatile and the `fetchFreeModels` auto-discovery in `config.ts` already handles this path.

## Files to Modify

```
action.yml
src/config.ts
src/model-chain.ts
src/index.ts
src/openai-client.ts
src/bench-reorder.ts
src/config.test.ts
src/model-chain.test.ts
src/bench-reorder.test.ts
src/openai-client.test.ts
src/review.test.ts
README.md
```

## Success Criteria

- `npm run build` — TypeScript compiles without errors
- `npm test` — All existing + new tests pass
- `npm run typecheck` — No type errors (Record<Provider> fully covers `nousresearch`)
- Action accepts `nousresearch_api_key` input
- Default model chain includes 6 free models from NousResearch
- `nousresearch_free_only` filter works (verified in config tests)
- No key configured → NousResearch models excluded from chain (verified in model-chain tests)
- Free models rank last in combined chain (existing free-last rule at `model-chain.ts:106-109`)

## References

- Kilo provider pattern (already implemented): `action.yml:48-60`, `src/config.ts:22-25,170-175`, `src/model-chain.ts:4,36-37,94-98`, `src/index.ts:453-462`, `src/openai-client.ts:229-242`, `src/bench-reorder.ts:307-365`
- OpenRouter provider pattern (same shape): `action.yml:35-47`, `src/config.ts:18-21,163-168`
- Free model auto-discovery: `src/config.ts:194-205` (`fetchFreeModels` queries `/models` endpoint and filters to free-tier)
- Kilo benchmark workflow: `.github/workflows/benchmark-kilocode.yml` (uses `benchmark-template.yml` with `auto_free: true`)
- Kilo model history: `kilocode-model-history.json` (tracks model availability over time)
- SWE-bench free model scores: `src/bench-reorder.ts:186-214` (estimated scores, 0.5 default)
- NousResearch API: `https://inference-api.nousresearch.com/v1` (confirmed OpenAI-compatible via live API probe)

## Progress

- [x] Phase 1: Config + Chain Infrastructure
- [x] Phase 2: Client + Index Integration
- [x] Phase 3: Bench-Rank + SWE-Bench Scores
- [x] Phase 4: Tests + Docs + Workflows
- [x] Phase 5: End-to-End Verification (600 tests pass, build clean)

### Phase 5: Docs + Workflow

#### Completed
- [x] 5.1 NousResearch Support section added to README (free models documented, privacy note, free-only filter)
- [x] 5.2 `nousresearch-model-history.json` created with initial free model list
- [x] 5.3 `benchmark-nousresearch.yml` workflow created (mirrors `benchmark-kilocode.yml`)
