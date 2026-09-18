# Model Chain Resilience Implementation Plan

## Overview

Document and finish the model-chain reliability work implemented on 2026-08-01. The shipped changes add provider-specific structured-output fallbacks, text-mode JSON recovery for reasoning models, custom-model chain correctness, adaptive output budgets, and optional staggered parallel model attempts. This retrospective plan records those commits as completed evidence and adds a final hardening phase for missing tests, public documentation, and live verification.

## Current State Analysis

The action already combines configured providers into a SWE-bench-ordered fallback chain, probes availability, validates model output with Zod, and falls through when a model fails. Today's implementation extended that path substantially, but most of the work has no dedicated context artifact.

Already documented work remains owned by its existing records:

- Daily model-order updates are covered by `context/changes/daily-benchmark/` and `context/changes/model-recheck/`.
- Per-model and aggregate timeouts are covered by `context/changes/per-model-timeout/`.
- Probe promotion capping and unreferenced-finding validation are covered by `context/changes/probe-cap-and-stale-refs/change.md`.

The undocumented delta spans commits `5bfdd1b`, `11f9f29`, `1bf11c7`, `56125ed`, `010979a`, `3eb862d`, `3154960`, and `7ea1d35`. The first six are present on `origin/main`; `3154960` and `7ea1d35` are committed locally after `origin/main` at the time this plan was written.

## Desired End State

The action should reliably obtain review JSON from OpenAI-compatible providers even when they reject `json_schema`, reject all structured-output modes, emit reasoning wrappers, or return extractable JSON alongside a truncation finish reason. Custom model lists should create a usable client, remain deduplicated, and participate in probe ordering with an explicit score override. Review output budgets should scale with diff size, and users should be able to opt into staggered parallel attempts without changing the default sequential behavior.

The shipped implementation must be fully represented in context, its public inputs must be accurately documented, important scheduling and parser boundaries must have direct tests, and live Action runs must verify the custom-model-only and text-mode paths.

### Key Discoveries:

- `src/openai-client.ts:19-28` recognizes multiple provider error dialects for unsupported structured output.
- `src/openai-client.ts:38-72` selects `json_object` or text mode for known model limitations.
- `src/openai-client.ts:88-147` strips reasoning wrappers and extracts fenced or balanced JSON.
- `src/index.ts:59-81` computes an adaptive output budget capped at 16,384 tokens.
- `src/index.ts:98-210` centralizes one model attempt, including timeout composition, schema retry, truncation handling, and finding validation.
- `src/index.ts:212-353` supports sequential fallback by default and optional staggered parallel attempts.
- `src/model-chain.ts:111-135` applies custom SWE scores and deduplicates singular/plural custom model inputs.
- `src/index.ts:394-404` creates a custom client when either `custom_model` or `custom_models` is configured.
- `README.md:64,74` still states a 60-second model timeout although configuration now defaults to 90 seconds, and the new resilience inputs are absent from the input table.

## What We're NOT Doing

- Re-documenting daily benchmark output, generated bundle-only commits, or existing timeout behavior.
- Replacing the existing probe-cap change record.
- Changing provider SDKs or introducing provider-specific client classes.
- Making parallel execution the *only* mode. The shipped default is `parallel_attempts: 3` (light staggered parallel); fully sequential behavior is preserved by setting `parallel_attempts: 1`.
- Adding streaming support to the review execution path.
- Redesigning retry policy, batching, finding validation, or review rendering.
- Expanding the known model override tables beyond models confirmed by provider behavior.

## Implementation Approach

Treat structured-output capability as a runtime compatibility concern inside `OpenAIClient`, while keeping review-schema validation and fallback decisions in the model-chain runner. Normalize known provider limitations before the request, recover JSON from plain text when structured output is unavailable, and preserve sequential fallback semantics around every failed or unusable response.

For latency, compute one output budget per batch and route every attempt through a shared helper. Parallel mode launches only the configured chain prefix, staggers later starts, accepts the first result with validated findings, aborts delayed or in-flight siblings, and then resumes the untouched chain tail sequentially when no parallel winner exists.

