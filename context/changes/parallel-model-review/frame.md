# Frame Brief: Parallel Model Review

> Framing step before /10x-plan. This document captures what is *actually*
> at issue, separated from what was initially assumed.

## Reported Observation

"Models should be asked about review in parallel." No specific failure,
latency number, or symptom was reported — the input is a proposed direction,
not an observation of a broken thing.

## Initial Framing (preserved)

- **User's stated cause or approach**: (none provided — no problem was described; the message is itself the approach)
- **User's proposed direction**: Ask models about the review in parallel.
- **Pre-dispatch narrowing**: User picked "Reviews are too slow / sequential
  latency is the pain (cut wall-clock time)" as the outcome they are after.
  Coverage/completeness and quality-comparison were ruled out.

## Dimension Map

The observation could originate at any of these dimensions:

1. **Staggered speed-race fallback** — first model to return valid findings
   wins, siblings aborted; reduces wall-clock latency. **BUILT, opt-in, off
   by default.**  ← initial framing lands here (literally already satisfied)
2. **Parallel quality comparison** — all models answer, pick best output by a
   quality signal. NOT built; explicitly deferred (requires a quality-scoring
   function that doesn't exist). Ruled out by narrowing.
3. **Union of all models' findings** — combine every model's findings into
   one review. NOT built; current design aborts siblings on first winner.
   Ruled out by narrowing.
4. **Parallel batch processing** — run multiple file-batches concurrently.
   NOT built; `executeReview` runs batches in a sequential `for` loop. Only
   affects >50-file PRs (multi-batch). Separate latency lever from per-model
   parallelism.

## Hypothesis Investigation

| Hypothesis | Evidence | Verdict |
| --- | --- | --- |
| D1: staggered parallel fallback is already built but off/undocumented | `action.yml:124-131` (inputs `parallel_attempts`/`parallel_threshold`); `src/index.ts:234-353` (full parallel branch: staggered starts, AbortController, winner-take-all, sequential tail); `src/config.ts:134-148` (parsing + validation); `src/index.test.ts:414` (`describe('runModelChainForBatch parallel fallback')`); `model-chain-resilience/plan.md:42,67` ("NOT changing the default from sequential to parallel"; "Sequential execution remains the default with parallel_attempts: 1"); `README.md:250-295` (no mention of parallel inputs) | STRONG |
| D2: parallel quality comparison is the gap | `parallel-review-findings/research.md:36,220` flags winner-take-all as HIGH-severity "design flaw"; `parallel-review-hardening/plan-brief.md:45` explicitly defers "Winner-take-all → collect all + compare quality" redesign. Requires nonexistent quality-scoring function. | STRONG (gap exists) — but ruled out by user narrowing |
| D3: union-of-findings is the gap | No aggregation path exists; `index.ts:257` aborts siblings on first winner. Not built. | NONE investigated (ruled out) |
| D4: parallel batch processing is the gap | `src/index.ts:458` runs batches sequentially in a `for` loop; `archive/2026-07-24-improvements-research/research.md:452-457` (P4, "Sequential batch processing doubles wall-clock time", fix: concurrency cap 2-3). Only affects multi-batch (>50 file) PRs. | STRONG (gap exists) — secondary, separate lever |
## Narrowing Signals

- User selected "latency is the pain" → routes to D1 (built) and D4 (unbuilt,
  multi-batch only); rules out D2/D3 (quality/coverage).
- User did not report a multi-batch (>50 file) symptom → D4 is a real gap but
  likely not the leading concern for typical PRs.

## Cross-System Convention

The codebase's established pattern is opt-in bounded parallelism with
explicit defaults: `parallel_attempts` defaults to `1` (sequential),
`parallel_threshold` defaults to `40s`, `PROBE_CONCURRENCY = 3` for probing.
Parallelism is always bounded and off-by-default to control provider cost.
The leading hypothesis (D1) matches this convention exactly — it exists and
follows the convention; the gap is documentation/visibility, not a missing
feature.

## Reframed (or Confirmed) Problem Statement

> **The actual problem to plan around is**: the latency-reducing parallel
> model feature you're describing already exists (`parallel_attempts`/
> `parallel_threshold`, off by default) — so the work is *not* "build
> parallel model review"; it is "make an already-shipped, opt-in latency
> feature discoverable and decide whether it should be on by default for
> users who care about speed." Optionally, parallel *batch* processing
> (dimension 4) is a genuinely unbuilt secondary latency lever for large PRs.

The initial framing ("models should be asked in parallel") treated a built
feature as unbuilt. The evidence doesn't support manufacturing a new build;
it supports surfacing what exists. If the user specifically wants
multi-file-batch parallelism (D4), that is a separate, genuinely unbuilt
lever — but it only helps on >50-file PRs and the user did not report that
shape.

## Confidence

- **HIGH** — strong code evidence (inputs, implementation, tests, plan docs
  all confirm D1 is built and deliberately opt-in); matches the codebase
  convention; decisive narrowing signal (latency selected, quality/coverage
  ruled out); inverse check passed (the feature's inputs/code/tests would
  not exist if it were unbuilt).

## What Changes for /10x-plan

If the goal is latency: /10x-plan should be about **documenting and
defaulting** the existing `parallel_attempts` feature (README section +
input-table entry + a decision on whether to flip the default for
speed-preferring users), NOT about building parallel model review from
scratch. If the user actually wants D4 (parallel batches for large PRs),
that is a distinct, genuinely unbuilt change and should be framed separately.

## References

- Source files: `action.yml:124-131`, `src/index.ts:234-353`, `src/config.ts:134-148`, `src/index.test.ts:414+`, `README.md:250-295`
- Related research: `context/changes/parallel-review-findings/research.md` (§1, §2), `context/changes/model-chain-resilience/plan.md` (Phase 3), `context/archive/2026-07-24-improvements-research/research.md` (P1, P4)
- Investigation tasks: none spawned — dimension map was resolved by direct source reads + one narrowing question (Step 1.5). Per guardrail 6, no hypothesis padding.
