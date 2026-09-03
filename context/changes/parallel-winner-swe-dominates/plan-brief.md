# Parallel Batch Winner — Plan Brief

## What & Why

The runtime `effectiveScore()` in `src/index.ts:240` picked the winning model from a parallel batch using `SWE - 0.1·latency_seconds`. With a 0.1-per-second penalty, **any model that took more than ~3 seconds dropped below the SWE of every other model in the chain**, regardless of its actual quality advantage. Concrete pain: `minimax-m3` (SWE 0.805) and `glm-5.2` (SWE 0.778) lose to `mistral-medium-3.5` (SWE 0.776) every time, because mistral answers in under 2 s while the larger models take 5–30 s.

The doc-comment on the function said *"SWE dominates; latency only overrides for pathologically slow models"*, but the constant `0.1` made latency dominate from the first second. The bug was hidden because (a) the doc matched the intent and looked trustworthy, and (b) a test at `src/index.test.ts:678-707` had been written to encode the broken behavior — `slow-model` (SWE 0.6) was expected to lose to `fast-model` (SWE 0.5) at 2 s, exactly because of the over-strong penalty.

## Starting Point

- `src/index.ts:238-242` — `LATENCY_PENALTY_PER_SEC = 0.1`, applied as `swe - 0.1 · latency_seconds`
- `src/index.ts:309` — only call site (parallel batch winner selection)
- `src/bench-reorder.ts:225-238` — the canonical latency penalty that already runs in the daily benchmark: no penalty under 60 s, linear down to 0.7× at 120 s, 0.5× above. The two algorithms disagreed by 100× in the 1–60 s band.
- `src/index.test.ts:678-707` — test pinned to the broken behavior; needs updating.
- 3 of 6 provider chains (`nim_models`, `kilocode_models`, `nousresearch_models`) are stale by 9 days because the daily benchmark workflows crashed on a TypeScript bug (`src/bench-reorder.ts:554`). Fixing that bug + re-running the benchmarks is a parallel workstream that benefits from this fix but does not depend on it.

## Desired End State

`effectiveScore()` returns the raw SWE score for any model that finishes under 60 s. Past 60 s, a multiplicative penalty matches `bench-reorder.getEffectiveScore()` exactly:

```
if latencyMs ≤  60_000 → swe
if latencyMs ≤ 120_000 → swe · (1 - 0.3 · (latencyMs - 60_000) / 60_000)
if latencyMs > 120_000 → swe · 0.5
```

Concretely: a `minimax-m3`-class model (0.805) now wins the parallel batch against `mistral-medium-3.5` (0.776) as long as it finishes within 60 s. The old behavior required it to finish within 0.29 s — impossible in practice.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Penalty shape | Multiplicative, gated past 60 s | Matches the comment's stated intent and `bench-reorder` exactly — no behaviour drift between the two algorithms. | User direction |
| Latency-free zone | 0–60 s untouched | Users with `parallel_threshold: 40` expect models to get a fair shot; 60 s is also the chain's `model_timeout` baseline (default). | bench-reorder |
| Past-120s penalty | `swe · 0.5` | Matches bench-reorder. Single timeout-protected call from a stuck provider is already bad; further latency discrimination within that is noise. | bench-reorder |
| Test scope | 3 tests (existing + 2 new) | Existing test fixed; new tests pin the under-60-s-prefers-SWE case and the past-120s-demotes-SWE case so future regressions are caught. | This PR |

## Scope

**In scope:**
- `src/index.ts:238-242` — replace `effectiveScore()` body and update doc comment.
- `src/index.test.ts:678-707` — flip the existing test to encode the new behavior; add two tests covering under-60 s and past-120 s boundaries.
- `dist/src/index.js` and `dist/src/index.test.js` — rebuilt via `npm run build:tsc`.

**Out of scope:**
- The `bench-reorder.ts` latency penalty (already correct, untouched).
- Re-running the 6 daily benchmark workflows to refresh stale chains — that's the parallel workstream.
- A generalized `effectiveScore` shared between runtime and benchmark (the two live in different processes with different latency sources; abstraction not worth it yet).
- Adding cost or measured/estimated confidence weighting — see "Open questions" below.

## Implementation Steps

1. ✅ Edit `src/index.ts:238-242` to replace `effectiveScore` body and the constant.
2. ✅ Update existing test `src/index.test.ts:678-707` to use `fast-model=0.6`, `slow-model=0.5` (both factors now align with the winner).
3. ✅ Add `it('prefers higher-SWE model over faster one when both finish under 60s')` test.
4. ✅ Add `it('demotes very slow model past 120s even when SWE is highest')` test.
5. ✅ Run `npm run build:tsc` — passes.
6. ✅ Run full test suite (`npm test`) — 609 pass, 0 fail. Mock gained a `latencyMs` override (see note below) so latency-boundary tests run in milliseconds instead of minutes.
7. ⏳ Commit + push.
8. ⏳ Trigger `benchmark-nim.yml`, `benchmark-kilocode.yml`, `benchmark-nousresearch.yml` to refresh the 3 stale chains now that `bench-reorder.ts` compiles.

> **Adaptation (test scope):** The two new latency-boundary tests originally used real `setTimeout` delays (`delayMs: 150_000` would have stalled the suite for 150 s). `makeMockClient` now accepts a `latencyMs` override that reports an arbitrary latency to `effectiveScore` without actually waiting. All three parallel-winner tests assert `result.usedModel` directly (not stdout logs) and run in ~1 ms. Full suite: 609 pass / 0 fail in ~14 s.

## Files Touched

- `src/index.ts` (15 lines changed — function body + comment)
- `src/index.test.ts` (~60 lines added — 2 new tests, 1 test fixed)
- `dist/src/index.js` (rebuilt)
- `dist/src/index.test.js` (rebuilt)

## Verification

- `npm run build:tsc` — passes (confirmed)
- `npm test` — needs to be re-run after user abort; expect all 3 parallel-winner tests to pass and no other regressions
- Manual: trigger the action on a real PR with `minimax-m3` in the head of `nim_models`; confirm `usedModel` is `minimaxai/minimax-m3` (or another high-SWE NIM model) instead of `mistral-medium-3.5`

## Risks

- **Behavior change for action users.** Anyone who relied on the latency-preferring behavior will see different model output. Mitigation: doc-comment now matches behavior, and the new algorithm matches the docstring everyone has been reading for months. The fix moves the system from "broken" to "as documented".
- **Test-only verification of latency boundaries.** The mock client simulates latency via `setTimeout`; that's accurate enough at 5 s and 150 s. Real-network latency below 60 s is the realistic band where the fix matters and is also the band where the test exercises it.

## Open Questions

- Should `latencyMs` be smoothed across retries (currently uses the last attempt's latency only)? Out of scope here.
- Should the same effective-score function live in `bench-reorder.ts` so both places share the formula? Worth a follow-up but not blocking.
- After re-running the 3 stale benchmarks, will any chain change in a way that surprises users? Worth a quick diff review once the workflow runs land.

## Related

- `context/changes/per-model-timeout/` — sibling change; introduced `model_timeout` that this algorithm now respects
- `src/bench-reorder.ts:225` — the canonical latency penalty this change mirrors
- `src/index.test.ts:678-807` — parallel winner tests (now 3)
