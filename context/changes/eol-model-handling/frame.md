# Frame Brief: EOL/Dead Models Wasting Runtime Attempts & Weakening Reviews for @v1 Consumers

> Framing step before /10x-plan. This document captures what is *actually*
> at issue, separated from what was initially assumed.

## Reported Observation

Runtime logs (from an external consumer repo pinned to `pfrack/review-action@v1`)
show the review chain attempting permanently dead models on every PR: NIM 410
Gone end-of-life models (`stepfun-ai/step-3.7-flash`, `nvidia/llama-3.3-nemotron-super-49b-v1(.5)`,
`thinkingmachines/inkling`), Mistral 403 `tier_not_allowed` (`mistral-large-2512`),
Groq 413, and 90s NIM timeouts (`minimaxai/minimax-m3`, `nvidia/nemotron-3-ultra-*`).
The probe stage logs "no model available, using SWE-bench chain order", execution
continues after individual models report "Done", and reviews ultimately post from
weak fallback models.

## Initial Framing (preserved)

- **User's stated cause or approach**: "mechanism for outdated models" — the
  handling of outdated models is inadequate, so dead models keep being tried.
- **User's proposed direction**: None stated — research-first (correct; the
  mechanism *exists* upstream and is decoupled from the runtime).
- **Pre-dispatch narrowing**: Main pain = **wasted attempts each run** (not total
  review failure). Audience = **external @v1 consumers**. Observed end result =
  **review posted but from a weak model**.

## Dimension Map

The observation could originate at any of these dimensions:

1. **D1 — Delivery channel to pinned refs** — dead models reach `@v1` because the
   push channel (daily bench → `action.yml` defaults → ref/tag movement) is broken:
   tag frozen at a non-benchmark commit, `dist/bundle/` never rebuilt by the
   pipeline (4+ days stale), groq bench silently dead 18 days.
2. **D2 — Runtime dead-model avoidance** — the runtime detects deadness (probe,
   410/403 responses) and discards it: probe result is log-only, errors swallowed,
   no cross-run memory; per-consumer deadness (tier 403s) invisible to any push
   mechanism. ← initial framing ("mechanism inadequate") lands here-ish
3. **D3 — Per-run cost structure** — the *dominant* waste is not the 410s (one
   cheap round trip each) but the whole-chain probe (10s × ⌈N/3⌉ ≈ 90s for a
   25-model chain, paid even on healthy chains), 90s hung-model timeouts, and the
   40s parallel stagger.
4. **D4 — Bench detection correctness** — the bench misclassifies or misses dead
   models: dead IDs hardcoded in `benchmark-mistral/groq.yml` `BENCH_MODELS`,
   untrusted `/models` catalog, insert-only score table, all-fail → "Skipping
   reorder" exits green.
5. **D5 — Fallback-tail quality semantics** — "any review > no review" is a
   deliberate design; when strong heads die/hang, the chain slides to weak
   free-tier models by design; the stale bundle's speed-dominant winner selection
   (`LATENCY_PENALTY_PER_SEC = 0.1` subtractive — a 40s response costs 4.0 points)
   compounds this for `@v1`.

## Hypothesis Investigation

| Hypothesis | Evidence | Verdict |
| --- | --- | --- |
| D1: Delivery channel broken for pinned refs | `v1` → `8c45dc9` (non-"benchmark" subject; guard at `benchmark-template.yml:163-174` refuses all future moves); bundle last built `ddb9568` 2026-09-02 (pipeline runs `build:tsc` only, never commits `dist/`); groq defaults untouched since `a80e639` 2026-08-19; EOL Mistral fallback verbatim in delivered bundle (`dist/bundle/index.js`) | STRONG |
| D2: Runtime discards its own deadness signal | `prioritizeChain` log-only (`src/index.ts:485-496`, test-locked); `probeModel` swallows errors incl. status (`src/openai-client.ts:453-455`); no runtime import of removed-models/model-history (0 refs in bundle); `mistral-large-2512` 403 is consumer-tier-specific — unfixable by any push mechanism | STRONG |
| D3: Waste dominated by timeouts/probe, not 410s | `withRetry` fails fast on 4xx (`src/retry.ts:29`) — each 410 = 1 round trip; `model_timeout` 90s burns on hung heads (`src/config.ts:117-125`); whole-chain probe at 10s/batch-of-3 (`src/model-chain.ts:146-182`) | STRONG |
| D4: Bench misses/misclassifies dead models | `benchmark-mistral.yml:23` still hardcodes 403'd `mistral-large-2512`; `patchScoresTable` insert-only (`src/bench-reorder.ts:546-598`); all-fail skip exits 0 (`src/bench-reorder.ts:479-482`); catalog lists EOL models that 410 on chat | STRONG (upstream of D1) |
| D5: Weak-tail outcome by design + amplified by stale bundle | Free-tier forced last (`src/model-chain.ts:114-117`); fallthrough continues to full chain (unlimited `chain_timeout`); delivered bundle predates PR #32's SWE-dominant winner fix (verified: old `LATENCY_PENALTY_PER_SEC` subtraction in `dist/bundle/index.js`) | STRONG (contributing, not root) |
| Initial framing: "mechanism for outdated models is missing" | Mechanism *exists* (bench → classify → reorder → commit) and worked as recently as 2026-09-03/04 (`e872600`, `c3353b0` ejected the observed EOL models) | PARTIAL — right direction, wrong locus |

## Narrowing Signals

- User's main pain = wasted attempts per run → rules D5-only framings out as the
  leading concern; makes D3's cost decomposition load-bearing.
- Audience = external `@v1` consumers → D1 becomes structural: the tag freeze means
  *no future bench ejection ever reaches them*, so pipeline fixes alone are
  insufficient regardless of quality.
