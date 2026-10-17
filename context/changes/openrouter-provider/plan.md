# OpenRouter & Kilo Provider Implementation Plan

## Overview

Add OpenRouter and Kilo Gateway as first-class provider slots in the NIM Code Review GitHub Action, alongside the existing NIM, Mistral, and Groq slots. Both gateways will support free model tiers with estimated SWE-bench scores, forced to rank last in the combined fallback chain. Also add a `custom_models` CSV input to allow multiple custom-slot models (benefiting all gateways, not just OR/Kilo).

## Current State Analysis

The action currently supports four provider slots: NIM (default), Mistral, Groq, and Custom. Each first-class provider has:
- 3 action.yml inputs (api_key, base_url, models)
- 3 Config interface fields + loadConfig() entries
- A `Provider` union type member
- ChainOptions fields + buildCombinedChain() inclusion
- An OpenAIClient instance in buildClients()
- URL validation + key-gate checks
- SWE_BENCH_SCORES entries
- An ActionTarget enum member + TARGET_CONFIG entry
- Test fixtures across model-chain, review, and bench-reorder tests
- README documentation
- A benchmark workflow job (for Mistral/Groq)

OpenRouter is already referenced as a test fixture in `src/review.test.ts:129` (custom_api_url = 'https://openrouter.ai/api/v1'), confirming the endpoint is OpenAI-compatible. Adding it as a first-class slot follows the exact same pattern as the Groq addition (~10 files, ~150 LOC per provider).

Kilo was previously evaluated (`context/changes/kilocode-provider/`) and cancelled due to a privacy concern — Kilo's free tier routes to providers that log prompts for training. The user has decided to reverse this cancellation and add Kilo as first-class. This plan includes a prominent risk flag.

## Desired End State

A user can configure either OpenRouter or Kilo (or both) alongside NIM/Mistral/Groq by providing only the API key — models default to a curated free-model list. All provider models merge into a single fallback chain sorted by SWE-bench score × latency multiplier. Free models rank last (estimated scores + forced ordering). The `custom_models` CSV enables multiple custom-slot models for any gateway that supports it.

### Key Discoveries:

- OpenRouter and Kilo are both OpenAI-compatible — zero transport changes needed (`src/openai-client.ts:76-178`)
- The Groq addition is the exact template for adding providers (10 files, ~150 LOC)
- Kilo's `:free` model IDs exist (kilo-auto/balanced:free, kilo-auto/frontier:free) per the cancelled research
- Kilo privacy concern: free tier routes to providers that log prompts for training (`context/changes/kilocode-provider/change.md:8`)
- OpenRouter free models have no verified SWE-bench scores — need estimated entries
- Provider label auto-detection in OpenAIClient covers 'openrouter.ai' and 'kilo.ai' via domain matching (`src/openai-client.ts:84-88`)

## What We're NOT Doing

- **Auto-discovery of free models from provider catalogs.** The action intentionally does not auto-discover models (`context/foundation/prd.md:72-81, 133-140`). New model IDs must be curated and benchmarked.
- **Paid-model tiers in the default chain.** Default models are the free tier only; users can override with paid model IDs if they wish.
- **Custom headers/special routing logic.** Neither OpenRouter nor Kilo requires custom headers for the free tier. If future tiers need headers, that's a separate `custom_headers` enhancement.
- **Daily benchmark jobs for OpenRouter/Kilo free models** until stable model identities are confirmed. Free models are volatile — their scores and availability change frequently.
- **Kilo paid tiers.** This plan only covers the free tiers; paid tiers can be added later once the free tier proves reliable.
- **Multi-provider free-model chain merging.** Free models from both OpenRouter and Kilo are merged into the same quality-first ranking but are forced to rank last.

## Implementation Approach

Two parallel first-class provider additions following the Groq pattern, plus a `custom_models` CSV enhancement that benefits all gateways. The key architectural decision: free models get **estimated SWE-bench scores** and are **forced to the end of the chain**, preserving the quality-first philosophy while still offering zero-cost options as a safety net.

## Critical Implementation Details

