# False-Negative Model Ejection Fix — Plan Brief

> Full plan: `context/changes/bench-ejects-best-models/plan.md`
> Frame brief: `context/changes/bench-ejects-best-models/frame.md`

## What & Why

The daily benchmark permanently ejects slow-but-healthy high-SWE NIM models (e.g. `minimax-m3` 0.805, HTTP 200 in 47.8s) from `action.yml` into `removed-models.txt`. The root cause: the all-failed gate (`bench-entry.ts:333`) and alive filter (`bench-reorder.ts:251`) conflate "slow but responsive" with "unavailable." With the best NIM models gone, `mistral-medium-3.5` (0.776) becomes the legitimate SWE head of the merged chain and always gets used. The fix uses the existing probe (30s, maxTokens=8) as the availability signal: catalog-listed + probe-pass = demote-but-keep; not-in-catalog or probe-fail = eject.

## Starting Point

`action.yml:16` currently lists 11 NIM models starting with `stepfun-ai/step-3.7-flash` — `deepseek-v4-pro` (0.806), `minimax-m3` (0.805), and `glm-5.2` (0.778) were ejected by commit `e8f50b4` into `removed-models.txt`. The probe at `model-chain.ts:141` is already log-only with a 0.02 head-gap cap (`probe-cap-and-stale-refs` fixed the speed-leapfrog bug). The runtime chain correctly tries models by SWE score — the problem is purely in the benchmark's ejection decision.

## Desired End State

1. A NIM model that responds to the probe but is slow is **demoted-but-kept** in `action.yml`, ranked by its effective score (SWE × latency penalty) rather than ejected.
2. Catalog-listed models are re-admitted each run via a catalog-driven probe pass — no file persistence. `removed-models.txt` is eliminated for NIM.
3. `README.md` correctly describes the probe as log-only (no reordering) and explains the auto-ranked chain rather than hardcoding a stale model list.
4. `shape-notes.md:15` ("effective score = SWE × latency penalty") is no longer stale — the penalty is implemented in `rankModels`.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
|---|---|---|---|
| Availability signal | probeModel + catalog presence | The 30s/maxTokens=8 probe already distinguishes available from unavailable; reusing it avoids a new signal | Plan |
| Demotion mechanism | Latency penalty in rankModels | `getEffectiveScore` already computes SWE × latency penalty; wiring it into ranking implements shape-notes:15 and naturally demotes slow models | Plan |
| Alive filter | Relax to `tokensPerSec > 0` | Equivalent to `errors < iterations` when at least one iteration ran; keeps partial-success models in ranking | Plan |
| Re-admission criterion | Probe-only | Matches the runtime probe behavior; breaks the stuck loop where slow models fail full benchmarks but pass probes | Plan |
| removed-models.txt | Eliminate for NIM | Catalog-driven re-admission each run replaces file-based persistence; OR/Kilo jobs keep their separate files | Plan |

## Scope

**In scope:** `rankModels` latency penalty + relaxed alive filter, `bench-entry.ts` three-way failure classification + catalog-driven re-admission pass, `benchmark.yml` NIM job env change, `removed-models.txt` deletion, README.md:274 and README.md:256-262 doc fixes, shape-notes.md alignment.

**Out of scope:** Runtime probe behavior (`probeModels`, `prioritizeChain` — already log-only), probe speed-cap (`probe-cap-and-stale-refs` — already done), probe latency tax (`review-speed` — separate), OR/Kilo removed-models files, table format changes, dashboard/stats tracking.

## Architecture / Approach

Two code changes, applied to the benchmark pipeline only:

1. **Ranking fix** (`bench-reorder.ts`): `rankModels` and `rankModelsTwoTier` — relax alive filter to `tokensPerSec > 0` and sort by `getEffectiveScore` (SWE × latency penalty) instead of SWE-only. `getEffectiveScore` already exists at `bench-reorder.ts:228`.

2. **Ejection gate fix** (`bench-entry.ts`): Three-way classification using probe + catalog — probe-pass + catalog = demote-but-keep (include in table); probe-fail + catalog = transient (re-probe next run); probe-fail + not-in-catalog = permanent skip. Add `readmitCatalogModels` that probes all NIM SWE_BENCH_SCORES models not in `action.yml` each run. Eliminate NIM's `removed-models.txt` — re-admission is catalog-driven.

## Phases at a Glance

| Phase | What it delivers | Key risk |
|-------|-----------------|----------|
| 1. Ranking Fix | rankModels latency penalty + relaxed alive filter | Ranking change affects all providers (intended) |
| 2. Ejection Gate Fix | Probe-based classification + catalog-driven re-admission, remove removed-models.txt | Slow probe pass could re-admit a flaky model |
| 3. Doc Fixes | README probe + chain listing corrections | README may still go stale between daily runs |
| 4. E2E Verification | Full test suite + manual trace | Cannot test live NIM API without key |

**Prerequisites:** NIM_API_KEY for live testing; otherwise run with mocked probe/benchmark.
**Estimated effort:** ~3-4 focused sessions across 4 phases.

## Open Risks & Assumptions

- **Re-admission false positives** (MEDIUM): A model that passes the probe (maxTokens=8) but is unreliable for full reviews could be re-admitted. Mitigated by the latency penalty in ranking — slow models rank low, so they're only tried as last-resort fallbacks.
- **Probe time overhead** (LOW): `readmitCatalogModels` adds up to `BENCH_READMIT_LIMIT` (default 5) × 30s = 150s of probe time to the NIM benchmark. Acceptable given ~5-8min baseline.
- **OR/Kilo parity** (LOW): The alive filter + latency penalty changes apply to `rankModelsTwoTier` too. This is intentional but increases blast radius — should be covered by existing tests.

## Success Criteria (Summary)

- A slow-but-healthy NIM model (probe passes, benchmark times out) stays in `action.yml` at a low rank, not ejected
- `removed-models.txt` is not created or referenced by the NIM benchmark job
- Full test suite passes with new tests for relaxed alive filter and latency penalty sorting
- README "Model Probing" section no longer claims the probe reorders the chain