---
date: 2026-08-14T00:00:00Z
researcher: opencode
git_commit: 087d6a669209e6a650f64988307bd0e2fde7eaa3
branch: main
repository: review-action
permalink_base: https://github.com/pfrack/review-action/blob/087d6a669209e6a650f64988307bd0e2fde7eaa3
topic: "Optimize GitHub workflows (de-dup, speed, concurrency, commit hygiene)"
tags: [research, codebase, github-actions, benchmark-workflows, ci]
status: complete
last_updated: 2026-08-14
last_updated_by: opencode
---

# Research: Optimize GitHub workflows

**Date**: 2026-08-14
**Researcher**: opencode
**Git Commit**: 087d6a669209e6a650f64988307bd0e2fde7eaa3
**Branch**: main
**Repository**: review-action

## Research Question

Optimize the GitHub Actions workflows: de-duplicate the 5 benchmark workflows,
reduce runtime, re-examine the shared `benchmark-commit` concurrency group, and
improve commit hygiene.

## Summary

All five `benchmark-*.yml` workflows share an identical ~80% skeleton; only
provider-specific parameters, the `--two-tier` reorder flag, the optional
"discover new models" block, and a trailing tag-moving block differ. The biggest
runtime waste is `npm run build` running `ncc build src/index.ts` (package.json:7)
even though the benchmark jobs only consume `dist/src/bench-entry.js` (tsc output)
— the ncc bundle is dead work for every benchmark run. The single shared
`benchmark-commit` concurrency group currently serializes all five providers; with
the rebase-first fix already in place, per-provider groups (or at least
de-coupling the two `src/bench-reorder.ts`-patching providers) are now safe and
would cut wall-clock. The recommended outcome is one reusable `workflow_call`
template + five thin cron callers, a `build:tsc`-only script for benchmarks, and
per-provider concurrency.

## Detailed Findings

### Component 1 — Workflow skeleton & duplication

Every `benchmark-*.yml` contains these steps in the same order:

1. `actions/checkout@v4` (fetch-tags) — identical across all 5.
2. `Sync with origin/main` (rebase-first) — added this session, identical in all 5
   (`.github/workflows/benchmark-kilocode.yml:22-27`, mirrored in the other 4).
3. `actions/setup-node@v4` (node 20, cache npm) — identical.
4. `npm ci` — identical.
5. `npm run build` — identical, but see runtime finding.
6. "Run <Provider> benchmark" — **differs only by env** (API key secret, base URL,
   model list, concurrency, removed/history paths, `ACTION_TARGET`).
7. "Show results" — identical.
8. "Discover new models" + "Add new models to SWE-bench table" — **present only in
   kilocode & openrouter** (driven by `MODEL_HISTORY_PATH` + `REMOVED_MODELS_PATH`).
9. "Reorder models" — differs by `ACTION_TARGET` and the `--two-tier` flag
   (kilocode/openrouter pass `--two-tier`; nim/mistral/groq pass plain).
10. "Commit updated model order" — near-identical; differs by the `AMEND_MSG`
    string, which extra files are `git add`ed (`src/bench-reorder.ts` only for
    kilocode/openrouter), and the removed/models-history paths.
11. Trailing tag-moving block — **present only in nim, mistral, groq**.

Cron schedules are the only "timing" parameter: nim `0 6`, mistral `10 6`,
groq `20 6`, openrouter `30 6`, kilocode `40 6`
(`benchmark-nim.yml:5`, `benchmark-mistral.yml:5`, `benchmark-groq.yml:5`,
`benchmark-openrouter.yml:5`, `benchmark-kilocode.yml:5`).

`ci.yml` (test on push/PR) and `ai-review.yml` (uses the published
`pfrack/review-action@v1` action) are orthogonal and should NOT be folded into the
benchmark template.

**Conclusion**: the 5 files are parameterizations of one template. The differing
axes are exactly: cron, API-key secret name, `BENCH_BASE_URL`, `BENCH_MODELS`,
`BENCH_CONCURRENCY`, `REMOVED_MODELS_PATH`, `MODEL_HISTORY_PATH`, `ACTION_TARGET`,
`--two-tier` flag, `discover_new` block, `move_tag` block.

### Component 2 — Runtime cost

- `package.json:7`: `"build": "tsc && cp -r src/__fixtures__ dist/src/__fixtures__ && ncc build src/index.ts -o dist/bundle"`.
  The benchmark jobs invoke `node dist/src/bench-entry.js`
  (`benchmark-kilocode.yml:42`) — that is tsc output. The final `ncc build
  src/index.ts -o dist/bundle` produces the bundled action used by `ai-review.yml`
  (`pfrack/review-action@v1`), which the benchmark runs do NOT need. So every one
  of the 5 daily runs pays for a full ncc bundle that is immediately discarded by
  `git clean -fd` after commit (e.g. `benchmark-kilocode.yml:108-109`).
  **Free win**: add `"build:tsc": "tsc && cp -r src/__fixtures__ dist/src/__fixtures__"`
  and have benchmark jobs run `npm run build:tsc`. ncc is only needed by the
  publish/release path.