- **Kilo privacy flag.** Kilo's free tier (`kilo-auto/free`) routes to providers that log prompts for training. For a code-review action ingesting PR diffs — which may contain sensitive logic, credentials, or architectural details — this is a data-handling concern. The README MUST include a warning section about this. The existing cancelled research (`context/changes/kilocode-provider/change.md:8`) documents the exact concern.
- **Free-model score volatility.** OpenRouter free models are experimental or quantized variants; their IDs and availability change frequently. The estimated SWE-bench scores are best-effort guesses and should be labeled as such in the codebase. The bench-reorder tool should note that free-model scores are estimated rather than measured.

## Phase 1: Config + Chain Infrastructure

### Overview

Add action.yml inputs, Config interface fields, Provider type member, and chain logic for both OpenRouter and Kilo. Also add the `custom_models` CSV input and the "free models last" chain ordering rule.

### Changes Required:

#### 1. Action.yml Inputs

**File**: `action.yml`

**Intent**: Add three new inputs per provider (`*_api_key`, `*_base_url`, `*_models`) plus `custom_models` and `custom_models_base_url` for multi-model custom slot.

**Contract**: Add inputs following the Groq pattern (lines 26-34). OpenRouter inputs go before custom_* block. Kilo inputs go after OpenRouter. `custom_models` is a CSV string (like existing `*_models` defaults). `custom_models_base_url` defaults to `custom_api_url` when not separately specified.

#### 2. Config Interface + loadConfig

**File**: `src/config.ts`

**Intent**: Add openRouter* and kilo* fields to the Config interface; parse them in loadConfig().

**Contract**: Extend Config by 6 fields (apiKey, baseUrl, models for each provider). In loadConfig(), add `core.getInput()` calls for each new field. `customModels` field uses splitCSV(). Default base URLs: `https://openrouter.ai/api/v1` and `https://api.kilo.ai/api/gateway`. Validate `customModels` only when `customApiUrl` is set (not required separately).

#### 3. Provider Type + ChainOptions + buildCombinedChain

**File**: `src/model-chain.ts`

**Intent**: Add 'openrouter' and 'kilocode' to Provider union; extend ChainOptions; add OpenRouter/Kilo models to the combined chain with free models forced to rank last.

**Contract**: 
- `Provider` type becomes `'nim' | 'mistral' | 'groq' | 'openrouter' | 'kilocode' | 'custom'`
- `ChainOptions` gets `openrouterModels`, `hasOpenRouterKey`, `kiloModels`, `hasKiloKey`
- `buildCombinedChain()` includes OR/Kilo provider models alongside existing providers — they enter the quality-first SWE-bench sorting like NIM/Mistral/Groq
- **Free-model ordering rule**: after sorting by SWE-bench score, models whose IDs end with `:free` are moved to the end of the chain (after all non-free models, but before custom). Custom slot remains always-first.

#### 4. custom_models CSV Integration

**File**: `src/model-chain.ts`

**Intent**: Allow custom_models (CSV) instead of just a single custom_model. When custom_models is provided, each entry creates a separate TaggedModel in the chain — all always-first, before all provider models.

**Contract**: ChainOptions adds `customModels?: string[]`, `hasCustomModels?: boolean`. When `hasCustomModels` is true, each custom model ID is pushed as `{ id, provider: 'custom' }` and prepended to the chain (before provider models), preserving the existing custom-always-first behavior.

### Success Criteria:

#### Automated Verification:

- `npm run build` — TypeScript compiles without errors
- `npm test` — All existing tests pass; new provider test fixtures compile
- `npm run typecheck` — No type errors

#### Manual Verification:

- Action accepts openrouter_api_key + kilo_api_key inputs
- Default model chains include free-tier models for both providers
- Custom_models CSV allows multiple custom-slot models
- Free models rank below non-free models in the combined chain

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding to Phase 2.

---

## Phase 2: Client + Index Integration

### Overview

Wire the new providers into the OpenAIClient (providerLabel detection), the index (buildClients, validation, chain execution), and the model-chain probing logic.

### Changes Required:

#### 1. Provider Label Detection

**File**: `src/openai-client.ts`

**Intent**: Ensure OpenAIClient auto-detects 'OpenRouter' and 'Kilo' provider labels from base URL domains.