Custom models continue to share one custom client and one chain prefix. Singular and plural inputs are unified for client creation, deduplicated by model ID, and assigned the configured SWE score override for probe-promotion decisions.

## Critical Implementation Details

### Timing & lifecycle

Parallel attempts share an `AbortController` (present for future signal wiring) but in the shipped implementation each HTTP attempt retains its independent per-model timeout through `AbortSignal.any()` and all launched attempts run to completion; the result with the highest adjusted-SWE score wins. Schema-invalid raw content is preserved for fallback behavior but a partial failure does not cancel potentially successful siblings.

### State sequencing

The parallel prefix must settle before the runner decides whether to return a winner, retain raw fallback content, or continue with the untouched sequential tail. A later valid result clears stale raw fallback content so `promptMode: replace` cannot render an earlier invalid response.

### Performance constraints

Sequential-by-default is preserved as opt-in: the shipped default is `parallel_attempts: 3` (light staggered parallel), and setting `parallel_attempts: 1` restores fully sequential fallback. Adaptive output limits remain between 4,096 and 16,384 tokens, while known StepFun text-mode models receive at least 8,192 tokens because natural-language responses are more verbose than strict structured output.

## Phase 1: Provider Output Compatibility

### Overview

Make structured review output portable across providers and reasoning models whose OpenAI-compatible APIs support different response formats or no structured-output mode at all.

### Changes Required:

#### 1. Detect and bypass unsupported JSON-schema modes

**File**: `src/openai-client.ts`

**Intent**: Avoid permanently skipping models that reject `json_schema`, and avoid a known failed request for model IDs with established limitations.

**Contract**: Unsupported-output detection accepts `json_schema`, `structured_outputs`, and generic `structured output` wording on HTTP 400 responses. Known `NO_JSON_SCHEMA_MODELS` use `json_object`; unknown models retry from `json_schema` to `json_object` after a matching rejection.

#### 2. Recover JSON from plain-text reasoning responses

**File**: `src/openai-client.ts`

**Intent**: Keep models that reject both structured modes usable by extracting the requested review object from their natural response.

**Contract**: Known `NO_STRUCTURED_OUTPUT_MODELS` use text mode. `extractJsonFromText()` first removes supported thinking wrappers, then extracts JSON from a `json` fence, an unlabelled fence, or the first balanced top-level object while respecting quoted strings and escapes.

#### 3. Preserve extractable truncated responses

**File**: `src/index.ts`

**Intent**: Do not discard complete review JSON merely because a reasoning stream caused the provider to return `finish_reason: length`.

**Contract**: A truncated first response proceeds only when its returned content parses as JSON; otherwise the chain advances. Schema retries still fail closed on truncation. Step-family text-mode models receive an output floor of 8,192 tokens.

### Success Criteria:

#### Automated Verification:

- Groq-style JSON-schema rejection retries with `json_object`.
- Known models bypass unsupported structured-output modes.
- Fenced, balanced, and reasoning-wrapped JSON is extracted correctly.
- Truncated responses proceed only when JSON is extractable.
- TypeScript build and provider client tests pass.

#### Manual Verification:

- A live StepFun review returns schema-valid findings through text mode without exhausting the chain.
- A live Groq model lacking `json_schema` support completes through `json_object` fallback.

---

## Phase 2: Custom Chain Correctness

### Overview

Ensure singular and plural custom-model configuration produces one valid client, one deduplicated chain prefix, and predictable probe-promotion behavior.

### Changes Required:

#### 1. Apply custom SWE score overrides

**Files**: `action.yml`, `src/config.ts`, `src/model-chain.ts`, `src/index.ts`

**Intent**: Let custom models participate predictably in the same quality-preserving probe-promotion cap as provider models.

**Contract**: `custom_swe_score` parses as a number from 0 through 1 with default `0.5`. Every custom `TaggedModel` receives that value as `scoreOverride`, and probe comparison prefers the override over the static score table.

#### 2. Deduplicate singular and plural custom model IDs

**File**: `src/model-chain.ts`