- `npm ci` runs in all 5 even though `node_modules` is identical; `setup-node`
  cache:`npm` already caches the npm cache, so this is acceptable, not a priority.
- `dist/` is not gitignored and is wiped by `git clean -fd` each run, so it is
  rebuilt every time. A `actions/cache` keyed on `package-lock.json`+`tsconfig.json`
  could persist `dist/` across runs, but the build is cheap relative to the actual
  benchmark network calls, so low priority.
- The dominant real cost is the benchmark itself: `bench-entry.ts:459-490` runs
  `BENCH_ITERATIONS` chat completions per model (default 2, workflows set `1`) with
  `BENCH_CONCURRENCY` (nim uses 3). This is minutes of provider API latency per
  provider and is inherent — not optimizable at the workflow layer beyond the
  existing concurrency.
- `bench-entry.ts:336-349` and `:344` fetch the provider model catalog and
  SWE-bench scores (`bench-reorder.ts:56-79`) once per run — fine.

### Component 3 — Concurrency

All 5 share `concurrency: group: benchmark-commit, cancel-in-progress: false`
(e.g. `benchmark-kilocode.yml:11-13`). This **serializes** the five providers
globally, so they run back-to-back even though their crons are only 10 min apart
(`0/10/20/30/40 6`). The original reason was to avoid `action.yml` push conflicts.

With the rebase-first `Sync with origin/main` step now in every workflow, each job
edits `action.yml` only after rebasing onto the latest `main`. The reorder rewrites
a *single provider section* via `updateActionYml` (`bench-reorder.ts:324-353`), and
the rebuild of `main` is pure rebase, so two providers touching *different*
`action.yml` sections no longer conflict. The push-retry loop
(`benchmark-kilocode.yml:135-152`) already re-syncs + rebases on a non-fast-forward,
so even true parallelism resolves cleanly.

**Remaining risk**: kilocode (`40 6`) and openrouter (`30 6`) both run the
"Add new models to SWE-bench table" step that patches `src/bench-reorder.ts`
(`bench-reorder.ts:530-559`, invoked at `benchmark-kilocode.yml:56` /
`benchmark-openrouter.yml:56`). Two concurrent patches to the same
`SWE_BENCH_SCORES` table would conflict. They are only 10 min apart, so the safer
move is to keep those two serialized (a `benchmark-reorder-patch` subgroup) while
letting nim/mistral/groq run fully in parallel.

**Recommendation**: replace the single shared group with per-provider groups
(`benchmark-<provider>`), and additionally serialize kilocode+openrouter with a
second `concurrency` group (or simply accept the small 10-min offset and rely on
the retry loop). This converts ~50 min of serialized wall-clock into ~10–15 min.

### Component 4 — Commit hygiene

The commit step (`benchmark-kilocode.yml:118-153`) uses:
- `AMEND_MSG` = the provider's own benchmark message; if the current `HEAD`
  already is that message it `--amend --no-edit` (collapsing repeated runs into one
  rolling commit), else it makes a new `[skip ci]` commit.
- A 3-iteration push-retry that re-syncs via `git pull --rebase origin main` and
  aborts on conflict.

This is sound. With rebase-first, `HEAD` at commit time is `origin/main` tip, so the
amend branch fires only when the previous run was this provider's own commit —
exactly the intended "one commit per provider per day" behavior. `force-with-lease`
guards against clobbering another provider's concurrent push.

One sharpening: because all 5 now share the same rebase-first + retry pattern, this
logic belongs in the reusable template (a single source of truth), eliminating the
5 copies where a future edit could drift.

## Code References

