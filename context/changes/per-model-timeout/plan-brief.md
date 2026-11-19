# Per-Model Timeout — Plan Brief

> Full plan: `context/changes/per-model-timeout/plan.md`

## What & Why

The review action's model fallback chain gets killed by a 120s aggregate timeout before reaching a model that works — because a single slow model (e.g. deepseek-v4-pro at 180s) eats the entire budget. Adding per-model timeouts (60s each) ensures slow models are skipped quickly, and removing the default aggregate limit ensures the user always gets a review result.

## Starting Point

Today there are two timeout layers: a 180s per-fetch HTTP timeout (too generous) and a 120s aggregate timeout wrapping the entire chain (too aggressive when early models are slow). There's no per-model generation timeout, so a model that's slow-but-responding holds the chain hostage.

## Desired End State

Each model gets 60s to respond. If it doesn't, it's skipped and the next model is tried immediately. The chain runs until a model succeeds or all models are exhausted — no artificial cap by default. Users who want bounded execution can set `chain_timeout`.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Per-model timeout value | 60 seconds | Generous enough for large diffs, aggressive enough to skip stuck models within 2-3 attempts. | Plan |
| Aggregate timeout default | 0 (unlimited) | User must always get a result — "no model completed" is never acceptable when a model would eventually succeed. | Plan |
| Timeout scope | Per individual retry attempt | Each `withRetry` attempt (up to 3) gets its own 60s; a transient failure that retries successfully isn't penalized. | Plan |
| Schema retry budget | Separate 60s timer | A model that responds quickly but with invalid JSON gets a fair correction attempt without doubling the first call's budget. | Plan |

## Scope

**In scope:**
- `signal?: AbortSignal` on `ChatOptions` interface
- `AbortSignal.any()` combining per-model + per-fetch timeouts
- `model_timeout` and `chain_timeout` action inputs
- Config parsing with validation
- Conditional aggregate timeout (0 = unlimited)
- Tests for all new behavior

**Out of scope:**
- Per-provider or per-model timeout configuration
- Changes to the streaming path (`chatStream`)
- Changes to `probeModels()` (already has 10s timeout)
- Changes to `retry.ts` internals

## Architecture / Approach

Inject `AbortSignal.timeout(60_000)` at each `client.chat()` call site in `runModelChainForBatch`. The signal propagates into `OpenAIClient.chat()` where it's combined with the existing 180s fetch timeout via `AbortSignal.any()`. The abort check also short-circuits `withRetry` iterations. For aggregate timeout, `withAggregateTimeout` becomes conditional — only wraps the chain when `chainTimeout > 0`.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Per-model timeout injection | Signal wiring through OpenAIClient + call sites | `AbortSignal.any()` requires Node 20+ (confirmed: action uses node24) |
| 2. Aggregate timeout configuration | New action inputs + conditional aggregate logic | Users on old configs won't see behavior change (0 = unlimited is new default) |
| 3. Tests and verification | Full coverage of timeout paths | Mock server timing sensitivity in CI |

**Prerequisites:** None — pure additive change to existing code.
**Estimated effort:** ~1 session across 3 phases.

## Open Risks & Assumptions

- Assumes all target environments run Node 20+ (confirmed via `action.yml: using: 'node24'`)
- Some models may legitimately need >60s for very large diffs — users can raise `model_timeout`

## Success Criteria (Summary)

- Slow models are skipped within ~60s (visible in Actions logs)
- The chain no longer posts "No review content returned" when a later model would succeed
- Existing behavior preserved when `chain_timeout` is set to a nonzero value
