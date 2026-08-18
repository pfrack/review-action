<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Model Chain Resilience

- **Plan**: context/changes/model-chain-resilience/plan.md
- **Scope**: Phases 1–3 (shipped work; Phase 4 hardening pending)
- **Date**: 2026-08-14
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical · 3 warnings · 6 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | FAIL |
| Scope Discipline | WARNING |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Findings

### F1 — Parallel default is 3, not 1 (violates "NOT Doing" boundary)

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Plan Adherence
- **Location**: src/config.ts:4, src/config.ts:138, action.yml:124-127
- **Detail**: Plan line 67 states "Sequential execution remains the default with `parallel_attempts: 1`", line 197 "defaults to 1", and the "What We're NOT Doing" list (line 42) explicitly includes "Changing the default from sequential fallback to parallel execution". The shipped code sets `PARALLEL_ATTEMPTS_DEFAULT = 3` and `action.yml` `default: '3'`, so with the gate `parallelAttempts > 1 && availableChain.length > 1` (index.ts:256) parallel mode is **on by default** for any chain with ≥2 models. This is the exact behavior the plan said would NOT be done.
- **Fix A ⭐ Recommended**: Change the default back to 1 to honor the plan and the NOT-Doing boundary.
  - Strength: Restores documented behavior; keeps cost/concurrency identical to pre-change releases; one-line constant change.
  - Tradeoff: Loses the (possibly intended) out-of-the-box latency improvement.
  - Confidence: HIGH — the plan is the recorded source of truth and explicitly forbids this default.
  - Blind spot: If the team actually wants parallel-by-default, this reverts desired behavior; confirm intent first.
- **Fix B**: Keep default 3; amend the plan (and remove the "NOT Doing" item) to document parallel-by-default.
  - Strength: Preserves shipped behavior; plan becomes accurate to reality.
  - Tradeoff: Plan becomes a moving target; changes default behavior for all existing users silently.
  - Confidence: MEDIUM — depends on whether parallel-by-default was a deliberate product decision.
  - Blind spot: Existing users expecting sequential default may see higher provider cost/usage.
- **Decision**: FIXED via Fix B — plan amended to document parallel-by-default (default 3) and remove the NOT-Doing item; Key Discoveries + Performance notes updated to reflect no sibling abort.

### F2 — Sibling-cancellation / first-winner contract not implemented

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence
- **Location**: src/index.ts:256-313
- **Detail**: Plan Contract 9 (plan.md:197) and Key Discoveries (line 59) state the winner "aborts siblings after the first validated non-empty result" and "Only a result containing validated findings wins and aborts siblings." Actual code: `controller` is constructed (line 260) but `controller.abort()` is **never called**; all `parallelCount` attempts run to completion via `Promise.all` (line 287); selection is the highest adjusted-SWE among all settled results (lines 296-308, via `LATENCY_PENALTY_PER_SEC`). The "cancelled" log (310-313) lists attempts that *returned null*, not attempts that were aborted. So the documented cancellation behavior does not exist.
- **Fix A ⭐ Recommended**: Amend the plan to document the actual run-all-then-pick-highest-SWE semantics and remove the abort-siblings contract.
  - Strength: Plan matches shipped code; no behavior change; honest documentation.
  - Tradeoff: Loses the (claimed) cost saving of aborting losers.
  - Confidence: HIGH — code is stable and tested; matches the comment at index.ts:279.
  - Blind spot: If cancellation was a desired cost control, this codifies the more expensive path.
- **Fix B**: Implement real cancellation — call `controller.abort()` once a winner is selected, before launching the sequential tail.
  - Strength: Honors the plan's cost-control intent; stops wasted sibling requests.
  - Tradeoff: Requires reworking the Promise.all + per-attempt AbortSignal wiring; more test surface.
  - Confidence: MEDIUM — abort wiring currently has latent issues (see F-obs below) that must be fixed alongside.
  - Blind spot: Providers may already have accepted work before cancellation; savings are best-effort.