**Contract**: The existing auto-detection logic (`src/openai-client.ts:84-88`) maps `baseURL.includes('nvidia.com') → 'NIM'`, `baseURL.includes('mistral') → 'Mistral'`, `baseURL.includes('groq') → 'Groq'`. Add `baseURL.includes('openrouter') → 'OpenRouter'` and `baseURL.includes('kilo.ai') → 'Kilo'`. No new constructor signatures needed.

#### 2. buildClients + Validation

**File**: `src/index.ts`

**Intent**: Create OpenAIClient instances for OR/Kilo in buildClients(); add URL validation and key-gate checks in validateConfig().

**Contract**:
- `buildClients()` returns `{ ..., openrouter: config.openRouterApiKey ? new OpenAIClient(...) : null, kilocode: config.kiloApiKey ? new OpenAIClient(...) : null, ... }`
- `validateConfig()` validates `openRouterBaseUrl` and `kiloBaseUrl` via `validateProviderUrl()`; adds OR/Kilo keys to `core.setSecret()`
- Key-gate: at least one of nim/mistral/groq/openrouter/kilocode/custom must be configured
- `providerToFormat()` at `src/index.ts:55` works as-is — both OR and Kilo use 'json_schema' format

#### 3. Chain Building + PrioritizeChain

**File**: `src/index.ts`

**Intent**: Pass OR/Kilo models and key flags to buildCombinedChain(); probeModels covers the new clients automatically since it iterates over `Record<Provider, OpenAIClient | null>`.

**Contract**: The `buildCombinedChain()` call in `src/index.ts:359` already passes providers as a Record — the new Provider type members are automatically covered. No changes needed to prioritizeChain beyond what Phase 1 already does.

### Success Criteria:

#### Automated Verification:

- `npm run build` — compiles
- `npm test` — passes
- TypeScript type checks for Record<Provider> coverage

#### Manual Verification:

- OpenAIClient labels show "OpenRouter" and "Kilo" in error messages
- URL validation catches invalid OR/Kilo URLs
- Chain built correctly with OR/Kilo models in correct position

---

## Phase 3: Bench-Rank + SWE-Bench Scores + custom_models CSV

### Overview

Add estimated SWE-bench scores for free models, extend the bench-reorder system to target OR/Kilo model lists, and wire the custom_models CSV into the chain configuration.

### Changes Required:

#### 1. SWE_BENCH_SCORES Entries for Free Models

**File**: `src/bench-reorder.ts`

**Intent**: Add estimated SWE-bench scores for OpenRouter and Kilo free models. Label them as estimated in the table header comment.

**Contract**: Add entries to the `SWE_BENCH_SCORES` table (after line 179):
```
'deepseek/deepseek-r1:free': 0.65,       // estimated — free tier, quantized
'meta-llama/llama-4-maverick:free': 0.50, // estimated — free tier, truncated
'google/gemini-2.0-flash-exp:free': 0.60, // estimated — experimental free tier
'kilo-auto/balanced:free': 0.55,          // estimated — free auto tier
'kilo-auto/frontier:free': 0.60,          // estimated — free tier, frontier routing
```

Update the table header comment (line 123-130) to note: "Free-tier entries are estimated scores; they should be replaced with measured values once benchmark data is available. Free models should be forced to rank last in the fallback chain."

#### 2. ActionTarget + TARGET_CONFIG for OR/Kilo

**File**: `src/bench-reorder.ts`

**Intent**: Add 'openrouter_models' and 'kilocode_models' to the ActionTarget enum and TARGET_CONFIG, enabling the bench-reorder tool to update action.yml for both providers.

**Contract**: Extend `ActionTarget` enum: `'nim_models' | 'mistral_models' | 'groq_models' | 'openrouter_models' | 'kilocode_models'`. Add corresponding entries in `TARGET_CONFIG` with regex patterns matching the new input keys in action.yml.

#### 3. updateActionYml for OR/Kilo

**File**: `src/bench-reorder.ts`

**Intent**: Add helper functions mirroring `updateActionYmlMistral()` for OpenRouter and Kilo.

