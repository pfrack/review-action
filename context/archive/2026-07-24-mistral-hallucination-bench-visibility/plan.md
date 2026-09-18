# Add Groq Provider + Bench Ranking Visibility — Implementation Plan

## Overview

Add Groq as a fourth provider in the model chain (mixed with NIM/Mistral by SWE-bench score, Custom always first). Groq uses `json_schema` format natively. Also surface the daily bench ranking in GITHUB_STEP_SUMMARY.

## Current State Analysis

- Provider type: `'nim' | 'mistral' | 'custom'`
- `buildCombinedChain()` merges NIM + Mistral models, sorts by SWE-bench score, prepends Custom
- Mistral uses `tools` format workaround via `providerToFormat()`
- `bench-reorder.ts` prints ranking to stdout but never writes to GITHUB_STEP_SUMMARY
- Benchmark workflow has separate jobs for NIM and Mistral; "Show results" only shows raw table

### Key Discoveries:

- `src/model-chain.ts:3` — Provider type definition
- `src/model-chain.ts:28-50` — `buildCombinedChain()` merges + sorts
- `src/index.ts:52-59` — Client instantiation per provider
- `src/index.ts:173-175` — `providerToFormat()` returns 'tools' for Mistral
- `src/review.ts:10-26` — Config interface with Mistral fields
- `src/bench-reorder.ts:372-384` — Ranking output (stdout only)
- `.github/workflows/benchmark.yml:78-124` — Mistral benchmark job

## Desired End State

- `Provider = 'nim' | 'groq' | 'mistral' | 'custom'`
- Groq models mixed into the SWE-bench sorted chain alongside NIM and Mistral
- Custom always prepended first (unchanged)
- `groq_api_key` and `groq_models` inputs in action.yml
- Daily benchmark includes a Groq job
- Daily bench writes a ranked model table to GITHUB_STEP_SUMMARY

## What We're NOT Doing

- Removing Mistral (it stays as 4th fallback)
- Changing the `tools` format workaround for Mistral
- Changing Custom provider behavior
- Adding Groq-specific model discovery (bench-entry discovers only NIM models)

## Implementation Approach

Extend the existing Mistral pattern: add Groq fields to Config, add a client, add to chain, add SWE-bench scores, add benchmark job. For bench visibility, append a markdown table to GITHUB_STEP_SUMMARY in `bench-reorder.ts`.

## Phase 1: Add Groq Provider to Chain

### Overview

Wire Groq into the type system, config, client instantiation, and combined chain.

### Changes Required:

#### 1. Provider type and chain builder

**File**: `src/model-chain.ts`

**Intent**: Add `'groq'` to the Provider union. Extend `ChainOptions` with `groqModels: string[]` and `hasGroqKey: boolean`. Push Groq models into the chain in `buildCombinedChain()` so they get sorted alongside NIM and Mistral.

**Contract**: `Provider = 'nim' | 'groq' | 'mistral' | 'custom'`. ChainOptions gains two fields. The chain push block for Groq follows the same pattern as Mistral's.

#### 2. Config interface and loader

**File**: `src/review.ts`

**Intent**: Add `groqApiKey: string` and `groqModels: string[]` to the Config interface. Load from `groq_api_key` and `groq_models` inputs in `loadConfig()`. No base URL field — hardcoded in index.ts.

**Contract**: Two new fields in Config. Default models: `'openai/gpt-oss-120b,moonshotai/kimi-k2-instruct,llama-3.3-70b-versatile'`.

#### 3. Client instantiation and chain wiring

**File**: `src/index.ts`

**Intent**: Create a `groqClient` when `config.groqApiKey` is set, using hardcoded base URL `https://api.groq.com/openai/v1`. Add to the `clients` record. Pass `groqModels`/`hasGroqKey` to `buildCombinedChain()`. Update the "at least one key required" error to include `groq_api_key`.

**Contract**: `const groqClient = config.groqApiKey ? new OpenAIClient('https://api.groq.com/openai/v1', config.groqApiKey) : null;`. Clients record gains `groq: groqClient`. Groq uses `json_schema` format (same as NIM) — no change to `providerToFormat()` needed since it already returns `'json_schema'` for non-mistral providers.

#### 4. Action inputs

**File**: `action.yml`

**Intent**: Add `groq_api_key` and `groq_models` inputs after the Mistral inputs.

**Contract**:
```yaml
groq_api_key:
  description: 'Groq API key (enables Groq models in fallback chain)'
  default: ''
groq_models:
  description: 'Comma-separated Groq model fallback chain'
  default: 'openai/gpt-oss-120b,moonshotai/kimi-k2-instruct,llama-3.3-70b-versatile'
```

#### 5. SWE-bench scores for Groq models

**File**: `src/bench-reorder.ts`

**Intent**: Add Groq model IDs to `SWE_BENCH_SCORES`. These are the same underlying models available via NIM but with Groq-specific IDs.

