---
date: 2026-09-06T23:33:04+02:00
researcher: opencode (glm-5.3)
git_commit: 8c45dc9e3e1c93abbc5a2ea0795046b4e9e2f807
branch: feat/parallel-winner-swe-dominates
repository: pfrack/review-action
topic: "Why are EOL (end-of-life, 410 Gone) models still tried by the runtime model chain, and what does 'Probe: no model available' / post-Done execution mean?"
tags: [research, codebase, model-chain, bench-pipeline, retry, eol-models, providers]
status: complete
last_updated: 2026-09-06
last_updated_by: opencode (glm-5.3)
---

# Research: EOL Model Handling — Dead Models in the Runtime Chain

**Date**: 2026-09-06T23:33:04+02:00
**Researcher**: opencode (glm-5.3)
**Git Commit**: 8c45dc9e3e1c93abbc5a2ea0795046b4e9e2f807
**Branch**: feat/parallel-winner-swe-dominates (== origin/main, PR #32 merge)
**Repository**: pfrack/review-action

> All local `path:line` references are at commit `8c45dc9`. Permalink base:
> `https://github.com/pfrack/review-action/blob/8c45dc9/`

## Research Question

Runtime logs show the action attempting models that are permanently dead before
falling through:

- NIM 410 Gone (end-of-life): `stepfun-ai/step-3.7-flash`, `nvidia/llama-3.3-nemotron-super-49b-v1.5`, `nvidia/llama-3.3-nemotron-super-49b-v1`, `thinkingmachines/inkling`
- Mistral 403 `tier_not_allowed`: `mistral-large-2512`
- Groq 413 payload-too-large: `openai/gpt-oss-120b` (39-file diff exceeds context)
- NIM timeouts: `nvidia/nemotron-3-ultra-550b-a55b`, `nvidia/nemotron-3-super-120b-a12b`, `openai/gpt-oss-20b`
- Mistral 429: `mistral-small-2603`

Follow-up run showed: "Probe: no model available, using SWE-bench chain order",
execution continuing after "Done with mistralai/mistral-nemotron", and a doubled
"Reviewing 39 files..." log line.

Questions: (1) Why are EOL models in the chain at all? (2) What does the probe line
mean and why is it log-only? (3) Why does execution continue after "Done"? (4) Where
is the dead-model lifecycle machinery and where are its gaps?

## Summary

1. **The retry layer is already correct for EOL errors.** `withRetry` retries only
   `status >= 500 || 429 || network-TypeError` (`src/retry.ts:29`). A 410/403/413
   fails on attempt 1 with zero sleep and the chain advances immediately. The real
   time-waste is 90 s `model_timeout` burns on hung models and 429/5xx backoff, not
   EOL retries.

2. **The runtime has no dead-model defense whatsoever.** `prioritizeChain`
   (`src/index.ts:485-496`) probes the whole chain but the result is **log-only** —
   the chain is never filtered or reordered (test-locked at `src/index.test.ts:548`).
   `removed-*.txt` and `*-model-history.json` are imported **only** by
   `src/bench-entry.ts` — the runtime bundle (`dist/bundle/index.js`) contains zero
   references to them. A dead model costs one failed probe + one failed chat per run,
   forever, with no cross-run learning.

3. **The chain source of truth is `action.yml` input defaults**, SWE-sorted at runtime
   by the static `SWE_BENCH_SCORES` table (`src/bench-reorder.ts:137-225`) baked into
   the bundle. A hidden second source — hardcoded TS fallbacks in `src/config.ts:69-73`
   — still lists EOL'd Mistral models (`mistral-medium-3.5`, `mistral-small-2603`) and
   is never updated by the pipeline.

4. **The bench pipeline does prune `action.yml`** (daily crons 06:00–06:50 UTC; the
   observed 410 models were ejected in `e872600`/`c3353b0` on 2026-09-03/04), but
   delivery to `@v1` consumers is broken by four compounding gaps:
   - **Tag freeze**: `v1` now points at the PR #32 merge (non-"benchmark" subject), so
     the move-guard in `benchmark-template.yml:163-174` will refuse every future move.
   - **Stale bundle**: the pipeline runs `build:tsc` only; `dist/bundle/index.js` (the
     actual runtime entrypoint, `action.yml:151`) was last built 2026-09-02 (`ddb9568`)
     and is never committed by any workflow.
   - **Groq silent stall**: the groq bench has committed nothing since 2026-08-19; when
     all benched models fail, reorder skips (`src/bench-reorder.ts:479-482`) and the
     workflow stays green — `openai/gpt-oss-120b` sits in defaults indefinitely.
   - **Score table never pruned**: `patchScoresTable` (`src/bench-reorder.ts:546-598`)
     is insert-only; EOL models keep high scores, so NIM re-admission probes them daily
     and any chain still containing them sorts them to the top.

5. **"Probe: no model available"** means `probeModels` returned null: either every
   probe failed/timed out (10 s budget, batches of 3 — big reasoning models can't
   answer "Say hi" that fast, EOL models 410 instantly) or the fastest responder was
   capped by `PROBE_PROMOTE_MAX_HEAD_GAP = 0.02` (`src/model-chain.ts:200-207`).
   Either way it is informational only.

6. **"Done with X" ≠ review done.** With default `parallel_attempts: 3`,
   `parallel_threshold: 40` (`src/config.ts:145-161`), the top 3 models launch
   concurrently, staggered 40 s apart (`src/index.ts:279-300`). The code deliberately
   does not stop at the first finisher ("aborting would let a weaker/faster model
   preempt a stronger one", `src/index.ts:295-298`); it waits for all attempts and
   picks the highest effective-SWE winner among those that returned findings
   (`src/index.ts:303-324`). A "Done" model only wins if it produced findings
   (`r.findings.length > 0`); zero-findings ("LGTM") or all-dropped results fall
   through to sequential execution of the remaining chain (`src/index.ts:360-380`).
   The doubled "Reviewing N files..." is two separate log statements around the probe
   step (`src/index.ts:736` and `src/index.ts:744`) — cosmetic.

## Detailed Findings

### 1. Runtime fallback chain and error classification

**Chain construction.** Per-provider model lists from action inputs
(`src/config.ts:66-73`) are combined in `buildCombinedChain` (`src/model-chain.ts:68-144`),
sorted by `getSweBenchScore` descending (`src/model-chain.ts:108-112`), with `:free`
models forced last (`src/model-chain.ts:114-117`), custom models always first. Logged
as "Combined chain: ..." at `src/index.ts:706`.

**Execution.** `runModelChainForBatch` (`src/index.ts:250-411`):
- Parallel mode (`parallel_attempts > 1`, default 3): top-N attempts launch with
  `i * parallel_threshold` stagger (`src/index.ts:282`); no abort on first winner;
  winner = max `effectiveScore` (SWE × latency penalty, `src/index.ts:240-248`) among
  attempts returning findings.
- Sequential fallthrough for the remainder of the chain after the parallel window
  (`src/index.ts:341-380`).
- Per-model timeout: `model_timeout` default **90 s** (`src/config.ts:117-125`),
  applied via `AbortSignal.timeout` in `attemptModel` (`src/index.ts:131-133`).

**Retry classification** (`src/retry.ts:19-33`, `src/openai-client.ts:289-328`):

| Error | Retried? | Attempts | Added delay |
|---|---|---|---|
| 429 | yes ×2 | 3 | 1.5–2.5 s + 2.5–3.5 s, or `Retry-After` (floor), cap 60 s |
| ≥500 | yes ×2 | 3 | 1.5–2.5 s + 2.5–3.5 s |
| network TypeError | yes ×2 | 3 | same |
| **410 / 403 / 413 / other 4xx** | **no** | 1 | 0 — fail fast to next model |
| timeout / abort | no | 1 | 0 (but the timeout itself costs up to 90 s) |

`Retry-After` is parsed only from the header and only on 429
(`src/openai-client.ts:309`). Backoff: exponential with ±50 % jitter, `Retry-After`
as floor, 60 s cap (`src/retry.ts:12-17`).

**Verdict on the EOL errors in the log**: each 410/403/413 cost exactly one HTTP
round trip. The expensive entries in the observed log are the NIM `TimeoutError`s
(90 s each — `minimaxai/minimax-m3` in the follow-up run) and the 429s.

### 2. The probe stage (log-only)

`prioritizeChain` (`src/index.ts:485-496`) calls `probeModels`
(`src/model-chain.ts:149-211`): every chain model gets a `chat("Say hi", maxTokens: 8)`
probe (`src/openai-client.ts:446-456`), batches of 3, 10 s timeout each
(`PROBE_TIMEOUT_MS`, `PROBE_CONCURRENCY` at `src/model-chain.ts:146-147`). The return
value is a *suggested head* — **discarded**; only the log line is emitted. Tests pin
that chain order never changes (`src/index.test.ts:548`). Promotion logic (with the
0.02 cap from the `probe-cap-and-stale-refs` change, `src/model-chain.ts:200-207`)
only affects which model the log names.

Consequences:
- "Probe: no model available, using SWE-bench chain order" (`src/index.ts:491`) is
  emitted when no probe succeeded or the fastest responder was below the cap — the
  run proceeds with the static SWE order regardless.
- A model that just 410'd the probe is still attempted in order later in the same run.
- Probe failures are swallowed (`catch { return false; }`, `src/openai-client.ts:453-455`)
  — no status, no logging of *which* model died or why. This is a lost signal: the
  runtime learns nothing from the 410s it sees on every PR.

### 3. Source of truth and delivery pipeline

**Runtime chain input** = `action.yml` defaults at the pinned ref:
- `nim_models` (`action.yml:16`): `mistralai/mistral-nemotron,nvidia/nemotron-3-ultra-550b-a55b,nvidia/nemotron-3-super-120b-a12b,openai/gpt-oss-20b,poolside/laguna-xs-2.1,minimaxai/minimax-m3`
- `mistral_models` (`action.yml:25`): `codestral-2508`
- `groq_models` (`action.yml:34`): `openai/gpt-oss-120b`
- `openrouter_models` (`action.yml:44`), `kilocode_models` (`action.yml:57`),
  `nousresearch_models` (`action.yml:70`): long `:free` lists.

**Hidden second source** — hardcoded fallbacks when an input resolves empty
(`src/config.ts:69-73`): Mistral fallback contains **EOL'd** `mistral-medium-3.5` and
`mistral-small-2603` (both in `removed-mistral-models.txt`); Groq fallback contains
`openai/gpt-oss-20b`. NIM has no fallback. These are compiled into the stale bundle.

**Update pipeline** (`.github/workflows/benchmark-{nim,mistral,groq,openrouter,kilocode,nousresearch}.yml`
→ `benchmark-template.yml`): bench (`src/bench-entry.ts`) → classify failures →
reorder (`updateActionYml`, `src/bench-reorder.ts:336-365`) rewrites the `default:`
CSV with only ranked-alive models → commit (`action.yml`, patched
`src/bench-reorder.ts`, removed/history files; **never `dist/`**) → move `v1` tag if
the tag currently points at a "benchmark" commit (`benchmark-template.yml:163-174`),
and only for nim/mistral/groq jobs (`move_tag: true`).

**Failure classification** (`classifyFailedModels`, `src/bench-entry.ts:73-97`):
probe-pass + catalog-listed → demote (synthetic probe-latency result kept in table);
probe-fail + catalog-listed → transient (persisted to `removed-*.txt`);
probe-fail + not-in-catalog → permanent (silently excluded, never recorded).

**Provider asymmetry**:
- NIM: no removed file **by design** (deleted in `bench-ejects-best-models`, commit
  `436fe05`); re-admission is catalog-driven (`readmitCatalogModels`,
  `src/bench-entry.ts:145-201`) probing top-5 `SWE_BENCH_SCORES ∩ catalog ∖ action.yml`.
- Mistral/Groq: file-based recheck (`removed-mistral-models.txt` exists;
  `removed-groq-models.txt` is configured in the workflow but **never existed in git**).
  Their workflows also hardcode `BENCH_MODELS` (`benchmark-mistral.yml:23` still
  includes the 403 model `mistral-large-2512`).
- OpenRouter/Kilo/Nous: hybrid discovery (`BENCH_AUTO_FREE`) + `*-model-history.json`
  set-diff (`src/model-history.ts:27-43`) + removed files.

**Staleness evidence (2026-09-06)**: action.yml defaults updated daily for
nim/openrouter/kilocode (today), nousresearch (09-05), mistral (09-04); **groq last
updated 2026-08-19 (18 days)**. `dist/bundle/index.js` last built **2026-09-02**
(`ddb9568`), missing PR #32's winner-selection logic and all score-table patches
since. `v1` (the only tag) points at `8c45dc9` — a non-benchmark merge — so the
tag-move guard will refuse all future moves.

### 4. The four delivery gaps (why EOL models keep being tried)

1. **Tag freeze.** `benchmark-template.yml:167` moves `v1` only when the tag's
   current commit subject contains "benchmark". `v1` → PR #32 merge → all future
   bench prunes land on main but never reach `@v1` consumers. Only nim/mistral/groq
   jobs attempt tag moves; OR/Kilo/Nous updates reach consumers only as passengers.
   Net: **all six provider lists are frozen at 2026-09-06 for `@v1` users**.
2. **Groq silent stall.** All benched models fail → all classified permanent →
   nothing written to removed file → empty table → "No benchmark data rows found —
   all models may have failed. Skipping reorder." (`src/bench-reorder.ts:479-482`)
   → exit 0 → workflow green → `openai/gpt-oss-120b` stuck in defaults indefinitely.
3. **Stale bundle.** Pipeline runs `build:tsc` only (`benchmark-template.yml:79`);
   `npm run build` (ncc bundle) is manual. Runtime executes 4-day-old compiled logic
   and score table; unknown models silently rank 0.5 (`src/bench-reorder.ts:231-233`).
4. **Score table never pruned.** `patchScoresTable` (`src/bench-reorder.ts:546-598`)
   is insert-only, per the deliberate `swe-list-order` decision "Remove from list,
   keep score". `SWE_BENCH_SCORES` still carries `stepfun-ai/step-3.7-flash: 0.744`
   (`src/bench-reorder.ts:146`), `nvidia/llama-3.3-nemotron-super-49b-v1.5: 0.660`
   (`:160`), `-v1: 0.650` (`:161`), `thinkingmachines/inkling: 0.650` (`:165`),
   `mistral-large-2512: 0.720` (`:179`). Consequences: NIM re-admission probes the
   dead high-scorers daily; any chain still containing them sorts them near the top.

Minor: per-provider ejection drift — `stepfun/step-3.7-flash:free` is ejected from
NousResearch (`removed-nousresearch-models.txt`) yet still present in the Kilo
default (`action.yml:57`) with score 0.744.

**Why the specific observed 410s happened**: all five IDs were present in
`action.yml` defaults until 2026-09-03/04 (`e872600` removed the NIM EOL models,
`c3353b0` trimmed `mistral_models` to `codestral-2508`). The runtime logs came from
runs at refs predating those ejections (or from `@v1` consumers whose ref lags).
Current defaults are clean — but gaps 1–4 guarantee the next EOL rotation repeats
the symptom.

## Code References

Permalinks (commit `8c45dc9`):

- [src/retry.ts#L29](https://github.com/pfrack/review-action/blob/8c45dc9/src/retry.ts#L29) — retry condition: `status >= 500 || status === 429 || isFetchNetworkError` (410/403/413 fail fast)
- [src/index.ts#L485-L496](https://github.com/pfrack/review-action/blob/8c45dc9/src/index.ts#L485) — `prioritizeChain`: probe result log-only
- [src/model-chain.ts#L149-L211](https://github.com/pfrack/review-action/blob/8c45dc9/src/model-chain.ts#L149) — `probeModels`: batches of 3, 10 s timeout, 0.02 promotion cap
- [src/index.ts#L279-L324](https://github.com/pfrack/review-action/blob/8c45dc9/src/index.ts#L279) — staggered parallel window, no abort-on-winner, highest-SWE winner selection
- [src/index.ts#L360-L380](https://github.com/pfrack/review-action/blob/8c45dc9/src/index.ts#L360) — sequential fallthrough after parallel window
- [src/config.ts#L69-L73](https://github.com/pfrack/review-action/blob/8c45dc9/src/config.ts#L69) — hardcoded Mistral/Groq fallbacks (contain EOL models)
- [src/bench-reorder.ts#L137-L225](https://github.com/pfrack/review-action/blob/8c45dc9/src/bench-reorder.ts#L137) — static `SWE_BENCH_SCORES` (contains EOL entries)
- [src/bench-reorder.ts#L546-L598](https://github.com/pfrack/review-action/blob/8c45dc9/src/bench-reorder.ts#L546) — `patchScoresTable`: insert-only, never prunes
- [src/bench-reorder.ts#L479-L482](https://github.com/pfrack/review-action/blob/8c45dc9/src/bench-reorder.ts#L479) — all-fail → "Skipping reorder" (Groq silent stall)
- [src/bench-entry.ts#L73-L97](https://github.com/pfrack/review-action/blob/8c45dc9/src/bench-entry.ts#L73) — `classifyFailedModels`: demote/transient/permanent
- [src/bench-entry.ts#L145-L201](https://github.com/pfrack/review-action/blob/8c45dc9/src/bench-entry.ts#L145) — `readmitCatalogModels`: NIM catalog-driven re-admission
- [benchmark-template.yml#L163-L174](https://github.com/pfrack/review-action/blob/8c45dc9/.github/workflows/benchmark-template.yml#L163) — tag-move guard (refuses moves from non-benchmark commits)
- [action.yml#L16](https://github.com/pfrack/review-action/blob/8c45dc9/action.yml#L16) — `nim_models` default (runtime chain source of truth)

Local quick map:

- `src/index.ts:736,744` — the doubled "Reviewing N files..." logs (cosmetic)
- `src/openai-client.ts:446-456` — `probeModel` swallows all errors, returns boolean
- `src/removed-models.ts`, `src/model-history.ts` — bench-only; no runtime imports
- `src/config.ts:117-125` — `model_timeout` default 90 s

## Architecture Insights

- **Two decoupled worlds.** Bench world (daily workflows, catalogs, history files,
  action.yml rewrites) and runtime world (input defaults + static score table in the
  bundle). The only bridge is the `action.yml` default string delivered via git ref
  movement — a fragile, single-channel design.
- **Design philosophy: tolerate, don't avoid.** The chain is built to absorb dead
  models (fail-fast 4xx fallthrough, per-model timeouts, silent fallthrough decided
  in `mistral-support`) rather than detect and exclude them. This was a deliberate
  choice (`mistral-support` plan-brief: "Fail silently, fall through") that predates
  the EOL-rotation era.
- **The probe is a vestigial organ.** It originally *promoted* the fastest model;
  after `probe-cap-and-stale-refs` capped promotion (0.02) and
  `parallel-winner-swe-dominates` moved "fastest wins" into the parallel window,
   the probe's result is pure logging — yet it still costs 10 s × ⌈N/3⌉ per run and
   sees exactly the 410s nobody records.
- **Trust asymmetry in signals.** The pipeline trusts the provider `/models` catalog
  for transient/permanent classification and re-admission — but the catalog keeps
  listing EOL models that 410 on chat. Meanwhile the runtime's first-hand 410
  evidence is discarded. The best dead-model signal in the system is thrown away at
  both ends.

## Historical Context (from prior changes)

- `context/archive/2025-07-21-model-recheck/` — origin of `removed-models.txt` +
  catalog classification (NIM + Mistral). All manual verification items still
  unchecked; open questions (probe-vs-full-benchmark, committed vs cache) never
  resolved.
- `context/archive/2026-07-19-mistral-support/` — decided "silent fallthrough" for
  wrong/dead models; removed a hardcoded `nim_models` fallback for
  single-source-of-truth — the same drift problem that has since regrown in
  `src/config.ts:69-73`.
- `context/archive/2026-07-27-swe-list-order/` — built `*-model-history.json` +
  auto-discovery for **OpenRouter/Kilo only**; "Auto-discovery for NIM/Mistral/Groq
  (Phase 2)" explicitly out of scope and never shipped. Decision "Remove from list,
  keep score" is why the score table never prunes.
- `context/archive/2026-08-06-bench-ejects-best-models/` — the eject mechanism made
  both error types: ejected healthy `minimax-m3` (HTTP 200 in 47.8 s) and never
  re-admitted catalog-listed-but-hanging models. Fix: three-way classification +
  NIM catalog-driven re-admission; removed NIM's file. OR/Kilo/Nous/Mistral still
  run the old file-based recheck.
- `context/changes/per-model-timeout/` — 60 s per-model timeout introduced (now 90 s);
  "no model completed is never acceptable" → unlimited chain timeout.
- `context/changes/model-chain-resilience/` — retrospective umbrella; entire Phase 4
  (tests, README alignment, live verification) pending.
- `context/changes/probe-cap-and-stale-refs/` — probe promotion cap; still
  `in_progress`, no plan/review.
- `context/changes/parallel-winner-swe-dominates/` — documents a prior 9-day
  staleness incident (bench crashed on a TS bug, 3 of 6 chains stale) — evidence the
  delivery pipeline has gone down before.

## Related Research

- `context/archive/2025-07-21-model-recheck/research.md` — original removed-models design
- `context/archive/2026-08-06-bench-ejects-best-models/frame.md` — false-ejection root cause
- `context/changes/optimize-gh-workflows/research.md` — bench workflow topology matrix
- `context/changes/graphql-error-retry-mapping/research.md` — retry-layer policy (4xx non-retryable by design)

## Open Questions

1. **Runtime dead-model memory**: should the runtime filter the chain on probe
   results (e.g. drop models whose probe failed with a permanent status like
   410/403), or persist a per-run dead-list? The probe already has the signal — it
   just discards status info (`src/openai-client.ts:453-455`).
2. **Tag propagation**: should the `v1` move-guard allow moves from any commit (or
   should releases be cut explicitly)? Right now one manual tag move froze all six
   providers' lists for `@v1` consumers.
3. **Bundle freshness**: should the bench pipeline (or CI) rebuild and commit
   `dist/bundle/index.js`, or should the action build at publish time? The bundle is
   4 days stale and contains EOL fallback lists.
4. **Score-table pruning**: should `patchScoresTable` (or a new step) delete entries
   for models absent from every provider catalog and every action.yml default?
   "Keep score for re-addition" now means "probe dead models daily forever".
5. **Silent-stall alerting**: should the all-fail "Skipping reorder" path
   (`src/bench-reorder.ts:479-482`) fail the workflow or open an issue instead of
   exiting green? The Groq chain has been dead for 18 days without any signal.
6. **Fallback-list drift**: should the hardcoded `src/config.ts:69-73` fallbacks be
   removed entirely (single source of truth = `action.yml`), as
   `mistral-support`'s impl-review once demanded for `src/review.ts`?
7. **Cross-provider ejection**: should ejection of a model ID from one provider's
   defaults consider the same underlying model on other providers (e.g.
   `stepfun/step-3.7-flash:free` ejected from Nous but head of Kilo's free tier)?