**Contract**: Add `updateActionYmlOpenRouter(actionPath, orderedModels)` and `updateActionYmlKilocode(actionPath, orderedModels)`, both delegating to `updateActionYml()` with the appropriate target.

#### 4. custom_models CSV Wiring

**File**: `src/config.ts` + `src/model-chain.ts` + `src/index.ts`

**Intent**: Add `custom_models` and `custom_models_base_url` inputs; wire them into ChainOptions and the chain-building logic.

**Contract**:
- `Config` interface: add `customModels: string[]`, `customModelsBaseUrl: string`
- `loadConfig()`: `customModels = splitCSV(core.getInput('custom_models') || '')`, `customModelsBaseUrl = core.getInput('custom_models_base_url') || customApiUrl`
- `ChainOptions`: `customModels?: string[]`, `hasCustomKey?: boolean`
- `buildCombinedChain()`: when `hasCustomKey` and `customModels` has entries, prepend each as `{ id, provider: 'custom' }` before provider models

#### 5. Free-Model Ordering Rule

**File**: `src/model-chain.ts`

**Intent**: After SWE-bench sorting, move models with `:free` suffix to the end of the chain, after all non-free models but before custom-slot models.

**Contract**: In `buildCombinedChain()`, after the `providerModels.sort()` call (line 55-59), split the sorted array into `nonFree` (no `:free` suffix) and `free` (ends with `:free`). Concatenate `[...nonFree, ...free]`. Custom models are always prepended before both groups (existing behavior).

### Success Criteria:

#### Automated Verification:

- `npm run build` — compiles
- `npm test` — passes
- SWE-bench scores lookup returns estimated values for free model IDs
- `updateActionYml` correctly updates openrouter_models and kilocode_models in action.yml

#### Manual Verification:

- Free model IDs are listed in SWE_BENCH_SCORES with estimated values
- Free models rank last in a combined chain (verified via chain output)
- custom_models CSV allows 2+ custom-slot models

---

## Phase 4: Tests + Docs + Workflows

### Overview

Add test fixtures for the new providers, update README, and add benchmark workflow jobs for OpenRouter and Kilo.

### Changes Required:

#### 1. Test Fixtures

**File**: `src/model-chain.test.ts`

**Intent**: Add test cases for OpenRouter and Kilo provider chains, including free-model ordering and custom_models CSV logic.

**Contract**: New describe blocks: "OpenRouter provider" (chain ordering, free-last behavior), "Kilo provider" (same), "custom_models CSV" (multiple custom models prepended, always-first). Existing test cases that define `Record<Provider, ...>` must include `openrouter: null` and `kilocode: null`.

**File**: `src/openai-client.test.ts`

**Intent**: Add provider label detection tests for 'openrouter.ai' and 'kilo.ai' domains.

**Contract**: Test that `new OpenAIClient('https://openrouter.ai/api/v1', 'key').providerLabel` returns 'OpenRouter', similarly for 'Kilo'.

**File**: `src/bench-reorder.test.ts`

**Intent**: Add test cases for updateActionYmlOpenRouter and updateActionYmlKilocode.

**Contract**: Mirror existing updateActionYmlMistral test structure.

**File**: `src/config.test.ts`

**Intent**: Verify that new Config fields parse correctly and defaults work.

**Contract**: Add Config fixture literals with openRouter/Kilo fields; test custom_models CSV splitting; test that missing openrouter_api_key yields empty openrouterModels array.

**File**: `src/review.test.ts`

**Intent**: Every `Config` literal and `Record<Provider, OpenAIClient | null>` fixture must include the new Provider type members.

**Contract**: Add `openrouter: null` and `kilocode: null` to all `clients` Record<Provider> literals.

#### 2. README Documentation

**File**: `README.md`

**Intent**: Add OpenRouter Support section, Kilo Gateway section (with privacy warning), and Custom Models CSV section. Update Inputs table.