- End result = "posted but weak model" → the system does not fail loudly; it
  degrades silently through the tail. Confirms tolerance-by-design (D5) as the
  outcome mechanism, with D1/D2/D3 as triggers.
- Bundle diff check (this session): delivered `@v1` code runs pre-#32 winner
  selection where a 40s response subtracts 4.0 SWE points — speed dominated
  strength in the parallel window. Active quality gap for pinned consumers, not
  just latent.

## Cross-System Convention

The repo's own history shows the convention *drifting toward avoidance*: the probe
originally promoted the fastest model (avoidance), then was capped (0.02) and
reduced to log-only; `parallel-winner-swe-dominates` (PR #32) re-introduced
SWE-dominance in the winner selection. Meanwhile three prior incidents recorded in
`context/` show the push channel failing silently: `bench-ejects-best-models`
(false ejections + no re-admission), `parallel-winner-swe-dominates` (9-day stale
chains from a TS crash), and now the tag freeze + groq stall. The system's early
"tolerate, don't avoid" decision (`mistral-support`: "fail silently, fall through")
predates the current ecosystem reality of weekly EOL rotations.

## Reframed (or Confirmed) Problem Statement

> **The actual problem to plan around is**: no layer of the system retains or acts
> on model-deadness knowledge at the point of use — the push side (bench →
> `action.yml` → tag) delivers through a single channel that is silently broken
> for pinned `@v1` consumers, and the pull side (runtime probe + 4xx responses)
> observes deadness first-hand every run and throws it away, so every PR pays a
> fixed probe/timeout tax and degrades to weak fallback models when strong heads
> are dead.

The initial framing ("mechanism for outdated models") was right in direction but
wrong in locus: the mechanism exists upstream; the gap is the *unclosed loop*
between it and the pinned-ref runtime, compounded by the fact that the visible
symptom (410 spam) is the cheapest waste component while the expensive ones
(90s timeouts, whole-chain probe, weak-winner outcomes) are cost-structure and
delivery issues. If addressed, per-run waste drops (probe result used, dead heads
skipped), weak-model outcomes drop (strong models reached before timeout budgets
burn), and the system stops depending on a channel that has failed three times.

## Confidence

- **HIGH** — code- and git-verified evidence on every dimension, three prior
  incidents of the same failure class, decisive narrowing signals, and a fresh
  bundle-diff check confirming the active `@v1` quality gap.

## What Changes for /10x-plan

The plan should be about **closing the deadness loop at the point of use** —
deciding the split between pull (runtime: act on probe/4xx signal instead of
discarding it) and push (pipeline: make delivery to pinned refs survive tag/bundle
breakage and stop exiting green when dead) — not about building a new
outdated-model mechanism from scratch. The D3 cost decomposition (probe tax,
timeout budget) and D5 semantics (is the weak tail acceptable?) are the open
trade-offs the plan must settle.

## Verification Round (2026-09-06, post-brief)

Every load-bearing claim was independently verified; nothing refuted:

| Claim | Method | Result |
| --- | --- | --- |
| Tag frozen; guard refuses future moves | Direct read of `benchmark-template.yml:136-176` + `git log -1 v1` | CONFIRMED — guard requires "benchmark" in tag-target subject; `v1` → "Merge pull request #32...". **New nuance**: tag-move sits inside the `else` of `git diff --cached --quiet` (line 136) — even a healthy bench run with an unchanged order never moves the tag |
| `@v1` runs stale pre-#32 winner logic | `git show v1:dist/bundle/index.js \| grep LATENCY_PENALTY_PER_SEC` | CONFIRMED — old subtractive penalty present (2 matches); `@v1` = clean 09-06 defaults + old bundle (worst combo: fresh list, stale brain) |
| EOL Mistral fallback in delivered bundle | grep of `dist/bundle/index.js` | CONFIRMED — `mistral-medium-3.5,mistral-large-2512,mistral-small-2603,codestral-2508'` verbatim |
| Groq bench dead since 08-19 | `git log` on action.yml groq commits | CONFIRMED — last groq order commit `a80e639` 2026-08-19 (18 days); `removed-groq-models.txt` has zero commits — never existed |
| "Posted but weak model" | `gh api repos/pfrack/archconf/issues/39/comments` | **CONFIRMED with hard evidence**: the only review comment (2026-09-06T19:46:34Z, ~90 min before the new `v1` tag was created) is labeled `<sub>Model: free</sub>` — the winner was a free-tier router alias (`openrouter/free` or `kilo-auto/free`), i.e. the chain's junk tail. The run executed at the old `v1` ref with the old EOL-laden defaults (matches log 1's chain head `stepfun-ai/step-3.7-flash`) |
| Retry/probe/chain behavior claims | `npm test` | CONFIRMED — 610 tests, 135 suites, 0 failures |

The PR #39 evidence closes the loop end-to-end: old-ref defaults (EOL models) →
entire strong tier 410/403/413/timeout → free-tier alias wins → review posted by
"free". Observation, mechanism, and outcome are now all hard-verified.

## References

- Source files: `src/index.ts:485-496` (log-only probe), `src/model-chain.ts:146-211`
  (probe mechanics), `src/retry.ts:29` (4xx fail-fast), `src/config.ts:69-73`
  (EOL fallbacks), `src/bench-reorder.ts:479-482,546-598` (skip-on-dead, insert-only),
  `.github/workflows/benchmark-template.yml:163-174` (tag guard), `dist/bundle/index.js`
  (delivered artifact: EOL fallback + pre-#32 winner logic)
- Related research: `context/changes/eol-model-handling/research.md`
- Historical: `context/archive/2026-08-06-bench-ejects-best-models/`,
  `context/archive/2025-07-21-model-recheck/`,
  `context/changes/parallel-winner-swe-dominates/`
