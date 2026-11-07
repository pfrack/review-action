# Custom API Support Implementation Plan

## Overview

Add generic custom API endpoint support — three new action inputs (`custom_api_url`, `custom_model`, `custom_api_key`) that create a `NimClient` instance tried **first** in the fallback chain before Mistral and NIM models. On failure, falls through silently to the existing scored chain.

## Current State Analysis

The action already supports multi-provider fallback via a `Provider` type union, a `Record<Provider, NimClient | null>` clients map, and a `TaggedModel[]` chain sorted by SWE-bench score. Adding a new provider follows the same pattern as the Mistral integration.

### Key Discoveries:

- `src/model-chain.ts:3` — `Provider` type is `'nim' | 'mistral'`; add `'custom'`
- `src/model-chain.ts:18-41` — `buildCombinedChain()` builds the scored chain; custom model gets prepended after chain is built
- `src/index.ts:40-44` — clients map instantiation point; add custom client here
- `src/review.ts:17-26` — `Config` interface; add three new fields
- `src/review.ts:33-47` — `loadConfig()`; add three new `getInput()` calls
- `action.yml` — add three new inputs
- `NimClient` constructor accepts any baseURL + apiKey — works for custom endpoints unchanged

## Desired End State

Users can configure any OpenAI-compatible endpoint (OpenRouter, Ollama, vLLM, Together AI, Groq, etc.) via `custom_api_url` + `custom_model` + optional `custom_api_key`. When configured, this model is tried first. On failure, the existing Mistral → NIM fallback chain handles the review. The PR comment shows which model was actually used.

Verification: configure `custom_api_url` and `custom_model` with a valid endpoint, trigger a PR review, and confirm the custom model is attempted first and its name appears in the review comment.

## What We're NOT Doing

- Multiple custom models (CSV) — single model only for now
- Custom timeout configuration — uses existing 180s
- SWE-bench score lookup for custom models — always prepended first
- Benchmark integration — custom models excluded from daily bench
- Streaming support for custom endpoint — uses same non-streaming path as other providers

## Implementation Approach

Extend the existing multi-provider pattern:
1. Add `'custom'` to the `Provider` type
2. Add three config fields + action inputs
3. Instantiate a custom `NimClient` when URL + model are present
4. Prepend the custom `TaggedModel` to the front of the combined chain (before SWE-bench sorted models)
5. Everything else (fallback loop, PR comment, model display) works unchanged

## Phase 1: Config & Inputs

### Overview

Add the three new action inputs and corresponding Config fields. This is the foundation all other changes build on.

### Changes Required:

#### 1. Action inputs

**File**: `action.yml`

**Intent**: Add `custom_api_url`, `custom_model`, and `custom_api_key` inputs with empty defaults, placed after the Mistral inputs block.

**Contract**: Three new input entries with `required: false` and `default: ''`.

#### 2. Config interface and loader

**File**: `src/review.ts`

**Intent**: Add `customApiUrl`, `customModel`, and `customApiKey` fields to the `Config` interface and read them in `loadConfig()`.

**Contract**: Three new string fields on `Config`. In `loadConfig()`, read via `core.getInput('custom_api_url') || ''` (same pattern as existing fields). `customApiKey` defaults to empty string (supports keyless endpoints like local Ollama).

### Success Criteria:

#### Automated Verification:

- TypeScript compiles: `npm run build`
- Tests pass: `npm test`

#### Manual Verification:

- None for this phase

---

## Phase 2: Provider Type & Chain Building

### Overview

Extend the `Provider` type and `buildCombinedChain()` to support a custom model prepended before the scored chain.

### Changes Required:

#### 1. Provider type

**File**: `src/model-chain.ts`

**Intent**: Add `'custom'` to the `Provider` type union.

**Contract**: `export type Provider = 'nim' | 'mistral' | 'custom';`

#### 2. Chain builder

**File**: `src/model-chain.ts`

**Intent**: Accept optional custom model parameter and prepend it to the chain before the SWE-bench sorted models.

**Contract**: `buildCombinedChain()` gains two new optional parameters: `customModel?: string` and `hasCustomKey?: boolean` (where "has key" means both URL and model are configured — the API key itself can be empty). When `customModel` is provided and `hasCustomKey` is true, prepend `{ id: customModel, provider: 'custom' }` to the chain after the sort. This ensures custom is always tried first regardless of score.

