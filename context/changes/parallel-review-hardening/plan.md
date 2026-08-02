# Pipeline Hardening Implementation Plan

## Overview

Fix the reliability, execution-safety, probe, and GitHub-integration findings identified in the parallel review research (`context/changes/parallel-review-findings/research.md` §1-3). This is **Change 2 of 3** split from the parallel-review-findings umbrella — Change 1 (security) shipped; Change 3 (testing) is separate.

The findings span four risk classes: **BUG**-level dead retry in benchmark callers (HTTP 5xx/429 retried zero times), **HIGH** probe misordering (8-token "Say hi" latency has zero correlation with review latency), **MEDIUM** execution fragility (one batch failure can kill the whole review; undefined response fields crash downstream), and **MEDIUM/LOW** GitHub-integration gaps (HTML error bodies crash `.json()`, missing 404 handling, misleading errors on non-PR events).

## Current State Analysis

The codebase has a multi-provider model fallback chain that has been progressively hardened by sibling changes. Several research findings are **already resolved** and are explicitly out of scope here:

- **Probe promotion cap** — `model-chain.ts:12` `PROBE_PROMOTE_MAX_HEAD_GAP = 0.02` is enforced (`probeModels` returns `null` when the fastest model's SWE score is >0.02 below the head). The research's "comment says no-promote but code does promote" BUG is fixed; the comment now matches the code. Owned by `probe-cap-and-stale-refs`.
- **Per-model + aggregate timeout** — `config.modelTimeout` (default 90s) and `config.chainTimeout` (default 0 = unlimited) are wired through `attemptModel` via `AbortSignal.any([AbortSignal.timeout(modelTimeoutMs), externalSignal])` at `index.ts:118-120`. The 180s fetch ceiling in `openai-client.ts:297` now only applies when `model_timeout: 0`. Owned by `per-model-timeout`.
- **Raw-content XSS + rule injection + revalidation** — `buildRawOutputBody` (`index.ts:394`) escapes via `escapeMarkdown`; injection rules are blocked (not just warned); `strictRevalidation` added. Owned by `parallel-review-security`.
- **`Retry-After` seconds/ms** — `parseRetryAfter` (`openai-client.ts:4-11`) converts integer seconds `* 1000`. Already correct.

What remains **open** (this change's scope):

- **Dead retry in benchmark callers** — `swe-resolver.ts:31` and `bench-reorder.ts:62` throw `new Error(...)` on HTTP failure. `withRetry` (`retry.ts:25`) extracts `status` only from `RetryableError`; a plain `Error` yields `status: 0`, so the retry condition (`status >= 500 || status === 429 || isFetchNetworkError`) is **false** and 5xx/429 are retried zero times. The live review path (`openai-client.ts:308`, `review.ts:157`, `github-review.ts`) already throws `RetryableError`, so this only affects the benchmark/CLI paths — but those are the paths that most need retry (leaderboard/SWE-bench APIs are flaky).
- **No jitter in backoff** — `retry.ts:13` `exponentialDelay = delayMs * 2^attempt` with no randomness. Concurrent retries (e.g., parallel probes, batched benchmark) retry in lockstep, maximizing collision probability.
- **Undefined response fields** — `openai-client.ts:363` returns `usage: data.usage` (can be `undefined`) and `finishReason: choice.finish_reason` (can be `undefined`). Downstream: `bench.ts:59,65` accesses `chatResult.usage.completion_tokens` — crashes when `usage` is undefined. Truncation detection (`index.ts:133` `result.finishReason === 'length'`) silently fails to detect truncation when `finishReason` is undefined.
- **Batch loop has no try/catch** — `executeReview` (`index.ts:449-463`) iterates batches; the `runBatch()` / `withAggregateTimeout` call is **not wrapped in try/catch**. An unexpected throw from the model chain (e.g., an unhandled error type, a `.json()` parse failure inside a client) escapes `executeReview` and kills the entire review. The `result === null` (timeout) path at line 459-461 already logs dropped files — but only the timeout case is handled, not arbitrary throws.
- **Winner-take-all abort is invisible** — `index.ts:253` `if (result && result.findings.length > 0) controller.abort()`. This is the agreed strategy (parallel candidates are top-N SWE-bench models, small quality gap, speed wins), but the abort is silent — there's no log of which model won and which were cancelled, making parallel-mode behavior impossible to debug from Action logs.
- **Probe measures the wrong thing** — `probeModels` (`model-chain.ts:141-202`) sends "Say hi" (8 tokens) via `probeModel` (`openai-client.ts:444-453`). 8-token latency has zero correlation with review latency on multi-thousand-token diffs. Worse, `prioritizeChain` (`index.ts:421-429`) splices the fastest probed model to the **front** of the chain — so a model that's fast at "Say hi" but slow at real reviews can leapfrog the SWE-bench-ordered head. (The 0.02 cap limits this to near-tied scores, but it's still a misordering source.) Concurrent probes on the same API key (`PROBE_CONCURRENCY = 3`) can trigger 429s, and the probe itself doesn't retry.
- **`.json()` parse crash** — `github-review.ts:100` `const data = await resp.json()` has no try/catch. A non-JSON body (e.g., an HTML 502 from a corporate proxy, or a GitHub maintenance page) throws an unhandled `SyntaxError` that propagates up. The 2 other read sites in `github-review.ts` (`github-review.ts:137`, `github-review.ts:264`) have the same pattern, as do the benchmark-path reads in `bench-reorder.ts:66` and `swe-resolver.ts:34`.
- **`createComment` missing 404 handling** — `findExistingComment` (`github-review.ts:258-261`) catches `RetryableError` status 404 and returns `null` (graceful). `createComment` (`github-review.ts:278-296`) has no such guard — a 404 on POST (PR deleted mid-review) throws and can abort the review.

### Key Discoveries:

- `retry.ts:25` — `const status = error instanceof RetryableError ? error.status : 0;` is the exact line that zeroes out non-`RetryableError` throws, making the `status >= 500` retry condition unreachable for plain `Error`.
- `swe-resolver.ts:31` and `bench-reorder.ts:62` — the only two `withRetry` callers that throw plain `Error` instead of `RetryableError`. All live-path callers (`openai-client.ts:308`, `review.ts:157`, `github-review.ts:95,210,229,254,294`) already throw `RetryableError`.
- `index.ts:449-463` — the batch loop. The `result === null` branch (line 459) already logs "Batch N/M timed out — K file(s) dropped", so dropped-batch *logging* for the timeout case exists; the gap is the missing try/catch for the throw case, and the fact that a throw currently escapes the loop entirely (no `batchResults.push(...)` fallback, no continue).
- `index.ts:421-429` — `prioritizeChain` calls `probeModels` and, if it returns a non-null model, splices it to index 0. This is the reorder to remove.
- `model-chain.ts:147` — `PROBE_CONCURRENCY = 3` batches probes; within a batch they're concurrent via `Promise.all` (line 170), which can hit per-key rate limits.
- `bench.ts:59,65` — `chatResult.usage.completion_tokens` is the concrete crash site for undefined `usage`.
- `github-review.ts:100` — `resp.json()` after a successful `withRetry` (i.e., response was `ok` but body is HTML). All 7 `.json()` call sites are structurally identical.
- `event.ts:24` — `if (!event.pull_request?.number || !event.pull_request?.head?.sha)` is the check that produces the misleading error.

## Desired End State

- Benchmark/CLI HTTP calls (`fetchLeaderboard`, `fetchSweBenchScores`) actually retry on 5xx/429 instead of failing on the first attempt.
- `withRetry` backoff includes jitter so concurrent retries don't collide.
- `OpenAIClient.chat()` never returns `undefined` for `usage` or `finishReason`; downstream code (`bench.ts`, truncation detection) handles the absence gracefully.
- A single batch failure (throw or timeout) is caught, logged with file count, and the remaining batches still process — one bad batch can't kill the review.
- Parallel-mode winner-take-all abort is logged (which model won, which were cancelled) so parallel behavior is debuggable.
- The probe no longer reorders the chain — it confirms availability and records latency, but SWE-bench order is authoritative. Failure-fallback (fall through to the next model on failure) is preserved.
- GitHub API `.json()` parse failures are caught and surfaced as clear warnings instead of crashing the action; `createComment` handles 404 gracefully; `loadEvent` validates the event type and gives an actionable error on non-PR events.


## What We're NOT Doing

- **Changing the winner-take-all parallel strategy** — keeping it (parallel candidates are top-N SWE-bench models, small quality gap, speed wins); only adding observability. A "collect all + compare quality" redesign is explicitly deferred.
- **Adding new retry config inputs** (`max_retries`, `base_delay`) — keeping the retry surface minimal; the existing defaults (2 retries, 1000ms base) are retained.
- **Capping concurrent probes** — the existing `PROBE_CONCURRENCY = 3` batching stays; probe 429s are tolerated (probe failure → model kept in chain, tried on failure-fallback).
- **Switching to Octokit / `@actions/github`** — the raw-`fetch` pattern is retained; only the specific parse/404 gaps are fixed.
- **`AI_REVIEW_MARKER` `user.login` check** — deferred (lower impact; checking bot identity requires an extra API call per comment during cleanup).
- **`chatStream` cleanup** (`openai-client.ts:369-442`) — appears unused/legacy; out of scope (no tests, not in review flow).
- **Hardcoded model allowlists** (`NO_JSON_SCHEMA_MODELS`, `NO_STRUCTURED_OUTPUT_MODELS`) — tech debt but functional; out of scope.
- **Testing debt** (`withRetry` coverage, `diff-utils` assertions, `run()` testing) — owned by Change 3 (`parallel-review-testing`).
- **Security findings** — owned by Change 1 (`parallel-review-security`, implemented).

## Implementation Approach

Three phases by risk and blast radius. **Phase 1** bundles the clear-cut robustness bug fixes (retry error type, jitter, response-field guards, batch-loop try/catch, abort observability) — these are defensive and don't change review behavior for the common path. **Phase 2** is the probe redesign — a behavior change (chain no longer reordered by probe), so it's isolated for careful verification. **Phase 3** is GitHub/config cleanup — independent, lowest risk, ships last.

Every fix ships with a test proving the failure mode is closed. Existing tests must stay green throughout — none of these changes alter the default review path's observable output.

## Critical Implementation Details

- **State sequencing — probe redesign**: `prioritizeChain` (`index.ts:421-429`) currently mutates the chain array in place by splicing the probed-fastest model to index 0. Removing the reorder means `prioritizeChain` becomes a no-op for ordering (it may still log probe results). The chain passed to `executeReview` must retain the SWE-bench-sorted order from `buildCombinedChain`. Failure-fallback is already handled by `runModelChainForBatch`'s sequential loop (it tries each model in order and falls through on failure), so removing probe reorder does not reduce resilience — it only stops a latency-misordered model from leapfrogging.
- **Timing & lifecycle — batch-loop catch**: the try/catch must wrap the *entire* `runBatch()`/`withAggregateTimeout` call, and the catch must push a sentinel empty `BatchResult` (matching the existing `result ?? {...}` shape at line 462) so `mergeFindings` and the downstream `batchResults` aggregation still work. The loop must `continue` to the next batch, not `break`.

## Phase 1: Robustness & Execution Safety

### Overview

Fix the dead-retry BUG in benchmark callers, add jitter to backoff, guard undefined response fields, wrap the batch loop in try/catch with dropped-batch logging, and add winner-take-all abort observability. All defensive — no change to default review output.

### Changes Required:

#### 1.1 Fix dead-retry error type in benchmark callers

**File**: `src/swe-resolver.ts`, `src/bench-reorder.ts`

**Intent**: Make `withRetry` actually retry 5xx/429 from the leaderboard and SWE-bench APIs by throwing `RetryableError` instead of plain `Error`, so the retry condition in `retry.ts:28` (`status >= 500 || status === 429`) can match.

**Contract**: In `fetchLeaderboard` (`swe-resolver.ts:29-33`) and `fetchSweBenchScores` (`bench-reorder.ts:58-64`), replace `throw new Error(\`... returned ${r.status}\`)` with `throw new RetryableError(\`... returned ${r.status}\`, r.status)`. Import `RetryableError` from `./retry.js` in both files. The error message text stays the same so existing catch/log output is unchanged.

#### 1.2 Add jitter to exponential backoff

**File**: `src/retry.ts`

**Intent**: Prevent lockstep retries when multiple calls retry concurrently (parallel probes, batched benchmark) by adding random jitter to the delay.

**Contract**: In `getRetryDelay` (`retry.ts:12-16`), add jitter to the exponential component: `const jitter = Math.random() * delayMs;` then `const exponentialDelay = Math.min(delayMs * Math.pow(2, attempt) + jitter, 30_000);`. The `retryAfterMs` floor and 60s cap (`Math.min(Math.max(exponentialDelay, retryAfterMs), 60_000)`) remain. Jitter is bounded by `delayMs` (base, not exponential) so it doesn't blow past the cap unpredictably. Existing `getRetryDelay` tests (`retry.test.ts:22-31`) check exact values — update them to use approximate ranges (`assert.ok(delay >= baseExpected && delay <= baseExpected + 1000)`).

#### 1.3 Guard undefined `usage` and `finishReason`

**File**: `src/openai-client.ts`

**Intent**: Prevent downstream crashes when a provider omits `usage` or `finish_reason` from the response, and ensure truncation detection fails safe (doesn't false-positive on undefined).

**Contract**: In `chat()` (`openai-client.ts:361-366`), default `usage` to `{ completion_tokens: 0, prompt_tokens: 0, total_tokens: 0 }` and `finishReason` to `null` before returning. The `index.ts:133` and `:175` `finishReason === 'length'` checks already handle `null` safely (evaluates false → no false truncation), and `bench.ts:59,65` `chatResult.usage.completion_tokens` will read `0` instead of crashing. The `usage` shape matches the existing `ChatCompletionUsage` type (fields `completion_tokens`, `prompt_tokens`, `total_tokens` at `openai-client.ts:209-211`).

#### 1.4 Wrap batch loop in try/catch with dropped-batch logging

**File**: `src/index.ts`

**Intent**: Prevent a single batch's unexpected throw from killing the entire review by catching it, logging the batch and file count, and continuing to the next batch.

**Contract**: In `executeReview` (`index.ts:449-463`), wrap the `runBatch()`/`withAggregateTimeout` call in try/catch. The catch logs `core.warning(\`Batch ${n}/${total} failed: ${err} — ${batch.files.length} file(s) dropped\`)` and pushes the same sentinel empty `BatchResult` (`{ findings: [], summary: '', usedModel: '', lastRawContent: '', dropped: 0 }`) as the existing null-result path. The loop continues. The existing `result === null` timeout log (line 460) stays. No `break` on error.

#### 1.5 Add winner-take-all abort observability

**File**: `src/index.ts`

**Intent**: Make parallel-mode abort behavior visible in Action logs by logging which model won and which were cancelled, so parallel mode is debuggable.

**Contract**: In `runModelChainForBatch` (`index.ts:234-272`), after the `Promise.all` settle loop identifies the `winner` (line 260-272), if `winner` is non-null and `parallelCount > 1`, log `core.info(\`Parallel: ${winner.usedModel} won; cancelled ${cancelledIds.join(', ')}\`)` where `cancelledIds` is the list of attempted model ids that returned `null` due to abort (i.e., were in `attemptPromises` but produced no result). Do not log at the `controller.abort()` call site (line 253) — the cancelled ids aren't known until settle.

### Success Criteria:

#### Automated Verification:

- `npm run build` succeeds (tsc + ncc bundle)
- `npm test` passes — all existing tests green
- New test: `withRetry` retries a `RetryableError` with status 500 (existing or new in `retry.test.ts`)
- New test: `fetchLeaderboard` / `fetchSweBenchScores` retries on 5xx (mock server returning 500 once then 200)
- New test: `getRetryDelay` returns a value within `[baseExpected, baseExpected + delayMs]` with jitter
- New test: `chat()` with missing `usage` field returns defaulted usage (no crash)
- New test: `chat()` with missing `finish_reason` returns `finishReason: null` (no false truncation)
- New test: `executeReview` with a batch that throws continues to the next batch (remaining batch findings present)
- New test: `runModelChainForBatch` parallel mode logs the winner and cancelled model ids (capture `core.info` calls)

#### Manual Verification:

- Benchmark workflow: leaderboard fetch recovers from a transient 5xx (visible in workflow logs as a retry then success)
- Multi-batch PR: forcing one batch to fail does not abort the review — other batches' findings appear in the PR comment
- Parallel-mode PR: Action log shows "Parallel: <model> won; cancelled <models>"
- No regressions in default (sequential, single-batch) review output


---

## Phase 2: Probe Redesign

### Overview

Convert the probe from a chain-reordering mechanism to an availability check + latency measurement. SWE-bench order becomes authoritative; failure-fallback (fall through on failure) is preserved. This removes the misordering source where a model fast at "Say hi" but slow at real reviews leapfrogs the SWE-bench head.

### Changes Required:

#### 2.1 Remove probe-based chain reorder

**File**: `src/index.ts`

**Intent**: Stop `prioritizeChain` from mutating the chain order based on probe latency. The probe still runs (for availability logging and latency recording) but no longer splices a model to the front.

**Contract**: `prioritizeChain` (`index.ts:421-429`) currently calls `probeModels` and, on a non-null result, splices the fastest model to index 0. Remove the splice — `prioritizeChain` becomes a no-op for ordering (it may keep a `core.info` log of probe results for observability, or be reduced to a no-op call that retains the probe side-effect of warming connections). The chain passed to `executeReview` retains `buildCombinedChain`'s SWE-bench-sorted order. If `prioritizeChain` no longer mutates, its callers (`run()` at `index.ts:634`) need no change (it returns `void`).

#### 2.2 Repurpose probeModels to availability + latency (no reorder)

**File**: `src/model-chain.ts`

**Intent**: Keep `probeModels` as an availability check that records latency (useful for metrics/logging), but remove its role in choosing chain order. The return value can remain (fastest available model) for logging, but is no longer used to reorder.

**Contract**: `probeModels` (`model-chain.ts:141-202`) keeps its current logic (probe each model, return the fastest available) but its return value is no longer consumed for ordering by `prioritizeChain`. The `PROBE_PROMOTE_MAX_HEAD_GAP` cap logic (lines 192-200) becomes dead for ordering purposes but can stay as a guard on the returned value (harmless). Optionally, have `probeModels` log per-model latency at `core.info` for observability. No change to `PROBE_CONCURRENCY` or `PROBE_TIMEOUT_MS`. The `probeModel` method in `openai-client.ts:444-453` is unchanged.

### Success Criteria:

#### Automated Verification:

- `npm run build` succeeds
- `npm test` passes — all existing tests green
- New test: `prioritizeChain` does not change chain order regardless of probe results (chain before == chain after)
- New test: `probeModels` still returns the fastest available model (return value preserved for logging)
- Existing `model-chain.test.ts` probe tests still pass (adjust expectations if they asserted reorder behavior)

#### Manual Verification:

- PR review: chain order in Action log matches `buildCombinedChain` SWE-bench order (no probe-driven leapfrog)
- A model that's fast at the probe but slower at reviews no longer appears first
- Failure-fallback still works: if the head model fails, the next model in SWE-bench order is tried
- No regressions in review quality or latency


---

## Phase 3: GitHub/Config Cleanup

### Overview

Fix the three highest-impact GitHub-integration gaps: `.json()` parse crashes on non-JSON bodies, `createComment` missing 404 handling, and `loadEvent` missing event-type validation. Independent of Phases 1-2; lowest risk.

### Changes Required:

#### 3.1 Guard `.json()` parse in GitHub API call sites

**File**: `src/github-review.ts`, `src/bench-reorder.ts`, `src/swe-resolver.ts`

**Intent**: Prevent an unhandled `SyntaxError` when an API response has a non-JSON body (HTML 502 from a proxy, GitHub/SWE-bench maintenance page) by wrapping `.json()` in try/catch and throwing a clear `RetryableError` (status 502, recoverable by `withRetry`). This covers both GitHub call sites and benchmark/CLI call sites that hit the flaky SWE-bench leaderboard API — consistent hardening for all flaky-API parse paths.

**Contract**: At each `await resp.json()` call site after a successful `withRetry` (i.e. response was `ok` but the body may not be JSON), wrap the parse: `let data; try { data = await resp.json(); } catch (err) { throw new RetryableError(\`<Source> API returned non-JSON body (${err instanceof Error ? err.message : err})\`, 502); }`. The 502 status makes it retryable (matches `retry.ts:28` `status >= 500`).

Call sites to guard (3 total, corrected from the 7 claimed in Current State Analysis):
- `github-review.ts:100` — `createIssue` read
- `github-review.ts:137` — review fetch read
- `github-review.ts:264` — existing-comment lookup read
- `bench-reorder.ts:66` — `fetchSweBenchScores` read (SWE-bench leaderboard API)
- `swe-resolver.ts:34` — `fetchLeaderboard` read (SWE-bench leaderboard API)

Apply to all read sites; write sites (POST/DELETE) that don't parse the body are unaffected. The pattern matches `openai-client.ts:326` (`throw new RetryableError('…non-JSON response', 502)`).

#### 3.2 Add 404 graceful handling to createComment

**File**: `src/github-review.ts`

**Intent**: Make `createComment` consistent with `findExistingComment` by catching 404 (PR deleted mid-review) and returning gracefully instead of throwing.

**Contract**: `createComment` (`github-review.ts:278-296`) currently throws `RetryableError` on any non-OK. Wrap the `withRetry` call (or the outer call) in try/catch: if `err instanceof RetryableError && err.status === 404`, log `core.warning('PR not found (404) when posting comment — skipping')` and return instead of rethrowing. Mirror the pattern at `findExistingComment:258-261`. The caller `postComment` (exported, used by `dispatchOutput`) must tolerate the no-throw on 404.

#### 3.3 Add event-type validation in loadEvent

**File**: `src/event.ts`

**Intent**: Give an actionable error when the action is invoked on a non-PR event (push, issue, schedule) instead of the misleading "No PR number or head SHA in event payload".

**Contract**: In `loadEvent` (`event.ts:10-29`), after parsing, check the event type before the `pull_request` field check. The GitHub event payload includes a top-level field indicating the event (e.g., `pull_request` object presence is the signal). Restructure: if `event.pull_request` is `undefined`/`null` (not just missing `.number`), throw `new Error('This action only runs on pull_request events. Received event without a pull_request payload — check your workflow triggers.')`. Keep the existing "No PR number or head SHA" error for the case where `pull_request` exists but fields are missing. Optionally read `process.env.GITHUB_EVENT_NAME` to include the actual event name in the error.

### Success Criteria:

#### Automated Verification:

- `npm run build` succeeds
- `npm test` passes — all existing tests green
- New test: `github-review` read function with a non-JSON 200 body throws `RetryableError` with status 502 (retryable), not `SyntaxError`
- New test: `fetchLeaderboard` / `fetchSweBenchScores` with a non-JSON 200 body throws `RetryableError` with status 502, not `SyntaxError`
- New test: `createComment` on a 404 response logs a warning and does not throw
- New test: `loadEvent` with a payload lacking `pull_request` throws an event-type error (not "No PR number")
- New test: `loadEvent` with `pull_request` but missing `number` still throws the field error

#### Manual Verification:

- Action on a non-PR event (if testable) shows the event-type error, not "No PR number"
- Review on a PR where GitHub returns a maintenance page: action retries (via 502) or fails with a clear message, not a raw `SyntaxError`
- No regressions in normal review posting


## Testing Strategy

### Unit Tests:

- `withRetry` retries on `RetryableError` 500/429; does not retry on 400; retries on `TypeError` (network) — covers the fixed error type path
- `getRetryDelay` with jitter returns values in `[base, base + delayMs]` range across multiple calls
- `chat()` with missing `usage`/`finish_reason` returns defaults (no crash)
- `executeReview` continues past a throwing batch; remaining batches' findings present
- `runModelChainForBatch` parallel mode logs winner + cancelled ids
- `prioritizeChain` preserves chain order regardless of probe results
- `probeModels` returns fastest available (return value preserved)
- `github-review` `.json()` parse failure → `RetryableError` 502
- `createComment` 404 → warning, no throw
- `loadEvent` non-PR payload → event-type error

### Integration Tests:

- Mock server returning 500 once then 200: `fetchLeaderboard`/`fetchSweBenchScores` succeeds after retry
- Multi-batch `executeReview` with one batch throwing: other batches' findings in result
- Parallel `runModelChainForBatch` with two succeeding models: winner logged, loser cancelled

### Manual Testing Steps:

1. Run the benchmark workflow on a day the leaderboard API is flaky — confirm retry then success in logs
2. Open a PR with >50 files (multi-batch) and force one batch failure (e.g., bad model key for one provider) — confirm other batches' findings appear
3. Run the action with `parallel_attempts: 3` on a PR — confirm "Parallel: <model> won; cancelled <models>" in logs
4. Run the action on a non-PR event (push) — confirm event-type error, not "No PR number"
5. Confirm default (sequential, single-batch) review output is unchanged

## Performance Considerations

- Jitter adds at most `delayMs` (1000ms) to the first retry delay — negligible vs. the exponential component, and only on the retry path (not the common success path).
- Removing probe reorder has no performance impact — the probe still runs (same latency cost); only the chain order changes. If anything, keeping SWE-bench order may be *faster* on average (the head model is the best, not the fastest-at-"Say hi").
- Batch-loop try/catch adds no overhead on the success path (try/catch is near-zero cost in V8 when no throw occurs).
- Abort observability logging is one `core.info` per parallel batch — negligible.

## Migration Notes

- No data migration. No config input changes. No `action.yml` changes.
- The probe-redesign behavior change (no reorder) is transparent to users — they don't configure probe behavior. The chain order they see in logs will match SWE-bench order instead of probe-latency order. Document in release notes that probe no longer reorders the chain (SWE-bench order is authoritative).
- Retry jitter changes retry timing slightly — benchmark workflows may see marginally different retry delays, but always within the existing 60s cap. No user action needed.

## References

- Related research: `context/changes/parallel-review-findings/research.md` (§1 Pipeline, §2 Model Chain, §3 GitHub Integration)
- Change 1 (security, implemented): `context/changes/parallel-review-security/plan.md`
- Change 3 (testing, separate): `parallel-review-testing` (not yet created)
- `src/retry.ts:25-28` — retry condition that zeroes non-`RetryableError` status
- `src/swe-resolver.ts:31`, `src/bench-reorder.ts:62` — plain-`Error` throws (dead retry)
- `src/retry.ts:13` — no-jitter exponential backoff
- `src/openai-client.ts:361-366` — undefined `usage`/`finishReason` return
- `src/bench.ts:59,65` — `chatResult.usage.completion_tokens` crash site
- `src/index.ts:449-463` — batch loop without try/catch
- `src/index.ts:253` — winner-take-all abort (silent)
- `src/index.ts:421-429` — `prioritizeChain` probe reorder
- `src/model-chain.ts:141-202` — `probeModels`
- `src/github-review.ts:100` — unguarded `.json()`
- `src/github-review.ts:278-296` — `createComment` missing 404 handling

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Robustness & Execution Safety

#### Automated

- [x] 1.1 `npm run build` succeeds (tsc + ncc bundle)
- [x] 1.2 `npm test` passes — all existing tests green
- [x] 1.3 New test: `withRetry` retries a `RetryableError` with status 500
- [x] 1.4 New test: `fetchLeaderboard`/`fetchSweBenchScores` retries on 5xx (mock 500 then 200)
- [x] 1.5 New test: `getRetryDelay` returns value within `[baseExpected, baseExpected + delayMs]` with jitter
- [x] 1.6 New test: `chat()` with missing `usage` returns defaulted usage (no crash)
- [x] 1.7 New test: `chat()` with missing `finish_reason` returns `finishReason: null` (no false truncation)
- [x] 1.8 New test: `executeReview` with a throwing batch continues to next batch (remaining findings present)
- [x] 1.9 New test: `runModelChainForBatch` parallel mode logs winner and cancelled model ids

#### Manual

- [ ] 1.10 Benchmark workflow: leaderboard fetch recovers from transient 5xx (retry then success in logs)
- [ ] 1.11 Multi-batch PR: one batch failure does not abort review — other batches' findings appear
- [ ] 1.12 Parallel-mode PR: Action log shows "Parallel: <model> won; cancelled <models>"
- [ ] 1.13 No regressions in default (sequential, single-batch) review output

### Phase 2: Probe Redesign

#### Automated

- [x] 2.1 `npm run build` succeeds
- [x] 2.2 `npm test` passes — all existing tests green
- [x] 2.3 New test: `prioritizeChain` does not change chain order regardless of probe results
- [x] 2.4 New test: `probeModels` still returns fastest available model (return value preserved)
- [x] 2.5 Existing `model-chain.test.ts` probe tests pass (adjust if they asserted reorder)

#### Manual

- [ ] 2.6 PR review: chain order in Action log matches `buildCombinedChain` SWE-bench order (no leapfrog)
- [ ] 2.7 Model fast at probe but slow at reviews no longer appears first
- [ ] 2.8 Failure-fallback works: head model failure → next SWE-bench model tried
- [ ] 2.9 No regressions in review quality or latency

### Phase 3: GitHub/Config Cleanup

#### Automated

- [x] 3.1 `npm run build` succeeds
- [x] 3.2 `npm test` passes — all existing tests green
- [x] 3.3 New test: `github-review` read with non-JSON 200 body throws `RetryableError` 502 (not `SyntaxError`)
- [x] 3.4 New test: `fetchLeaderboard`/`fetchSweBenchScores` with non-JSON 200 body throws `RetryableError` 502 (not `SyntaxError`)
- [x] 3.5 New test: `createComment` on 404 logs warning and does not throw
- [x] 3.6 New test: `loadEvent` with payload lacking `pull_request` throws event-type error
- [x] 3.7 New test: `loadEvent` with `pull_request` but missing `number` still throws field error

#### Manual

- [ ] 3.8 Action on non-PR event shows event-type error (not "No PR number")
- [ ] 3.9 Review when GitHub returns maintenance page: retries (502) or fails with clear message, not raw `SyntaxError`
- [ ] 3.10 No regressions in normal review posting