**Intent**: Prevent the same endpoint/model combination from being attempted twice when `custom_model` also appears in `custom_models`.

**Contract**: The custom prefix is deduplicated by model ID while preserving first occurrence order; provider-chain ordering is unchanged.

#### 3. Build the custom client for plural-only configuration

**File**: `src/index.ts`

**Intent**: Make `custom_models` usable without requiring the legacy singular `custom_model` input.

**Contract**: `buildClients()` creates `clients.custom` when `custom_api_url` exists and either the singular model is non-empty or the plural model array contains entries. A missing custom URL still yields `null`.

### Success Criteria:

#### Automated Verification:

- Custom score overrides propagate into chain entries and probe comparisons.
- Duplicate singular/plural model IDs appear once in the combined chain.
- Plural-only custom configuration creates a custom client.
- Missing custom URL does not create a client.
- Model-chain and client-construction tests pass.

#### Manual Verification:

- A workflow configured only with `custom_api_url` and `custom_models` reaches the custom endpoint and posts a review.
- A model repeated in singular and plural inputs is attempted once in Action logs.

---

## Phase 3: Adaptive Budget and Staggered Parallel Fallback

### Overview

Reduce truncation on large reviews and optionally reduce fallback latency by launching a bounded, staggered prefix of the model chain while preserving sequential defaults and tail fallback.

### Changes Required:

#### 1. Add adaptive output budgets

**Files**: `action.yml`, `src/config.ts`, `src/index.ts`

**Intent**: Allocate enough completion tokens for larger diffs without forcing every review to use the maximum output budget.

**Contract**: `max_tokens: 0` enables adaptive sizing. `computeMaxTokens()` estimates input size at three characters per token, adds that estimate to a 4,096-token base, and caps output at 16,384. Explicit values from 256 through 16,384 override adaptive sizing.

#### 2. Centralize one model attempt

**File**: `src/index.ts`

**Intent**: Keep sequential and parallel paths behaviorally identical for request construction, timeout handling, schema retry, truncation checks, finding validation, and raw-content preservation.

**Contract**: `attemptModel()` returns a validated `BatchResult`, a raw-content-only result after repeated schema failure, or `null` for unusable attempts. External cancellation composes with the per-model timeout for both initial and retry calls.

#### 3. Add opt-in staggered parallel attempts

**Files**: `action.yml`, `src/config.ts`, `src/index.ts`

**Intent**: Allow slow chain heads to retain first opportunity while starting fallback models after configurable delays instead of waiting for full failure or timeout.

**Contract**: `parallel_attempts` accepts 1 through 5 and defaults to 3 (light staggered parallel; set to 1 for fully sequential). `parallel_threshold` accepts 5 through 120 seconds and defaults to 40. Parallel mode uses at most the available chain length, starts model `i` after `i * threshold`, and continues only the unlaunched chain tail sequentially when needed. (Siblings are not aborted on a winner; all launched attempts run to completion and the highest adjusted-SWE result wins — see Implementation Approach.)

### Success Criteria:

#### Automated Verification:

- Explicit and adaptive token budgets obey their bounds.
- Sequential first-success, fallthrough, all-fail, truncation, and schema-retry behavior remains intact.
- Parallel mode can select a later faster model and can continue to an unlaunched tail model.
- Parallel mode remains disabled for one available model or `parallel_attempts: 1`.
- Build and full unit test suite pass.

#### Manual Verification:

- A live workflow with two staggered attempts shows the head starting immediately and the fallback starting only after the configured threshold.
- The first successful review cancels unnecessary siblings and posts exactly one result.

---

## Phase 4: Hardening, Documentation, and Live Verification

### Overview

Close the known verification and discoverability gaps left by the rapid implementation, then validate the combined behavior in real GitHub Action runs.

### Changes Required:

#### 1. Cover new input parsing boundaries

**File**: `src/config.test.ts`

**Intent**: Lock down valid, invalid, fractional, and boundary behavior for every new public input.

**Contract**: Add direct cases for `custom_swe_score`, `max_tokens`, `parallel_attempts`, and `parallel_threshold`, including minimum, maximum, malformed, negative, and non-integer values where relevant. Invalid values must emit warnings and use documented defaults.