**Contract**: 
- Add rows to Inputs table: `openrouter_api_key`, `openrouter_base_url`, `openrouter_models`, `kilo_api_key`, `kilo_base_url`, `kilo_models`, `custom_models`, `custom_models_base_url`
- New section "OpenRouter Support" — showing the 3-line YAML preset, free-model default chain, combined mode with NIM/Mistral/Groq
- New section "Kilo Gateway Support" — showing the 3-line YAML preset, **with explicit privacy warning about prompt logging for training on the free tier**
- New section "Multiple Custom Models" — explaining the `custom_models` CSV input
- Update "How It Works" section to mention 6-provider combined chain (NIM + Mistral + Groq + OpenRouter + Kilo + Custom)
- Update default chain description to note free models rank last

#### 3. Benchmark Workflow Jobs

**File**: `.github/workflows/benchmark.yml`

**Intent**: Add benchmark jobs for OpenRouter and Kilo, mirroring the existing Mistral/Groq jobs.

**Contract**: Add `benchmark-openrouter` and `benchmark-kilocode` jobs. Each uses the respective API key secret, sets NIM_MODELS env to the provider's model list, and runs `bench-entry.js`. Updates action.yml via `updateActionYmlOpenRouter`/`updateActionYmlKilocode`.

### Success Criteria:

#### Automated Verification:

- All existing tests pass with new fixtures
- New provider test cases pass
- README renders correctly (no dead links, tables align)
- Workflow YAML is syntactically valid

#### Manual Verification:

- OpenRouter section in README is accurate and actionable
- Kilo section includes the privacy warning
- custom_models CSV section correctly explains the new feature
- All 6-input combinations work (e.g., OR + Kilo + NIM + Mistral + Groq + Custom)

---

## Phase 5: End-to-End Verification

### Overview

Run the full verification suite: build, test, lint, chain ordering sanity check, and README review.

### Changes Required:

#### 1. Full Build + Test

Run `npm run build && npm test` — verify zero regressions.

#### 2. Chain Ordering Sanity Check

Write a quick integration test or script that builds a chain with all 6 providers (NIM, Mistral, Groq, OpenRouter, Kilo, Custom) with mixed free/non-free models, and verifies:
- Custom is always first
- Free models are always last within the provider group
- Provider models are sorted by SWE-bench score (non-free before free)
- custom_models CSV entries are prepended before single custom_model

#### 3. README Review

Manually verify all 6 provider sections in README are consistent and complete.

### Success Criteria:

#### Automated Verification:

- `npm run build` — zero errors
- `npm test` — all tests pass (including new provider + free-model tests)
- Chain ordering test passes
- README renders without formatting issues

#### Manual Verification:

- Combined chain ordering confirmed correct
- OpenRouter and Kilo both work as first-class inputs in a real workflow
- Free models rank last in combined chain output
- README examples are copy-paste ready
- Kilo privacy warning is visible and clear

---

## Testing Strategy

### Unit Tests:

- Config parsing for new OR/Kilo/custom_models fields
- BuildCombinedChain ordering (free-last rule)
- Free-model suffix detection (:free)
- custom_models CSV splitting and chain prepending
- Provider label auto-detection for OR/Kilo domains
- updateActionYml for OR/Kilo targets
- SWE-bench score lookup for free model IDs returns estimated values

### Integration Tests:

- Full chain build with all 6 providers + custom + free models
- Provider exclusion (no key = model not in chain)
- Chain ordering with mixed free/non-free models across providers
- custom_models CSV + custom_model coexistence

### Manual Testing Steps:

1. Configure action with openrouter_api_key only — verify free-model chain works
2. Configure action with kilo_api_key only — verify free-model chain works (with privacy caveat)
3. Configure action with all 6 providers — verify combined chain ordering
4. Verify free models probe last in the prioritizeChain step
5. Verify README examples are copy-paste ready for each provider

## Performance Considerations

- Two provider additions add ~2 OpenAIClient instances. Probing all models still respects the PROBE_TIMEOUT_MS (10s per model) — with ~20 total models across 6 providers, max probing time is ~200s but the Promise.all() runs concurrently, so actual wall time is ~10s.
- The free-model ordering rule adds one sort + one filter per chain build — negligible cost.
- SWE_BENCH_SCORES table grows by ~5 entries for free models — lookup remains O(1).

## Migration Notes

