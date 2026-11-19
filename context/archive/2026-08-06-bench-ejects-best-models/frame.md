# Frame Brief: Why only mistral-medium-3.5 reviews (it's not speed)

> Framing step before /10x-plan. The user's "favors faster models" belief recalls
> an already-fixed bug; the residual symptom has a different root cause.

## Reported Observation

"Only `mistral-medium-3.5` ends up doing PR reviews lately" (observed in
`pfrack/freedius` review runs), where `mistral-medium-3.5` is the Mistral
provider model (SWE 0.776) on the `mistral_models` chain (`action.yml:25`),
rather than the higher-SWE NIM models (e.g. `deepseek-v4-pro` SWE 0.806 that
the README documents as the default head `README.md:258`).

## Initial Framing (preserved)

- **User's stated cause or approach**: "the current [benchmark] run favors faster
  models that maybe are not the best" (term "pallaer" = the daily
  benchmark/reorder system; interpreted, not verified).
- **User's proposed direction**: "we need a clever solution for it."
- **Pre-dispatch narrowing**: user wants a model that is "good and fast enough,"
  not a specific model; not sure of the mechanism ("how stupid that sound").

## Dimension Map

The observation could originate at any of these dimensions:

1. **Daily-bench dead-model drop** (`bench-reorder.ts:251` filter
   `tokensPerSec > 0 && errors === 0` + `bench-entry.ts:333/394-406`) —
   high-SWE NIM models **dropped** from `action.yml` if they fail all benchmark
   iterations, regardless of SWE score. ← the actually-true dimension
2. **Runtime probe promotion** (`model-chain.ts:141-202` + `index.ts:433`) —
   the only place raw speed moves a model to the head. ← user's "faster models"
   theory, maps here
3. **Merged-chain SWE legitimacy** (`model-chain.ts:100-104 buildCombinedChain`)
   — when NIM+Mistral keys are both set (freedius sets all), provider models
   merge and sort by SWE desc; the highest-SWE provider model legitimately heads
   the chain.
4. **Catalog/SWE-table drift** (`bench-entry.ts:207` live catalog vs `removed-models.txt`)
   — dropped models still listed in the NIM catalog (false-negative ejection).
5. **(Prior, resolved) probe was once speed-leapfroggable** — already fixed
   (`probe-cap-and-stale-refs`); the probe is now log-only. NOT the current cause.

The user's framing lands on Dimension 2 (and echoes Dimension 5). The
evidence points to Dimension 1+3+4 instead.

## Hypothesis Investigation

| Hypothesis | Evidence | Verdict |
| --- | --- | --- |
| **Dim 2 — probe promotes faster models over SWE head** | `prioritizeChain` (`index.ts:433-444`) returns `void`; it only `core.info` logs — it never splices/reorders `chain`. `index.test.ts:509-526` locks "does not change chain order regardless of probe results." Internally `probeModels` (`model-chain.ts:197`) returns `null` if fastest-probed SWE < head − 0.02 (`PROBE_PROMOTE_MAX_HEAD_GAP`). | **RULED OUT** — speed does not drive routing today. |
| **Dim 1 — daily bench drops high-SWE NIM models on failure** | Git: commit `e8f50b4` "update nim model order from daily benchmark" removed `deepseek-v4-pro`(0.806), `minimax-m3`(0.805), `deepseek-v4-flash`(0.790), `z-ai/glm-5.2`(0.778) from `action.yml:16`. `removed-models.txt` lists exactly these. `rankModels` (`bench-reorder.ts:251`) keeps only `tokensPerSec>0 && errors===0`; `bench-entry.ts:333` sets `allFailed = errCount===iterations`; `SWE_BENCH_SCORES` lookup happens AFTER the filter (`bench-reorder.ts:253-256`). | **STRONG** |
| **Dim 3 — mistral legitimately heads the merged chain** | `SWE_BENCH_SCORES`: `mistral-medium-3.5`=0.776 (`bench-reorder.ts:177`) is the highest SWE among all non-`:free` provider models currently in `action.yml` (next is `stepfun-ai/step-3.7-flash`=0.744, then several at 0.720). `buildCombinedChain` sorts strictly SWE-desc (`model-chain.ts:100-104`); freedius sets NIM+Mistral+Groq+OR+Kilo keys → single merged chain. | **STRONG** |
| **Dim 4 — dropped models still available on NIM (false-negative)** | Public NIM catalog `GET /v1/models` still lists `deepseek-ai/deepseek-v4-pro`, `minimaxai/minimax-m3`, `z-ai/glm-5.2`. So they were ejected while still published. `bench-entry.ts:207-209` fetches the catalog; `bench-entry.ts:398-406` classifies a failed model as permanent only if `!availableModels.has(model)` — but the recheck path (`bench-entry.ts:408-473`) still fails them. | **STRONG** (mechanism) / **MEDIUM** (exact per-model failure cause) |