#### 2. Cover real staggering and cancellation branches

**File**: `src/index.test.ts`

**Intent**: Verify scheduling behavior that simultaneous tests with `parallelThreshold: 0` cannot prove.

**Contract**: Add deterministic tests for non-zero stagger timing, aborting delayed siblings after a winner, capping attempts to available models, one-model sequential behavior, raw fallback-content preservation, and both sequential-tail branches.

#### 3. Align public documentation

**File**: `README.md`

**Intent**: Make the shipped inputs and defaults discoverable and consistent with `action.yml` and `loadConfig()`.

**Contract**: Add `custom_swe_score`, `max_tokens`, `parallel_attempts`, and `parallel_threshold` to the Inputs table; change the documented `model_timeout` default and model-chain narrative from 60 to 90 seconds; explain adaptive sizing, opt-in parallel behavior, and provider text-mode fallback without promising support for unknown models.

#### 4. Run complete and live verification

**Files**: `dist/src/**`, `dist/bundle/index.js`, test workflow configuration

**Intent**: Ensure source, compiled tests, and the committed Action bundle match, then exercise provider-dependent behavior unavailable to isolated unit tests.

**Contract**: Run `npm run build` followed by `npm test`. Use a test PR for a plural-only custom endpoint, a known text-mode StepFun model, Groq JSON-object fallback, and non-zero staggered parallel attempts. Record observed model starts, cancellation/fallback behavior, and final review posting.

### Success Criteria:

#### Automated Verification:

- New config boundary tests pass.
- Non-zero stagger, cancellation, capping, and fallback-tail tests pass.
- README input defaults match `action.yml` and `src/config.ts`.
- TypeScript and bundle build succeeds: `npm run build`.
- Full test suite passes: `npm test`.

#### Manual Verification:

- Plural-only custom configuration posts a review through the custom client.
- StepFun text mode and Groq JSON-object fallback each complete a live review.
- Non-zero stagger timing and winner cancellation are visible in Action logs.
- No duplicate custom-model attempt or duplicate review output is observed.

## Testing Strategy

### Unit Tests:

- Provider error-body classification and fallback format selection.
- Thinking-wrapper removal and JSON extraction from fences, prose, nested objects, quoted braces, escapes, and malformed input.
- Truncated response acceptance only when the extracted content parses.
- Custom score parsing, propagation, probe capping, and singular/plural deduplication.
- Adaptive token bounds and explicit override behavior.
- Sequential fallback invariants.
- Staggered starts, cancellation, bounded parallel prefix, fallback raw content, and sequential tail continuation.
- Plural-only custom client construction.

### Integration Tests:

- Mock OpenAI-compatible endpoints that reject `json_schema`, reject every structured format, delay selected models, and return valid or malformed review objects.
- Full build before test execution so compiled tests and the checked-in Action bundle represent current source.

### Manual Testing Steps:

1. Configure a test PR with only `custom_api_url`, `custom_api_key`, and `custom_models`; verify a review is posted.
2. Include the same custom model in singular and plural inputs; verify one attempt in logs.
3. Run a known StepFun model and confirm text-mode extraction reaches schema validation.
4. Run a Groq model known to reject `json_schema` and confirm `json_object` succeeds.
5. Set `parallel_attempts: 2` and a non-zero `parallel_threshold`; verify staggered starts and a single winning result.
6. Review token and timeout logs on a large diff to confirm adaptive output sizing and the 90-second default.

## Performance Considerations

- Adaptive output budgets can increase completion-token cost on large diffs; the 16,384 cap bounds the maximum.
- Parallel attempts increase provider usage and cost because all launched attempts run to completion; setting `parallel_attempts: 1` restores the previous sequential cost and concurrency behavior.
- Staggering delays fallback cost until the head has had a fair response window.
- Sibling cancellation is not implemented: all launched attempts complete and the highest adjusted-SWE result is selected; a provider may still account for work already accepted.
- Known model-format overrides avoid guaranteed failed requests and reduce latency.

## Migration Notes

