# Implementation Review: bench-ejects-best-models

- **Review ID**: `impl-review` (fresh, full)
- **Date**: 2026-08-06
- **Reviewer**: opencode (agents: Plan Drift + Safety/Patterns + automated checks)
- **Scope**: `src/bench-reorder.ts`, `src/bench-entry.ts`, `src/bench-reorder.test.ts`, `src/bench-entry.test.ts`, `.github/workflows/benchmark.yml`, `README.md`, `context/foundation/shape-notes.md`, removed-models handling
- **Reference**: `context/changes/bench-ejects-best-models/plan.md`
- **Verified HEAD**: `20b93ff` (branch `feat/bench-ejects-best-models`; feature commits `d9cf9f6`..`575a9ae` on `main`)
- **Automated checks**: `npm run build` green (ncc 0.38.4); `npm test` **586/586 pass** (after fixes; 580/580 pre-fix), `tsc --noEmit` clean

## Verdict: NEEDS ATTENTION

No CRITICAL findings. Plan is substantively implemented and all automated checks pass,
but 5 WARNING-level gaps remain — most notably the untested three-way failure-classification
core (the central behavior of this change) and an unvalidated concurrency env var that can
hang the job in an infinite loop.

## Findings

### CRITICAL

None.

### WARNING

1. **`BENCH_CONCURRENCY` unvalidated → infinite loop / silent empty run** (`src/bench-entry.ts:43,407`)
   `concurrency = parseInt(envOrDefault('BENCH_CONCURRENCY','1'), 10)` with no validation.
   `mapWithConcurrency` uses `for (let i = 0; i < items.length; i += concurrency)` — a value of
   `0` yields `i += 0` forever (job hangs); `NaN` yields `i` as `NaN` so the loop body never runs
   and the job silently benchmarks nothing. Contrast `BENCH_ITERATIONS` (line 400-402) which
   validates `isNaN` and throws. The same hazard exists in the recheck loop (`BENCH_RECHECK_CONCURRENCY`, line 579/582).
   **Fix**: validate a positive integer for all three (mirror the `BENCH_ITERATIONS` guard).

2. **Three-way failure classification is entirely untested** (`src/bench-entry.ts:469-505` vs `plan.md:327-331`)
   The plan's testing strategy promised coverage for demote-but-keep, transient, permanent-unavailable,
   and the recheck-path. None delivered: no test exercises `probeModel`-based classification, the
   synthetic probe-latency result, or the transient-only replacement gate. This is the core behavior
   the change exists to fix — the 580 passing tests are all in pre-existing paths.
   **Fix**: add unit tests for the classification (export the classifier or extract it), including a
   probe-pass/demote case and probe-fail/permanent case.

3. **Stale README probe claim survives the Phase 3 grep check** (`README.md:75`)
   Phase 3.2's grep ("moved to the front") passes only because it searches for a different phrasing.
   The actual text still reads "moves the fastest-responding model to the front" — the exact claim
   `probe-cap-and-stale-refs` removed (probe is log-only / cap-gated). Misleading docs for the merged
   behavior.
   **Fix**: update the probe bullet to reflect log-only probing.

4. **Workflow force-push race; rebase failure masked** (`.github/workflows/benchmark.yml`)
   5 parallel jobs each `git push --force` the same ref after `git pull --rebase`; no `--force-with-lease`.
   The commit step masks rebase conflicts with `|| true` (exit 0 hides the failure), and a stale fetch
   window can clobber a concurrent job's commit. Pre-existing, but in scope because the change modified
   this workflow.
   **Fix**: `--force-with-lease`, make rebase failure explicit (exit non-zero), and/or serialize the push.

5. **Shape-notes "implemented" marker missing on the PR branch** (`context/foundation/shape-notes.md:15`)
   On `main` the checkpoint is stamped `status: "implemented"`; the branch HEAD `20b93ff` drops it
   (2-line diff). The PR/working tree therefore disagrees with `main` about the phase-3 checkpoint.
   **Fix**: carry the marker into the branch (or note it as main-only).

### OBSERVATION

- **O1 — Probe timeout drift from plan**: plan assumes a 30s probe; `probeModel` (`src/openai-client.ts:444`)
  calls `chat()` with the 180s default timeout and no outer signal. A hung provider makes the "demoted" path
  take up to 3min per model. Worth a dedicated probe timeout.
- **O2 — `readmitCatalogModels` runs unconditionally** (`bench-entry.ts:447`): catalog re-probing happens even
  when the main run had zero failures; minor extra API churn.
- **O3 — Empty `rankModels` result would wipe the chain** (`src/bench-reorder.ts` ~458): `updateActionYml` is
  guarded only on `rows.length`, not `ranked.length` — if all scores collapse to 0, `nim_models` would be
  emptied. Defensive check recommended.
- **O4 — Duplicated `startMockServer`** in `src/bench-entry.test.ts:167` vs shared `test-utils.ts`; the reorder
  test file uses the shared util. Consolidate.
