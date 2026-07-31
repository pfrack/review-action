# Per-Model Timeout Implementation Plan

## Overview

Add per-model timeouts (60s default, configurable) so no single slow model exhausts the chain budget, and make the aggregate chain timeout configurable with default 0 (unlimited) so users always get a result regardless of how many models are slow or failing.

## Current State Analysis

The review action uses a model fallback chain — it tries models sequentially until one succeeds. Two timeout layers exist today:

1. **Per-fetch timeout**: `AbortSignal.timeout(180_000)` on each individual HTTP request (`src/openai-client.ts:110`)
2. **Aggregate timeout**: `withAggregateTimeout()` wraps the entire chain with a 120s budget (`src/index.ts:17`)

The problem: a single slow model (e.g. deepseek-v4-pro taking 180s) eats the entire 120s aggregate budget before the chain reaches a model that would succeed. The aggregate timeout fires, returns `null`, and the action posts "No review content returned from any model" — even though later models in the chain would have worked.

### Key Discoveries:

- `src/openai-client.ts:110` — fetch uses `AbortSignal.timeout(180_000)` (3 minutes), far exceeding the 120s aggregate
- `src/retry.ts:17` — `withRetry` can do 3 attempts with exponential backoff, worst case ~542s per `client.chat()` call
- `src/index.ts:83-117` — two separate `client.chat()` calls per model (initial + schema retry), each independent
- `src/index.ts:137` — catch block already logs and continues to next model (no change needed there)
- `src/index.ts:17` — `CHAIN_TIMEOUT_MS = 120_000` hardcoded constant

## Desired End State

Each model attempt is individually time-bounded at 60s (configurable). If a model doesn't respond in 60s, it's skipped immediately and the next model is tried. The aggregate timeout defaults to 0 (unlimited) — the chain runs until a model succeeds or all models are exhausted. Users who want a hard cap can set `chain_timeout` to any value.

Verification: run the action on a PR where the first model is slow (>60s) — it should skip to the next model within ~60s and eventually post a real review.

## What We're NOT Doing

- Changing the retry logic in `retry.ts` (the per-model signal will abort retries naturally)
- Adding per-model timeout to the `probeModels()` function (it already has its own 10s probe timeout)
- Changing the streaming (`chatStream`) path (not used in the review flow)
- Adding timeout configuration per-provider or per-model (single global `model_timeout` is sufficient)

## Implementation Approach

Add `signal?: AbortSignal` to `ChatOptions` → combine it with the existing 180s fetch timeout via `AbortSignal.any()` → pass `AbortSignal.timeout(modelTimeoutMs)` at each `client.chat()` call site in `runModelChainForBatch`. For the aggregate, replace the hardcoded `CHAIN_TIMEOUT_MS` with config-driven logic where 0 means unlimited (skip the `Promise.race` entirely).

## Phase 1: Per-Model Timeout Injection

### Overview

Wire a per-model abort signal through the `OpenAIClient.chat()` method so each individual call (including each retry attempt within `withRetry`) respects a 60s timeout. Schema retries get their own fresh signal.

### Changes Required:

#### 1. Add `signal` to ChatOptions

**File**: `src/openai-client.ts`

**Intent**: Allow callers to pass an `AbortSignal` that aborts the entire `client.chat()` call including its internal retries.

**Contract**: Add `signal?: AbortSignal` field to the `ChatOptions` interface (after the existing `format` field).

#### 2. Wire signal into fetch and retry loop

**File**: `src/openai-client.ts`

**Intent**: Combine the caller's signal with the existing 180s fetch timeout using `AbortSignal.any()`. Check signal state before each retry attempt to short-circuit retries when the caller's budget is exhausted.

**Contract**:
- In the `chat()` method, extract `opts.signal` at the top.
- Replace `signal: AbortSignal.timeout(180_000)` in the fetch call with:
  ```typescript
  signal: outerSignal
    ? AbortSignal.any([AbortSignal.timeout(180_000), outerSignal])
    : AbortSignal.timeout(180_000),
  ```