(Permanent links use `permalink_base` =
https://github.com/pfrack/review-action/blob/087d6a669209e6a650f64988307bd0e2fde7eaa3)

- `.github/workflows/benchmark-kilocode.yml:1-154` — reference implementation of the
  full skeleton (checkout, sync, build, benchmark, discover, reorder, commit+retry).
  https://github.com/pfrack/review-action/blob/087d6a669209e6a650f64988307bd0e2fde7eaa3/.github/workflows/benchmark-kilocode.yml#L22-L153
- `.github/workflows/benchmark-openrouter.yml:1-153` — same as kilocode; also patches
  `src/bench-reorder.ts`.
- `.github/workflows/benchmark-nim.yml:1-93` — no discover/patch block; trailing
  tag-moving block at `:82-92`.
- `.github/workflows/benchmark-mistral.yml:1-100` / `benchmark-groq.yml:1-100` —
  same shape as nim (plain reorder, tag-moving block, amend/else split).
- `.github/workflows/ci.yml:1-23` — orthogonal `npm test` CI; keep separate.
- `.github/workflows/ai-review.yml:1-27` — consumes the published `pfrack/review-action@v1`.
- `package.json:7` — `build` script includes wasted `ncc build src/index.ts`.
- `src/bench-entry.ts:42,459-490` — benchmark driver (cost is provider API latency).
- `src/bench-reorder.ts:324-353` — `updateActionYml` rewrites one provider section.
- `src/bench-reorder.ts:530-559` — `patchScoresTable` mutates `SWE_BENCH_SCORES`
  (the only shared-file mutation; source of the kilocode/openrouter conflict risk).

## Architecture Insights

- The five benchmark jobs are a classic "parameterized job" smell that GitHub
  resolves via a reusable `workflow_call` template + thin callers (NOT a matrix,
  because a matrix cannot carry per-entry cron schedules).
- The build step is over-specified for benchmark consumers; the action bundle and
  the benchmark entrypoint are two different artifacts with two different
  lifecycles (release vs. daily cron).
- `action.yml` is a single multi-provider file; the rebase-first design makes
  per-section edits commute, which is what unlocks safe parallelization.
- `src/bench-reorder.ts` is the one shared mutable artifact and should remain
  effectively single-writer to avoid patch conflicts.

## Recommended Refactor (design)

**1. Add `build:tsc` script** (`package.json`) for benchmark jobs:
```
"build:tsc": "tsc && cp -r src/__fixtures__ dist/src/__fixtures__"
```

**2. Create `.github/workflows/benchmark-template.yml`** with
`on: workflow_call` + inputs: `provider`, `cron` (unused by template; cron lives on
caller), `base_url`, `models`, `concurrency`, `removed_path`, `history_path`,
`action_target`, `two_tier` (bool), `discover_new` (bool), `move_tag` (bool), and a
`secrets: { BENCH_API_KEY: ... }` mapping. The template runs: checkout →
`Sync with origin/main` → setup-node → `npm ci` → `npm run build:tsc` → benchmark →
show → (if `discover_new`) discover+patch `src/bench-reorder.ts` → reorder (`--two-tier`
when `two_tier`) → commit+push-retry (single shared implementation) → (if
`move_tag`) tag-moving block.

**3. Five thin callers**, e.g. `benchmark-kilocode.yml`:
```yaml
name: Daily Model Benchmark - Kilocode
on:
  schedule: [{ cron: '40 6 * * *' }]
  workflow_dispatch: {}
permissions: { contents: write }
concurrency:
  group: benchmark-kilocode
  cancel-in-progress: false
jobs:
  run:
    uses: ./.github/workflows/benchmark-template.yml
    secrets:
      BENCH_API_KEY: ${{ secrets.KILO_API_KEY }}
    with:
      provider: kilocode
      base_url: 'https://api.kilo.ai/api/gateway'
      removed_path: removed-kilocode-models.txt
      history_path: kilocode-model-history.json
      action_target: kilocode_models
      two_tier: true
      discover_new: true
      move_tag: false
```
OpenRouter is `two_tier: true, discover_new: true, move_tag: false`;
nim/mistral/groq are `two_tier: false, discover_new: false, move_tag: true`.

**4. Concurrency**: per-provider groups (`benchmark-<provider>`). To protect the
`src/bench-reorder.ts` patch, add a second concurrency group to kilocode &
openrouter only: `group: benchmark-reorder-patch` (so those two never overlap).

**5. Commit hygiene** is centralized in the template's single commit+retry block —
no behavior change from current per-file logic.

## Historical Context (from prior changes)

- `context/changes/nodejs-rewrite/` and `context/changes/parallel-model-review/` —
  the rewrite that introduced the TypeScript benchmark entrypoints and the
  `action.yml` multi-provider model lists that these workflows maintain.
- `context/changes/kilocode-provider/` / `context/changes/openrouter-provider/` —
  added the `--two-tier` reorder and the discover-new-models / `patchScoresTable`
  flow that only kilocode & openrouter run today.
- The `benchmark-commit` shared group and the original rebase-after-commit design
  were the prior attempt to avoid `action.yml` conflicts; the rebase-first fix
  applied this session (`087d6a6`) supersedes the need for global serialization.

## Related Research

- `context/changes/optimize-gh-workflows/research.md` (this document).
- `context/changes/nodejs-rewrite/plan.md` — benchmark entrypoint architecture.

## Open Questions

- Should `dist/` be cached across runs (keyed on `package-lock.json` +
  `tsconfig.json` + `src/**`) to skip even the `tsc` step? Measure `tsc` duration
  on the CI runner first; likely not worth it vs. provider API latency.
- For kilocode/openrouter, is the 10-minute cron offset sufficient, or do we want
  an explicit second concurrency group to guarantee no `src/bench-reorder.ts`
  patch overlap? Recommend the explicit group for safety.