## Narrowing Signals

- **Probe is log-only and cap-gated** (agent + `index.test.ts:509`): the user's
  "faster models favored" mechanism cannot be the current cause. Ruling IN Dim 2
  would require the probe to reorder the chain — it doesn't.
- **Ejected models are catalog-listed** (NIM `/v1/models`): ruling `dim 4` as
  false-negative ejection, not correct unavailability.
- **README is stale** (`README.md:274`: "fastest probed model is moved to the
  front of the chain") — this documented behavior no longer exists; it is the
  likely source of the user's "favor faster models" belief. `shape-notes.md:15`
  ("effective score = SWE × latency penalty") is also stale vs `rankModels`
  (`bench-reorder.ts:246`, SWE-only, latency is a tiebreaker only).
- **Prior art** `probe-cap-and-stale-refs/change.md:22-26` describes the *exact*
  `deepseek-v4-pro`(0.806)-vs-`mistral-medium-3.5`(0.776) speed-leapfrog — the
  bug the user is recalling is already fixed.

## Cross-System Convention

This repo already treats "quality signal must gate latency/availability" as a
hard rule: `probe-cap-and-stale-refs` added the 0.02 SWE head-gap to stop a
faster probe from leapfrogging a higher-SWE head. The bench's ejection gate
(`bench-entry.ts:333` allFailed → permanent) lacks an analogous softness: a
model that fails every synthetic iteration in one run is dropped wholesale, and
recovery (`bench-entry.ts:408-473`) only re-adds it if a later run's probe+benches
pass — so a catalog-listed, high-SWE model can sit ejected across many runs.
Convention here = degrade-then-recover, not drop-and-hope-it-comes-back.

## Reframed (or Confirmed) Problem Statement

> **The actual problem to plan around is**: `mistral-medium-3.5` always does the
> review not because the system favors faster models, but because the daily
> benchmark ejected the genuinely-best NIM models (`deepseek-v4-pro` 0.806,
> `minimax-m3` 0.805, `z-ai/glm-5.2` 0.778 — all still published on NIM) from
> `action.yml` into `removed-models.txt`; with them gone, `mistral-medium-3.5`
> (0.776) is the legitimate SWE head of the merged chain and succeeds, so it is
> always used.

The user's "favor faster models" theory recalls a real, **already-fixed** bug
(`probe-cap-and-stale-refs`: probe is now log-only + 0.02 head-gap). The residual
symptom is instead a **false-negative model ejection** in the benchmark: a
catalog-listed, high-SWE model is permanently removed from the fallback chain
for a single all-failed benchmark run, so the next-highest-SWE model
(`mistral-medium-3.5`) becomes the de-facto head. Addressing the symptom by
constraining probe latency (the old theory) would not change anything.

## Confidence

- **HIGH** — speed is definitively not the current driver (probe log-only +
  test-locked + cap-gated); and the best NIM models are definitively absent from
  `action.yml` and present in `removed-models.txt` while still catalog-listed.
- **RESOLVED by verification** (see runbook) — the ejection fork is settled:
  `minimax-ai/minimax-m3` (0.805) is healthy (HTTP 200, 47.8s) yet was ejected →
  **confirmed false-negative**; `deepseek-v4-pro` / `z-ai/glm-5.2` hang past 120s
  → effectively unavailable (but never re-admitted despite being catalog-listed).

## What Changes for /10x-plan

The plan must **(A)** fix the false-negative ejection: make the bench's failure
gate (`bench-entry.ts:333` all-failed + `bench-reorder.ts:251` alive-filter)
distinguish slow-but-healthy (demote-but-keep, e.g. `minimax-m3`) from genuinely
unavailable (eject), and re-admit catalog-listed models on each run instead of
permanently caching ejections in `removed-models.txt`. **(B)** Reconcile the
documentation drift: `README.md:274` claims the probe still promotes the fastest
model to the front (it no longer does), and `shape-notes.md:15`
("effective score = SWE × latency penalty") is stale vs `rankModels` SWE-only
sort (`bench-reorder.ts:246`, latency is a tiebreaker only). The plan must NOT
redo the probe speed-cap (already done in `probe-cap-and-stale-refs`) nor the
probe latency tax (`review-speed`).

## References

- action.yml:16 — NIM chain (no deepseek-v4-pro/minimax-m3/glm-5.2)
- action.yml:25 — mistral chain (`mistral-medium-3.5` head)
- README.md:258-262 — documented default NIM chain (deepseek-v4-pro first)
- README.md:274 — stale "fastest probed model moved to front" (no longer true)
- shape-notes.md:15 — stale "effective score = SWE × latency penalty"
- src/bench-reorder.ts:246-263 — `rankModels` (SWE-desc, latency tiebreaker only)
- src/bench-reorder.ts:251 — `alive` filter drops all-failed models
- src/bench-reorder.ts:228-239 — `getEffectiveScore` (display only, not ranked by)
- src/bench-reorder.ts:137-210 — `SWE_BENCH_SCORES` (mistral-medium-3.5=0.776 L177; deepseek-v4-pro=0.806 L138)
- src/bench-entry.ts:333 — `allFailed = errCount === iterations`
- src/bench-entry.ts:349-392 — failed-model replacement (restricted to live catalog)
- src/bench-entry.ts:394-406 — failure classification (permanent vs transient)
- src/bench-entry.ts:408-473 — recheck path (recovers but only if probe+benches pass)
- src/bench-entry.ts:207-209 — live catalog fetch (`client.listModels`)
- src/model-chain.ts:100-109 — `buildCombinedChain` SWE-desc sort, non-free first
- src/model-chain.ts:12 — `PROBE_PROMOTE_MAX_HEAD_GAP = 0.02` (already-fixed speed cap)
- src/model-chain.ts:141-202 — `probeModels` (log-only consumer, cap-gated)
- src/index.ts:433-444 — `prioritizeChain` (log-only, returns void)
- src/index.ts:676 — unconditional `await prioritizeChain(...)`
- src/index.test.ts:509-526 — locks "does not change chain order regardless of probe results"
- commit e8f50b4 — "chore: update nim model order from daily benchmark" (dropped deepseek/minimax/glm-5.2)
- removed-models.txt — lists the ejected models (confirmed read)
- NIM `GET /v1/models` — deepseek-v4-pro, minimax-m3, z-ai/glm-5.2 still published
- Prior changes: `probe-cap-and-stale-refs` (probe speed-cap, already done), `review-speed` (probe latency, planned, distinct), `daily-benchmark` (parent feature)
- Investigation tasks: ses_0299aa7a (dead-model drop), ses_0299a84c (SWE legitimacy), ses_029987814 (probe — re-run)

## Verification Runbook (done — run against NIM_API_KEY in this env)

`/10x-plan` was gated on this. A minimal chat probe (`max_tokens=4`) against the
three ejected NIM models distinguishes **bug** (healthy-but-ejected → false
negative) from **genuine unavailability** (hangs → ejection defensible).

```bash
for m in deepseek-ai/deepseek-v4-pro minimaxai/minimax-m3 z-ai/glm-5.2; do
  curl -sS --max-time 120 -w '\nHTTP %{http_code} in %{time_total}s\n' \
    -H "Authorization: Bearer $NIM_API_KEY" -H "Content-Type: application/json" \
    https://integrate.api.nvidia.com/v1/chat/completions \
    -d '{"model":"'"$m"'","messages":[{"role":"user","content":"say ok"}],"max_tokens":4,"temperature":0.2}'
done
```

### Results

| Model (SWE) | Probe outcome | Verdict |
| --- | --- | --- |
| `minimax-ai/minimax-m3` (0.805) | **HTTP 200**, valid JSON (`"ok"`), 47.8s | **False-negative ejection** — healthy but slow; killed by `bench-entry.ts:333` all-failed gate |
| `deepseek-ai/deepseek-v4-pro` (0.806) | timeout (120s, 0 bytes) | Effectively unavailable (hangs); ejection defensible, but never re-admitted |
| `z-ai/glm-5.2` (0.778) | timeout (120s, 0 bytes) | Effectively unavailable; ejection defensible, but never re-admitted |

**Root cause locked:** the ejection fork is resolved — `minimax-m3` (a top-2 SWE
model) is functional yet permanently dropped, proving the benchmark's failure
gate ejects slow-but-healthy high-SWE models. `deepseek-v4-pro` / `glm-5.2`
genuinely hang, so they're correctly unusable here, but being catalog-listed
(`GET /v1/models`) they are never recovered into the chain. Change stays
`preparing`; /10x-plan is unblocked on the above fix scope.