- **O5 — Unrelated sweep in phase-1 commit**: `d9cf9f6` also carried `src/github-graphql.ts` pagination changes
  plus `review-pagination`/`review-speed` context scaffolds — those belong to other changes and were not
  reviewed here (scope discipline flag, not a defect).

## Dimension Verdicts

| Dimension | Verdict | Notes |
|---|---|---|
| Plan Adherence | **PARTIAL** | Phases 1–3, 5 implemented as planned; testing strategy (F2) unmet; README grep check (F3) trivially passes; checkpoint marker drift (F5). |
| Scope Discipline | **PASS** | No scope creep beyond the noted unrelated phase-1 sweep (O5, out of review scope). |
| Safety & Quality | **WARNING** | No CRITICAL; concurrency hang (F1), force-push race (F4), chain-wipe risk (O3). |
| Architecture | **PASS** | Catalog-driven re-admission and three-way classification are cleanly structured; good separation from file-based recheck path. |
| Pattern Consistency | **WARNING** | Env-var validation inconsistent (F1 vs BENCH_ITERATIONS); duplicated test util (O4). |
| Success Criteria | **PASS (automated)** | Build + 586/586 tests green; `BENCH_CONCURRENCY: '3'` wired in NIM job; removed-models file path correctly removed for NIM only. |

## Recommendation

Merge-blocking: none. Address F2 (tests for the classification core) and F1 (concurrency validation)
before or alongside merge; F3 and F5 are quick doc fixes. F4 is a workflow hardening item worth a
follow-up since this change already touches the file.

## Resolution of Findings (2026-08-06, post-review fixes)

All 5 WARNINGs addressed in the working tree (uncommitted, on branch `feat/bench-ejects-best-models`):

- **F1 — DONE**: added `parsePositiveIntEnv` (`src/bench-entry.ts`) validating a positive integer;
  applied to `BENCH_CONCURRENCY`, `BENCH_READMIT_LIMIT`, `BENCH_RECHECK_CONCURRENCY`. Non-integer or
  `< 1` now throws instead of hanging (`i += 0`) or silently benchmarking nothing (`NaN`).
- **F2 — DONE**: extracted the three-way classifier into exported `classifyFailedModels`
  (`src/bench-entry.ts`); `main()` consumes its `demoted`/`transient`/`permanent` buckets. Added 6 unit
  tests in `src/bench-entry.test.ts` covering demote (catalog + off-catalog), transient (catalog-listed
  probe-fail), permanent (not-in-catalog and no-catalog cases), and mixed classification.
- **F3 — DONE**: `README.md` model-probing bullet rewritten to state the probe is diagnostic only and
  never reorders the chain (matches `model-chain.ts`/`index.ts` log-only usage).
- **F4 — DONE**: all 5 branch force-pushes in `benchmark.yml` switched to `--force-with-lease`; the 3
  rebase-conflict blocks changed from `exit 0` (masking failure) to `exit 1`. Tag force-pushes left as-is
  (single job owns them).
- **F5 — DONE**: `context/foundation/shape-notes.md` restored the `status: "implemented"` + `implemented_in`
  checkpoint marker matching `main`.

Post-fix verification: `npm run build` green, `tsc --noEmit` clean, `npm test` **586/586 pass** (was
580/580; +6 new classification tests). Note: the branch's squashed HEAD does not yet contain these fixes —
they exist only in the working tree and must be committed/pushed to the PR.

## Follow-up Resolution (2026-08-06): split benchmark into staggered per-provider workflows

Per user decision, the monolithic `benchmark.yml` was split into 5 per-provider workflows so a
hosted-runner provisioning failure on one provider cannot fail the whole run:

- `.github/workflows/benchmark-nim.yml` (cron `0 6 * * *`)
- `.github/workflows/benchmark-mistral.yml` (cron `10 6 * * *`)
- `.github/workflows/benchmark-groq.yml` (cron `20 6 * * *`)
- `.github/workflows/benchmark-openrouter.yml` (cron `30 6 * * *`)
- `.github/workflows/benchmark-kilocode.yml` (cron `40 6 * * *`)

Design notes:
- Staggered schedules (10 min apart) serialize pushes to `main` from the shared `action.yml`/`src/bench-reorder.ts`,
  eliminating the cross-job force-push race that F4 mitigated with `--force-with-lease`.
- All 5 workflows keep the **shared** `concurrency.group: benchmark-commit` so an overlapping manual
  dispatch or delayed rerun still serializes against other providers' runs.
- Each workflow retains its provider-specific env (secrets, `BENCH_BASE_URL`, `REMOVED_MODELS_PATH`,
  `ACTION_TARGET`, model lists) and the F4 fixes carried over.
- Observed failure context: run `31127936000` — only `benchmark-groq` was cancelled by
  "Runner of type hosted not acquired"; 4 other jobs committed successfully. `gh run rerun --failed`
  issued (status: queued at time of writing).

Verification: all 5 YAML files parse; schedule/group/jobs confirmed via parser. `benchmark.yml` removed.
