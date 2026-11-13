# Frame Brief: Optimize GitHub Workflows

> Framing step before /10x-plan. This document captures what is *actually*
> at issue, separated from what was initially assumed.

## Reported Observation

The 5 `benchmark-*.yml` workflows are ~80% identical; a CI rebase conflict
recently broke daily benchmark pushes; `npm run build` runs an unused `ncc`
bundle; one shared `benchmark-commit` concurrency group serializes all
providers. User scope answer: investigate "all of them" together.

## Initial Framing (preserved)

- **User's stated cause or approach**: Duplication is the core problem; the fix is
  a reusable `workflow_call` template + 5 thin callers, plus `build:tsc`, relaxed
  per-provider concurrency, and centralized commit hygiene.
- **User's proposed direction**: Implement that refactor (template + callers +
  `build:tsc` + per-provider groups).
- **Pre-dispatch narrowing**: User picked "all of them" (concern), "Not sure"
  (change frequency), "All 5 together" (scope). Scope is comprehensive; priority
  among the concerns was not asserted.

## Dimension Map

The observation could originate at any of these dimensions:

1. **Code duplication / DRY** — 5 files are ~80% identical; one logic change means
   editing five files.  ← initial framing
2. **Reliability / correctness** — rebase conflict broke daily pushes; recent
   `fix(...): harden workflow`, `validate concurrency envs`, `stabilize flaky
   test` commits; env-validation gaps in the benchmark code.
3. **Runtime / cost** — unused `ncc build src/index.ts` in `npm run build`
   (package.json:7); single shared `benchmark-commit` group serializes the five
   providers (wall-clock ~50 min vs ~10–15 min).
4. **Risk concentration (counter-dimension)** — a reusable-template rewrite would
   place all five providers behind one file; a single template bug breaks every
   provider simultaneously, concentrating the exact risk the workflows currently
   distribute.

## Hypothesis Investigation

| Hypothesis | Evidence | Verdict |
| --- | --- | --- |
| **1. DRY is the real pain** | Workflows created 2026-08-06 (7cdfb0d); only ~3 commits touch them across all time; authored together in one change. No duplication-driven edit incident exists. | WEAK — duplication is real but inert |
| **2. Reliability is the real pain** | Original session incident: rebase conflict broke daily benchmark pushes. Commit subjects: `harden workflow`, `validate concurrency envs`, `stabilize flaky test` (f032d75, 7cdfb0d). Rebase-first fix applied this session (087d6a6). | STRONG |
| **3. Runtime waste is real** | `package.json:7` `build` runs `ncc build src/index.ts` (action bundle) unused by benchmark jobs that only run `dist/src/bench-entry.js`; `git clean -fd` discards it. Shared group serializes providers 10 min apart. | STRONG (for ncc waste); MEDIUM (concurrency) |
| **4. Reusable-template refactor adds risk** | GitHub reusable workflows + per-provider secret passing is fiddly; a single template bug would break all 5 providers at once; the 5 thin callers still exist (matrix can't carry per-entry crons), so de-dup reduction is partial. | STRONG (risk is real) |

## Narrowing Signals

- **Change frequency**: all five `benchmark-*.yml` were created 2026-08-06 and
  touched in only ~3 commits total (git log). They are 4 days old and were
  written together. This rules IN dimension 2/3 and rules OUT dimension 1 as a
  *current* pain — the "edit five files" cost has barely been paid.
- **Incident history**: the only concrete breakage this session was a rebase
  conflict (reliability), already mitigated by the rebase-first fix — not a
  duplication defect.
- **Commit subjects**: multiple `harden`/`stabilize flaky test` commits indicate
  the workflows have been *unstable*, not *repetitive* — a reliability signal.

## Cross-System Convention

Extracting a reusable `workflow_call` template is idiomatic GitHub Actions DRY —
**but** the convention applies when jobs are truly identical AND change often.
Here the jobs differ in non-trivial ways (kilocode/openrouter run a discover-new-
models + `src/bench-reorder.ts` patch block; nim/mistral/groq run a trailing tag-
moving block; `--two-tier` only for two providers; differing secrets) and change
rarely (3 commits / 4 days). The reusable-template pattern does not clearly fit,
and prior change `bench-ejects-best-models` deliberately created all five together
as a coordinated set, suggesting they were never expected to diverge much.

## Reframed (or Confirmed) Problem Statement

> **The actual problem to plan around is**: harden the daily benchmark workflows
> for **reliability** and apply the **cheap runtime trims** — NOT a DRY
> refactoring into a reusable template.

The duplication is real but inert (4-day-old files, ~3 edits, authored together),
so it has not caused a maintenance incident. The actual incidents are rebase/push
breakage and flaky/hardening debt. A reusable-template rewrite would concentrate
failure risk (one template bug breaks all five providers) while delivering only
partial de-duplication (5 thin callers remain because matrix can't carry per-entry
crons). The high-value, low-risk work is: keep the already-applied rebase-first
fix, trim the build (`build:tsc`), and relax concurrency to per-provider groups —
none of which requires restructuring the files.

## Confidence

- **HIGH** — strong evidence (git history + incident log + hardening commit
  subjects) supports reliability/runtime over DRY, and the convention check
  confirms a reusable-template refactor is a poor fit for rarely-changing,
  partly-divergent jobs.

## What Changes for /10x-plan

The plan should target **reliability hardening + low-risk runtime trims**, and
should **explicitly de-prioritize or drop the reusable-template de-duplication**
unless workflow change-frequency rises. Concretely: (1) verify the rebase-first
fix holds and address remaining flaky-test/hardening debt; (2) add `build:tsc` and
switch benchmark jobs to it; (3) move from the shared `benchmark-commit` group to
per-provider groups (keeping kilocode+openrouter serialized to protect the
`src/bench-reorder.ts` patch). Treat the reusable-workflow rewrite as out of
scope unless a concrete, recurring multi-file edit pain emerges.

## References

- Source files: `package.json:7`, `.github/workflows/benchmark-*.yml`,
  `src/bench-reorder.ts:530` (the only shared-file mutation).
- Incident: rebase conflict in session (resolved via rebase-first, commit 087d6a6).
- Related research: `context/changes/optimize-gh-workflows/research.md`.
- Investigation tasks: performed directly (Task sub-agents unavailable in this
  environment); no TaskCreate IDs.