**Contract**: Add entries:
```typescript
// Groq model IDs
'openai/gpt-oss-120b': 0.720,  // already present
'openai/gpt-oss-20b': 0.650,   // already present
'moonshotai/kimi-k2-instruct': 0.802,
'llama-3.3-70b-versatile': 0.620,
```

Note: `openai/gpt-oss-120b` and `openai/gpt-oss-20b` are already in the table. Only `moonshotai/kimi-k2-instruct` and `llama-3.3-70b-versatile` need adding.

### Success Criteria:

#### Automated Verification:

- TypeScript compiles: `npm run build`
- Tests pass: `npm test`
- Linting passes: `npm run lint` (if configured)

#### Manual Verification:

- With GROQ_API_KEY set, the chain includes Groq models sorted by SWE-bench score
- Without GROQ_API_KEY, chain works as before (NIM + Mistral + Custom)

---

## Phase 2: Benchmark Job + Ranking Visibility

### Overview

Add a daily benchmark job for Groq and write the ranked model list to GITHUB_STEP_SUMMARY in bench-reorder.ts.

### Changes Required:

#### 1. Groq benchmark job

**File**: `.github/workflows/benchmark.yml`

**Intent**: Add a `benchmark-groq` job following the same pattern as `benchmark-mistral`. Uses `GROQ_API_KEY` secret, base URL `https://api.groq.com/openai/v1`, and the default Groq models.

**Contract**: New job `benchmark-groq` with `NIM_API_KEY: ${{ secrets.GROQ_API_KEY }}`, `NIM_BASE_URL: 'https://api.groq.com/openai/v1'`, `NIM_MODELS: 'openai/gpt-oss-120b,moonshotai/kimi-k2-instruct,llama-3.3-70b-versatile'`, `ACTION_TARGET: groq_models`. Requires adding `groq_models` to `bench-reorder.ts` TARGET_CONFIG.

#### 2. Add groq_models target to bench-reorder

**File**: `src/bench-reorder.ts`

**Intent**: Add `'groq_models'` to the `ActionTarget` type and `TARGET_CONFIG` record so bench-reorder can update that section of action.yml.

**Contract**: `type ActionTarget = 'nim_models' | 'mistral_models' | 'groq_models'`. New entry in TARGET_CONFIG with pattern matching `groq_models:\n\s+description:[^\n]*\n\s+default:\s*'([^']*)'`.

#### 3. Write ranking to GITHUB_STEP_SUMMARY

**File**: `src/bench-reorder.ts`

**Intent**: After printing the ranked list to stdout, also write a markdown table to GITHUB_STEP_SUMMARY so it appears in the job summary.

**Contract**: After the `console.log` loop (line ~384), append a markdown table to `process.env.GITHUB_STEP_SUMMARY` using `appendFileSync`. Format: `## Model Ranking ({target})` header + table with columns: #, Model, SWE, Effective, Latency.

### Success Criteria:

#### Automated Verification:

- TypeScript compiles: `npm run build`
- Tests pass: `npm test`
- bench-reorder tests still pass with new target type

#### Manual Verification:

- Workflow dispatch triggers Groq benchmark job
- GITHUB_STEP_SUMMARY shows the ranked table after bench-reorder runs

---

## Testing Strategy

### Unit Tests:

- `bench-reorder.test.ts`: Add test for `updateActionYml` with `groq_models` target
- `model-chain.test.ts`: Verify Groq models are included in chain when `hasGroqKey: true`

### Integration Tests:

- Existing `index.test.ts` should still pass (Groq is optional, no key = no effect)

### Manual Testing Steps:

1. Run `npm run build` — no type errors
2. Run `npm test` — all pass
3. Verify action.yml has both new inputs
4. Verify `buildCombinedChain` with all 4 providers produces correct sorted order

## References

- Research: `context/changes/mistral-hallucination-bench-visibility/research.md`
- Groq API docs: `https://api.groq.com/openai/v1` (OpenAI-compatible)
- Existing Mistral pattern: `src/index.ts:52`, `src/model-chain.ts:28-50`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands.

### Phase 1: Add Groq Provider to Chain

#### Automated

- [x] 1.1 TypeScript compiles: `npm run build` — 971544c
- [x] 1.2 Tests pass: `npm test` — 971544c
- [x] 1.3 Linting passes — 971544c

#### Manual

- [ ] 1.4 Chain includes Groq models when GROQ_API_KEY is set
- [ ] 1.5 Chain works without GROQ_API_KEY (no regression)

### Phase 2: Benchmark Job + Ranking Visibility

#### Automated

- [x] 2.1 TypeScript compiles: `npm run build` — ed393dd
- [x] 2.2 Tests pass: `npm test` — ed393dd

#### Manual

- [ ] 2.3 Workflow dispatch triggers Groq benchmark job
- [ ] 2.4 GITHUB_STEP_SUMMARY shows ranked table