#### 3. Chain builder tests

**File**: `src/model-chain.test.ts`

**Intent**: Add test cases verifying custom model is prepended first and that omitting custom params yields unchanged behavior.

**Contract**: New `describe` block testing: (a) custom model prepended before scored models, (b) custom model absent when params not provided, (c) custom model absent when `hasCustomKey` is false.

### Success Criteria:

#### Automated Verification:

- TypeScript compiles: `npm run build`
- Tests pass: `npm test`

#### Manual Verification:

- None for this phase

---

## Phase 3: Client Instantiation & Integration

### Overview

Wire up the custom client in `src/index.ts` — instantiate it when configured, add it to the clients map, and pass the custom model to `buildCombinedChain()`.

### Changes Required:

#### 1. Custom client instantiation

**File**: `src/index.ts`

**Intent**: Create a `NimClient` for the custom endpoint when `config.customApiUrl` and `config.customModel` are both non-empty. Add it to the clients map under the `'custom'` key.

**Contract**: `clients` map type becomes `Record<Provider, NimClient | null>` with a `custom` key. The custom client is `new NimClient(config.customApiUrl, config.customApiKey)` when both URL and model are set, otherwise `null`.

#### 2. Chain building call

**File**: `src/index.ts`

**Intent**: Pass custom model and availability flag to `buildCombinedChain()`.

**Contract**: Add `config.customModel` and `!!(config.customApiUrl && config.customModel)` as the new optional arguments to the `buildCombinedChain()` call.

#### 3. Validation update

**File**: `src/index.ts`

**Intent**: Update the "at least one key required" validation to also accept custom as a valid provider (custom alone is sufficient — it has its own fallback-less path, but NIM/Mistral are recommended as safety net).

**Contract**: The existing check `if (!config.apiKey && !config.mistralApiKey)` becomes `if (!config.apiKey && !config.mistralApiKey && !(config.customApiUrl && config.customModel))` — allow running with only custom configured, though logging a warning that no fallback is available.

### Success Criteria:

#### Automated Verification:

- TypeScript compiles: `npm run build`
- Tests pass: `npm test`

#### Manual Verification:

- Configure with a custom endpoint (e.g., OpenRouter) and trigger a review; confirm custom model is tried first and its name appears in the PR comment

---

## Testing Strategy

### Unit Tests:

- `model-chain.test.ts`: custom model prepended before scored chain; absent when not configured
- `review.test.ts`: `loadConfig()` reads new fields correctly (extend existing `loadConfig` test block)

### Integration Tests:

- Existing `reviewFileWithFallback` tests already cover the fallback loop via `TaggedModel[]` chain — custom being first in chain is exercised by the model-chain unit tests

### Manual Testing Steps:

1. Configure `custom_api_url` + `custom_model` with OpenRouter, trigger PR review, confirm custom model used
2. Configure custom with an invalid URL, confirm it falls through to NIM/Mistral chain
3. Configure only `custom_api_url` without `custom_model`, confirm custom is skipped entirely

## Performance Considerations

No performance impact — the custom model is one additional attempt at position 0 in the existing sequential loop. If it fails, the existing chain proceeds as before. The 180s timeout is unchanged.

## References

- Related research: `context/changes/custom-api-support/research.md`
- Mistral integration (same pattern): `context/changes/mistral-support/`
- Provider/chain architecture: `src/model-chain.ts`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Config & Inputs

#### Automated

- [x] 1.1 TypeScript compiles: `npm run build` — 0e4d5aa
- [x] 1.2 Tests pass: `npm test` — 0e4d5aa

### Phase 2: Provider Type & Chain Building

#### Automated

- [x] 2.1 TypeScript compiles: `npm run build`
- [x] 2.2 Tests pass: `npm test`

### Phase 3: Client Instantiation & Integration

#### Automated

- [x] 3.1 TypeScript compiles: `npm run build` — 455e034
- [x] 3.2 Tests pass: `npm test` — 455e034

#### Manual

- [ ] 3.3 Custom endpoint used first and model name shown in PR comment