This is an additive change. No existing behavior changes:
- NIM, Mistral, Groq, and Custom slots work exactly as before
- The :free suffix ordering rule only affects models with that suffix — no existing model IDs use it
- custom_models CSV only activates when the input is non-empty — existing single custom_model behavior is unchanged
- Kilo addition reverses a cancellation — teams using the prior research should re-evaluate the privacy concern before deploying

## References

- Kilocode provider research: `context/changes/kilocode-provider/research.md`
- Kilo provider cancellation: `context/changes/kilocode-provider/change.md`
- Custom API support: `context/changes/custom-api-support/research.md`
- Mistral first-class precedent: `context/changes/mistral-support/research.md`
- Groq first-class pattern: `src/model-chain.ts`, `src/config.ts`, `action.yml`
- Quality-first PRD: `context/foundation/prd.md:118-127`
- Auto-discovery non-goal: `context/foundation/prd.md:72-81`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands.

### Phase 1: Config + Chain Infrastructure

#### Automated

- [x] 1.1 action.yml inputs for OpenRouter + Kilo + custom_models — 2c531d2
- [x] 1.2 Config interface + loadConfig() for OR/Kilo/custom_models fields — 2c531d2
- [x] 1.3 Provider type + ChainOptions + buildCombinedChain (free-last rule) — 2c531d2
- [x] 1.4 custom_models CSV wiring in ChainOptions + chain logic — 2c531d2

#### Manual

- [ ] 1.5 Chain ordering confirmed correct (custom first, provider models by score, free last)

### Phase 2: Client + Index Integration

#### Automated

- [x] 2.1 OpenAIClient providerLabel for OR/Kilo domains — 111fc89
- [x] 2.2 buildClients() + validateConfig() for OR/Kilo — 111fc89
- [x] 2.3 Chain building + prioritizeChain covers new providers — 111fc89

#### Manual

- [ ] 2.4 Provider labels correct in error messages
- [ ] 2.5 URL validation catches invalid OR/Kilo URLs

### Phase 3: Bench-Rank + SWE-Bench Scores + custom_models CSV

#### Automated

- [x] 3.1 SWE_BENCH_SCORES entries for free models (estimated) — 1ba05b2
- [x] 3.2 ActionTarget + TARGET_CONFIG for openrouter_models + kilocode_models — 1ba05b2
- [x] 3.3 updateActionYml helpers for OR/Kilo — 1ba05b2
- [x] 3.4 Free-model ordering rule in buildCombinedChain — 1ba05b2
- [x] 3.5 custom_models CSV fully wired — 1ba05b2

#### Manual

- [ ] 3.6 Free models rank last in combined chain
- [ ] 3.7 SWE-bench scores lookup returns estimated values

### Phase 4: Tests + Docs + Workflows

#### Automated

- [x] 4.1 model-chain tests (OR/Kilo chain ordering, free-last, custom_models) — ca85ac8
- [x] 4.2 openai-client tests (provider label detection) — ca85ac8
- [x] 4.3 bench-reorder tests (updateActionYml OR/Kilo) — ca85ac8
- [x] 4.4 config tests (OR/Kilo/custom_models field parsing) — ca85ac8
- [x] 4.5 review tests (Record<Provider> fixtures include OR/Kilo) — ca85ac8
- [x] 4.6 README docs (Inputs table + OR section + Kilo section + custom_models section) — ca85ac8
- [x] 4.7 Workflow jobs (benchmark-openrouter + benchmark-kilocode) — ca85ac8

#### Manual

- [ ] 4.8 README examples copy-paste ready
- [ ] 4.9 Kilo privacy warning visible in README
- [ ] 4.10 All 6-provider combinations tested

### Phase 5: End-to-End Verification

#### Automated

- [x] 5.1 Full build + test suite passes — 6504300
- [x] 5.2 Chain ordering sanity test passes — 6504300
- [x] 5.3 README renders without formatting issues — 6504300

#### Manual

- [ ] 5.4 Combined chain ordering confirmed correct with all 6 providers
- [ ] 5.5 OpenRouter and Kilo both work as first-class inputs
- [ ] 5.6 Free models rank last in combined chain output