# Pipeline Hardening — Plan Brief

> Full plan: `context/changes/parallel-review-hardening/plan.md`
> Research: `context/changes/parallel-review-findings/research.md`

## What & Why

The parallel code review uncovered dead retry logic (HTTP 5xx/429 retried zero times in benchmark callers), a probe that reorders the chain by 8-token "Say hi" latency (zero correlation with real review latency), batch-loop fragility (one batch failure kills the whole review), undefined response fields that crash downstream, and GitHub-integration gaps (HTML error bodies crash `.json()`, missing 404 handling, misleading errors on non-PR events).

This is **Change 2 of 3** from the parallel-review-findings umbrella. Change 1 (security) shipped; Change 3 (testing) is separate. This change covers reliability, execution safety, probe redesign, and GitHub/config cleanup.

## Starting Point

The codebase already has solid retry infrastructure (`withRetry` with exponential backoff, `RetryableError` for status-based retry) — but two benchmark callers throw plain `Error`, bypassing it. The probe-based reorder exists with a SWE-bench-gap cap (0.02), but the probe itself measures the wrong thing. Per-model and aggregate timeouts are configurable (sibling changes). The batch loop logs timeout drops but doesn't catch throws. The live review path is well-hardened; the gaps are in benchmark/CLI paths, the probe, execution safety, and GitHub edge cases.

## Desired End State

Benchmark HTTP calls actually retry on transient failures. Backoff includes jitter. `chat()` never returns undefined fields. One batch failure can't kill the review, and parallel-mode aborts are logged. The probe checks availability and records latency but no longer reorders the chain — SWE-bench order is authoritative. GitHub API parse failures and 404s are handled gracefully; non-PR events give an actionable error.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
|----------|--------|-------------------|--------|
| Parallel winner-take-all strategy | Keep, add observability | Parallel candidates are top-N SWE-bench models (small quality gap); speed wins; log the abort so it's debuggable. | Plan |
| Probe redesign | Availability check + latency measurement, no reorder | 8-token latency doesn't predict review latency; SWE-bench order is the quality signal; failure-fallback preserves resilience. | Plan |
| Batch-loss handling | Catch in loop + log dropped files + continue other batches | One batch failure shouldn't kill the review; other batches may still have valid findings. | Plan |
| Retry fix scope | Fix error type + add jitter (no new config) | Minimal surface; the bug is the error type, not the retry params; jitter prevents lockstep. | Plan |
| Response-field robustness | Defensive defaults + safe truncation detection | Prevent downstream crashes; fail safe on undefined finishReason (don't false-positive truncation). | Plan |
| GitHub cleanup scope | High-impact only (json parse, 404, event validation) | Skip low-impact marker/login checks; focus on crash-causing gaps. | Plan |

## Scope

**In scope:**
- Fix dead-retry error type in `swe-resolver.ts`, `bench-reorder.ts` — `retry.ts`
- Add jitter to `getRetryDelay` — `retry.ts`
- Guard undefined `usage`/`finishReason` in `chat()` — `openai-client.ts`
- Wrap batch loop in try/catch + dropped-batch logging — `index.ts`
- Add winner-take-all abort observability log — `index.ts`
- Remove probe-based chain reorder — `index.ts`, `model-chain.ts`
- Guard `.json()` parse in GitHub read call sites — `github-review.ts`, `bench-reorder.ts`, `swe-resolver.ts`
- Add 404 handling to `createComment` — `github-review.ts`
- Add event-type validation in `loadEvent` — `event.ts`

**Out of scope:**
- Winner-take-all → "collect all + compare quality" redesign (deferred)
- New retry config inputs (`max_retries`, `base_delay`)
- Capping concurrent probes / probe retry
- Switching to Octokit / `@actions/github`
- `AI_REVIEW_MARKER` `user.login` check
- `chatStream` cleanup, hardcoded model allowlists
- Testing debt (Change 3: `parallel-review-testing`)
- Security findings (Change 1: `parallel-review-security`, implemented)

## Architecture / Approach

Three phases by risk. **Phase 1** (robustness & execution safety): bundle the defensive bug fixes — retry error type, jitter, response-field guards, batch-loop try/catch, abort observability. No change to default review output. **Phase 2** (probe redesign): convert the probe from reorder-mechanism to availability check; SWE-bench order becomes authoritative; isolated for careful verification. **Phase 3** (GitHub/config cleanup): independent, lowest risk. Every fix ships with a test proving the failure mode is closed.

## Phases at a Glance

| Phase | What it delivers | Key risk |
|-------|-----------------|----------|
| 1. Robustness & Execution Safety | Dead retry fixed; jitter; response guards; batch-loop catch; abort logging | Jitter changes retry timing — existing `getRetryDelay` tests need updating to ranges |
| 2. Probe Redesign | Probe no longer reorders chain; SWE-bench order authoritative | Behavior change — users may see different chain order in logs (SWE-bench, not probe-latency) |
| 3. GitHub/Config Cleanup | `.json()` guard; `createComment` 404; event-type validation | `.json()` guard applies to multiple call sites — must not change success-path behavior |

**Prerequisites:** None — Change 1 (security) is implemented; this change is independent of it.
**Estimated effort:** ~2-3 sessions across 3 phases (~10 source-file changes + ~15 test additions)

## Open Risks & Assumptions

- Removing probe reorder changes which model is tried first — users who relied on the probe promoting a specific (faster) model will see SWE-bench order instead. This is the intended fix (quality over probe-latency) but should be in release notes.
- The `PROBE_PROMOTE_MAX_HEAD_GAP` cap logic in `probeModels` becomes dead for ordering but stays as a guard on the return value — harmless, but a future cleanup could remove it.
- Jitter makes retry delays non-deterministic — tests asserting exact delay values must switch to range assertions.
- The `.json()` guard wraps multiple call sites; if any existing test relies on a `SyntaxError` propagating from `.json()`, it will need updating.

## Success Criteria (Summary)

- Benchmark workflow recovers from a transient leaderboard 5xx (retry then success in logs)
- A multi-batch PR with one failing batch still posts findings from the other batches
- Parallel-mode Action logs show which model won and which were cancelled
- The chain order in Action logs matches SWE-bench order (no probe-driven leapfrog)
- A non-PR event produces an event-type error, not "No PR number"
- A GitHub maintenance page results in a retry or clear error, not a raw `SyntaxError`