- Add an abort check at the top of the `withRetry` callback: if `outerSignal?.aborted`, throw immediately (the error will be caught by `runModelChainForBatch`'s catch block and the chain moves on).

#### 3. Pass per-model timeout signals in runModelChainForBatch

**File**: `src/index.ts`

**Intent**: Each `client.chat()` call gets its own `AbortSignal.timeout(modelTimeoutMs)`. The schema retry gets a fresh signal (separate budget). The timeout value comes from the `config.modelTimeout` field (wired in Phase 2), with a hardcoded 60_000 fallback until then.

**Contract**:
- Before the first `client.chat()` call (line ~83): create `const attemptSignal = AbortSignal.timeout(modelTimeoutMs)` and pass it as `signal: attemptSignal` in the options.
- Before the schema retry `client.chat()` call (line ~103): create a fresh `const retrySignal = AbortSignal.timeout(modelTimeoutMs)` and pass it.
- Add a `modelTimeoutMs` parameter to the `runModelChainForBatch` function signature (default: `60_000`).

### Success Criteria:

#### Automated Verification:

- TypeScript compiles: `npx tsc --noEmit`
- Existing tests pass: `npm test`
- New unit test: a mock server that delays 2s; calling `client.chat()` with a 500ms signal should reject with an abort error
- New unit test: calling `client.chat()` without a signal still uses the 180s default

#### Manual Verification:

- Deploy to a test PR and confirm a slow model is skipped after ~60s (visible in Actions log: model fails with timeout, next model is tried)

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Aggregate Timeout Configuration

### Overview

Add `model_timeout` and `chain_timeout` as action inputs. Replace the hardcoded `CHAIN_TIMEOUT_MS = 120_000` with config-driven logic where `chain_timeout: 0` means unlimited (the default — no aggregate timeout wraps the chain).

### Changes Required:

#### 1. Add inputs to action.yml

**File**: `action.yml`

**Intent**: Expose `model_timeout` (seconds, default 60) and `chain_timeout` (seconds, default 0 = unlimited) as user-configurable inputs.

**Contract**: Two new `inputs` entries after `revalidate_findings`:
- `model_timeout`: description "Timeout in seconds for each individual model call (0 = no per-model limit)", default `'60'`
- `chain_timeout`: description "Overall timeout in seconds for the full model chain (0 = unlimited, keeps trying all models)", default `'0'`

#### 2. Add fields to Config interface and loadConfig

**File**: `src/config.ts`

**Intent**: Parse the new inputs into `modelTimeout: number` and `chainTimeout: number` on the Config object.

**Contract**:
- Add `modelTimeout: number` and `chainTimeout: number` to the `Config` interface.
- In `loadConfig()`, parse both using the same IIFE pattern as `maxFiles`. For `modelTimeout`: default 60, must be >= 0, 0 means no per-model limit. For `chainTimeout`: default 0, must be >= 0, 0 means unlimited.

#### 3. Wire config values into the execution path

**File**: `src/index.ts`

**Intent**: Remove the hardcoded `CHAIN_TIMEOUT_MS` constant. Pass `config.modelTimeout * 1000` to `runModelChainForBatch`. Make `withAggregateTimeout` conditional — if `config.chainTimeout === 0`, call `runModelChainForBatch` directly without the `Promise.race` wrapper.

**Contract**:
- Delete `const CHAIN_TIMEOUT_MS = 120_000`
- In `executeReview`, change the batch processing: if `config.chainTimeout > 0`, wrap with `withAggregateTimeout(…, config.chainTimeout * 1000)`; otherwise call `runModelChainForBatch` directly.
- Pass `config.modelTimeout * 1000` (or skip signal creation if `config.modelTimeout === 0`) to `runModelChainForBatch`.

### Success Criteria:

#### Automated Verification:

- TypeScript compiles: `npx tsc --noEmit`
- Existing tests pass: `npm test`
- Config test: verify `loadConfig()` returns `modelTimeout: 60` and `chainTimeout: 0` with default inputs
- Config test: verify invalid values warn and fall back to defaults

#### Manual Verification:

- With `chain_timeout: 0` (default), confirm the action runs all models until success — no "timed out" warning in logs
- With `chain_timeout: 120`, confirm old behavior is preserved (times out at 120s)

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Tests and Verification

### Overview

Add targeted test cases for the new timeout behavior. Update any existing tests that rely on the hardcoded 120s constant or the `withAggregateTimeout` export.

### Changes Required:

#### 1. Per-model timeout tests

**File**: `src/openai-client.test.ts`

**Intent**: Verify that passing a signal to `chat()` aborts the request, and that not passing a signal preserves existing behavior.

**Contract**: Two new test cases:
- `chat() aborts when signal fires before response` — mock server with 2s delay, pass `AbortSignal.timeout(100)`, assert rejection
- `chat() ignores signal when response arrives first` — mock server with instant response, pass `AbortSignal.timeout(5000)`, assert success

#### 2. Aggregate timeout tests

**File**: `src/index.test.ts`

**Intent**: Verify `withAggregateTimeout` returns `null` when timer fires and returns result when operation completes in time. Verify it's skipped when `chainTimeout` is 0.

**Contract**: Tests for:
- `withAggregateTimeout returns null on timeout` (existing behavior preserved)
- `withAggregateTimeout returns result when fast enough` (existing behavior preserved)

#### 3. Config tests

**File**: `src/config.test.ts`

**Intent**: Verify the new `modelTimeout` and `chainTimeout` fields parse correctly with valid, invalid, and missing inputs.

**Contract**: Test cases for:
- Default values (60 and 0)
- Custom valid values
- Invalid values (negative, NaN) → warning + fallback to defaults
- Zero as explicit valid value for both fields

### Success Criteria:

#### Automated Verification:

- All tests pass: `npm test`
- No type errors: `npx tsc --noEmit`

#### Manual Verification:

- Run the full test suite and confirm no regressions

---

## Testing Strategy

### Unit Tests:

- `OpenAIClient.chat()` respects `signal` in `ChatOptions`
- `AbortSignal.any()` correctly combines per-model and per-fetch timeouts
- `withAggregateTimeout` returns null on timeout, result on success
- Config parsing of `model_timeout` and `chain_timeout`
- `runModelChainForBatch` skips timed-out models and continues chain

### Integration Tests:

- Mock server with intentional delay → verify model is skipped within ~60s
- Multiple models where first is slow, second succeeds → verify result comes from second model

### Manual Testing Steps:

1. Open a PR in freedius with the updated action
2. Observe Actions log: first slow model should timeout at ~60s, not 120s
3. Verify a later model succeeds and the review is posted
4. Test with `chain_timeout: 120` to confirm old bounded behavior is available

## Performance Considerations

- `AbortSignal.any()` is available in Node 20+ (which the action uses: `runs.using: 'node24'`)
- Per-model timeout adds no overhead for fast models — the signal just never fires
- Removing the default aggregate timeout means the action runs longer on bad days (all models down) but this is the intended behavior (user wants a result, not a fast "no result")

## References

- `src/openai-client.ts:110` — existing 180s fetch timeout
- `src/index.ts:17` — hardcoded `CHAIN_TIMEOUT_MS = 120_000`
- `src/index.ts:83-117` — two `client.chat()` calls per model in chain
- `src/retry.ts:17-35` — `withRetry` with 2 retries + exponential backoff
- `src/config.ts:4-33` — Config interface
- `action.yml` — action inputs definition
- GitHub Actions log from freedius PR #37 — shows the timeout killing the chain at 120s while minimax-m3 would have succeeded at ~5.5min

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Per-model timeout injection

#### Automated

- [x] 1.1 TypeScript compiles with new signal parameter
- [x] 1.2 Existing tests pass unchanged
- [x] 1.3 New test: chat() aborts when signal fires before response
- [x] 1.4 New test: chat() works normally without signal

#### Manual

- [ ] 1.5 Slow model is skipped after ~60s in Actions log

### Phase 2: Aggregate timeout configuration

#### Automated

- [ ] 2.1 TypeScript compiles with new config fields
- [ ] 2.2 Existing tests pass
- [ ] 2.3 Config test: default values (modelTimeout=60, chainTimeout=0)
- [ ] 2.4 Config test: invalid values warn and fallback

#### Manual

- [ ] 2.5 chain_timeout=0 runs all models without aggregate timeout
- [ ] 2.6 chain_timeout=120 preserves bounded behavior

### Phase 3: Tests and verification

#### Automated

- [ ] 3.1 All new timeout tests pass
- [ ] 3.2 No type errors in full codebase
- [ ] 3.3 Full test suite green