- **Decision**: SKIPPED — superseded by F1 Fix B plan amendments, which already documented the run-all-then-pick-highest-SWE semantics and removed the abort-siblings contract.

### F3 — SSRF guard allows http:// and private IP ranges

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/utils.ts:34-67 (called from src/index.ts:417-426; asserted in src/security.test.ts:71-73)
- **Detail**: `validateProviderUrl` blocks cloud-metadata hostnames (169.254.x.x, metadata.google.internal, fe80::/fd00:ec2::254) but does **not** enforce `https` and does **not** block private ranges (10.0.0.0/8, 192.168.x, 172.16-31.x, 127.0.0.1). `security.test.ts:71-73` explicitly asserts these pass through. A `http://` or internal-IP value for any `*_base_url` input is therefore accepted, risking the provider API key (sent as `Bearer`) being transmitted in plaintext or to an internal endpoint. Note: every base URL (custom, openrouter, kilo, nim, mistral, groq) shares this gap — there is no per-URL https/loopback check. Preconditioned on an attacker being able to set workflow inputs (compromised/malicious workflow or `pull_request_target` misuse), not on external PR content.
- **Fix**: Extend `validateProviderUrl` to require `https` and block private/reserved ranges (10/8, 172.16/12, 192.168/16, 127/8, ::1).
  - Strength: Closes the plaintext-key and internal-endpoint exposure uniformly across all providers.
  - Tradeoff: Rejects any legitimate non-https or internal-proxy endpoint config (could break self-hosted/enterprise setups) — may need an escape hatch.
  - Confidence: HIGH — the metadata blocklist already proves the pattern works; tests explicitly encode the current (weak) behavior to update.
  - Blind spot: Enterprise users with internal LLM gateways would need an allowlist/capability flag we haven't designed yet.
- **Decision**: FIXED — src/utils.ts `validateProviderUrl` now requires https for non-loopback hosts and blocks RFC1918 private ranges (10/8, 172.16/12, 192.168/16); loopback (localhost/127.0.0.1) still permitted for local dev/tests, matching the existing policy at index.ts:408-416. security.test.ts updated; build + 589 tests pass.

### F4 — `withAggregateTimeout` leaves operation running; unhandled-rejection risk

- **Severity**: 🔎 OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality (reliability)
- **Location**: src/index.ts:20-35
- **Detail**: `Promise.race` resolves `null` on timeout, but `operation()` (the full model chain for a batch) keeps running with no `AbortSignal`; its promise is no longer awaited. If it later rejects (network/abort), that becomes an **unhandled promise rejection**, which in modern Node can terminate the process — yielding *no* review comment for the PR. Pre-existing (introduced in commit dc95d58, the per-model-timeout change), not by this change, but lives in a file under review.
- **Fix**: Pass an `AbortSignal` into the batch operation and abort it on timeout; also `.catch` the floating promise to prevent process exit.
  - Strength: Stops token waste on dead batches and removes the crash-on-timeout footgun.
  - Tradeoff: Requires threading a signal through `runModelChainForBatch`; small change.
  - Confidence: HIGH — established pattern (AbortSignal.any already used in attemptModel).
  - Blind spot: None significant.
- **Decision**: FIXED — `withAggregateTimeout` now creates an AbortController, aborts the batch operation on timeout, and swallows the slow operation's rejection (no unhandled-rejection crash). The signal is threaded through `runModelChainForBatch` → every `attemptModel` call. Build + 589 tests pass.

### F5 — `isTextModeModel` regex diverges from `NO_STRUCTURED_OUTPUT_MODELS`