No data migration is required. Existing workflows retain sequential fallback because `parallel_attempts` defaults to 1 and receive adaptive output sizing because `max_tokens` defaults to 0. Users relying on a fixed completion limit may set `max_tokens` explicitly. The model timeout default is already 90 seconds in `src/config.ts` and `action.yml`; README must be corrected to match.

Rollback can be performed by setting `parallel_attempts: 1` and an explicit `max_tokens` value without reverting code. Provider-format overrides and custom plural fixes are internal compatibility changes with no public schema break.

## References

- Existing probe and validation record: `context/changes/probe-cap-and-stale-refs/change.md`
- Existing timeout plan: `context/changes/per-model-timeout/plan.md`
- Existing daily benchmark plan: `context/changes/daily-benchmark/plan.md`
- Provider format selection and extraction: `src/openai-client.ts:19-147`
- Provider request fallback: `src/openai-client.ts:245-359`
- Adaptive budget and model attempt helper: `src/index.ts:59-210`
- Parallel and sequential chain execution: `src/index.ts:212-353`
- Custom client construction: `src/index.ts:394-404`
- Custom score and deduplication: `src/model-chain.ts:111-135`
- New public inputs: `action.yml:116-127`
- Existing tests: `src/index.test.ts:248-466`, `src/openai-client.test.ts`, `src/model-chain.test.ts`
- Verification commands: `package.json:6-10`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Provider Output Compatibility

#### Automated

- [x] 1.1 Groq-style JSON-schema rejection retries with json_object — 5bfdd1b
- [x] 1.2 Known models bypass unsupported structured-output modes — 1bf11c7
- [x] 1.3 Fenced, balanced, and reasoning-wrapped JSON is extracted correctly — 56125ed
- [x] 1.4 Truncated responses proceed only when JSON is extractable — 010979a
- [x] 1.5 TypeScript build and provider client tests pass — 9f4a70f

#### Manual

- [ ] 1.6 Live StepFun review succeeds through text mode
- [ ] 1.7 Live Groq review succeeds through json_object fallback

### Phase 2: Custom Chain Correctness

#### Automated

- [x] 2.1 Custom score overrides propagate into chain entries and probe comparisons — 11f9f29
- [x] 2.2 Duplicate singular and plural custom model IDs appear once — 3eb862d
- [x] 2.3 Plural-only custom configuration creates a custom client — 7ea1d35
- [x] 2.4 Missing custom URL does not create a client — 7ea1d35
- [x] 2.5 Model-chain and client-construction tests pass — 7ea1d35

#### Manual

- [ ] 2.6 Plural-only custom workflow posts a review
- [ ] 2.7 Duplicate custom model is attempted once in Action logs

### Phase 3: Adaptive Budget and Staggered Parallel Fallback

#### Automated

- [x] 3.1 Explicit and adaptive token budgets obey their bounds — 3154960
- [x] 3.2 Sequential fallback behavior remains intact — 3154960
- [x] 3.3 Parallel mode selects a later winner and continues to a tail model — 3154960
- [x] 3.4 Parallel execution remains opt-in — 3154960
- [x] 3.5 Build and full unit test suite pass for the shipped implementation — 3154960

#### Manual

- [ ] 3.6 Live attempts start at the configured non-zero stagger
- [ ] 3.7 First successful review cancels unnecessary siblings

### Phase 4: Hardening, Documentation, and Live Verification

#### Automated

- [ ] 4.1 New config boundary tests pass
- [ ] 4.2 Non-zero stagger, cancellation, capping, and fallback-tail tests pass
- [ ] 4.3 README input defaults match action metadata and configuration
- [ ] 4.4 TypeScript and bundle build succeeds: npm run build
- [ ] 4.5 Full test suite passes: npm test

#### Manual

- [ ] 4.6 Plural-only custom configuration posts a review through the custom client
- [ ] 4.7 StepFun text mode and Groq json_object fallback complete live reviews
- [ ] 4.8 Non-zero stagger timing and winner cancellation are visible in logs
- [ ] 4.9 No duplicate custom attempt or duplicate review output is observed