- **Severity**: 🔎 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architecture (correctness)
- **Location**: src/index.ts:116 vs src/openai-client.ts:56-61
- **Detail**: The 8192-token headroom floor (for verbose natural-language text-mode responses) is gated on `/\bstep-\d/`, while text-mode selection itself uses the `NO_STRUCTURED_OUTPUT_MODELS` set in openai-client. A model added to `NO_STRUCTURED_OUTPUT_MODELS` that does not match `step-\d` would run text-mode extraction but skip the token floor, risking silent `length` truncation.
- **Fix**: Derive the headroom flag from the same set, e.g. `NO_STRUCTURED_OUTPUT_MODELS.has(tagged.id)`.
  - Strength: Single source of truth for "text-mode model"; removes the latent truncation gap.
  - Tradeoff: None significant.
  - Confidence: HIGH — obvious alignment fix.
  - Blind spot: Need to confirm the set is importable at index.ts without a cycle.
- **Decision**: PENDING

### F6 — `sanitizeErrorBody` writes literal regex pattern into log

- **Severity**: 🔎 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: (logging correctness)
- **Location**: src/openai-client.ts:16
- **Detail**: `body.replace(/api[_-]?key["'\s]*[:=]["'\s]*\S+/gi, 'api[_-]?key: [REDACTED]')` inserts the literal string `api[_-]?key` (the regex pattern) into the output. The secret value *is* redacted, but the resulting log reads `api[_-]?key: [REDACTED]`, which is misleading during incident triage.
- **Fix**: Use a captured/normalized key name (e.g. replace with the matched key prefix or a constant `api_key: [REDACTED]`).
  - Strength: Accurate redaction logs.
  - Tradeoff: None.
  - Confidence: HIGH.
  - Blind spot: None.
- **Decision**: PENDING

### F7 — `chatStream` lacks the resilience features added to `chat`

- **Severity**: 🔎 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/openai-client.ts:369-442
- **Detail**: `chat` gained structured-output fallback, `effectiveFormat`, text-mode `extractJsonFromText`, and `withRetry`/`AbortSignal` handling; `chatStream` (used by bench.ts) has none of these and a simpler error path. Not a regression in this diff, but the resilience investment is uneven across the two code paths.
- **Fix**: Either backport the resilience helpers to `chatStream` or document it as a known limited path.
  - Strength: Uniform provider-failure handling.
  - Tradeoff: bench.ts path may not need full fallback; added complexity.
  - Confidence: MEDIUM — depends on whether bench uses the same providers.
  - Blind spot: Haven't confirmed bench.ts's provider set.
- **Decision**: PENDING

### F8 — Max stagger can exceed timeouts / be slower than sequential

- **Severity**: 🔎 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Performance
- **Location**: src/index.ts:267
- **Detail**: `delayMs = i * config.parallelThreshold * 1000`. With `parallelAttempts=5` and `parallelThreshold=120`, the 5th attempt waits `4*120 = 480s` before starting — far above `modelTimeout` (90s) and often above `chainTimeout`, so late staggered attempts abort immediately, making "staggered parallel" potentially slower than sequential.
- **Fix**: Cap total stagger or document the interaction with timeouts.
  - Strength: Prevents pathological configs.
  - Tradeoff: None for normal ranges.
  - Confidence: HIGH.
  - Blind spot: Edge config only.
- **Decision**: PENDING

### F9 — `custom_models_base_url` not listed among plan's new inputs

- **Severity**: 🔎 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: action.yml:65, src/config.ts:83
- **Detail**: Plan "New public inputs" (plan.md:325) lists only `custom_swe_score`, `max_tokens`, `parallel_attempts`, `parallel_threshold`. `custom_models_base_url` is present in action.yml and config but absent from that list. Likely pre-existing (not introduced by this change); flagged for documentary completeness.
- **Fix**: Add it to the plan's input list (or confirm pre-existing and ignore).
  - Strength: Plan accurately reflects inputs.
  - Tradeoff: None.
  - Confidence: HIGH.
  - Blind spot: Need to confirm it predates this change (likely does).
- **Decision**: PENDING
