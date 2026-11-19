# Optimize GitHub Workflows — Plan Brief

> Full plan: `context/changes/optimize-gh-workflows/plan.md`
> Frame brief: `context/changes/optimize-gh-workflows/frame.md`
> Research: `context/changes/optimize-gh-workflows/research.md`

## What & Why

The 5 daily `benchmark-*.yml` workflows are ~80% duplicated behind one shared
`benchmark-commit` concurrency group that serializes all providers (~50 min
wall-clock), and each run wastes a full `ncc` action bundle it never uses. We will
harden for reliability, trim runtime, **and** extract a reusable
`workflow_call` template. *Note:* the frame brief de-prioritized the template
rewrite, but the user explicitly chose "Both: trims + template", accepting the
frame's risk-concentration tradeoff for de-duplication and a single source of
truth.

## Starting Point

Five 4-day-old, rarely-edited workflows share an identical skeleton and a single
global concurrency group; `package.json:7` `build` runs an unused `ncc` bundle for
benchmark jobs. Prior commits already landed env validation, rebase guarding,
GraphQL retry, and rebase-first sync — so the "remaining hardening debt" is
verification, not new runtime code.

## Desired End State

Benchmark jobs build with `npm run build:tsc` (no ncc); each provider runs in its
own concurrency group (kilocode+openrouter serialized to protect the
`src/bench-reorder.ts` patch), cutting wall-clock to ~10–15 min. One
`benchmark-template.yml` owns the skeleton; the 5 `benchmark-*.yml` are thin
callers; `ci.yml` lints workflows with `actionlint`.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Scope | Trims **and** reusable-template DRY rewrite | User overrode the frame to get de-dup + single commit/retry source of truth | Plan (user) |
| K+O serialization | Shared `benchmark-reorder` group (one group per job) | Guarantees no `src/bench-reorder.ts` patch conflict; job can hold only one group | Plan |
| Build trim | Add `build:tsc`; no `dist/` cache | Free win removing dead ncc work; caching low payoff vs API latency | Plan |
| Hardening | Verify existing + add CI `actionlint` | Closes frame goal without new runtime risk; catches future YAML regressions | Plan |

## Scope

**In scope:** `build:tsc` script + 5 jobs switched to it; per-provider concurrency
groups; `benchmark-template.yml` + 5 thin callers; `actionlint` in `ci.yml`;
verifying rebase-first/env-validation hardening holds.

**Out of scope:** folding `ci.yml`/`ai-review.yml` into the template; caching
`dist/`; changing benchmark behavior/model lists/commit semantics; touching the
ncc `build`/`package` publish scripts.

## Architecture / Approach

A single reusable `benchmark-template.yml` (`on: workflow_call`) parameterizes the
skeleton via `inputs` (provider, action_target, optional base_url/models/
concurrency/paths, and booleans `auto_free`/`two_tier`/`discover_new`/`move_tag`)
plus one `BENCH_API_KEY` secret. The 5 `benchmark-*.yml` become thin `uses:`
callers carrying their cron, per-provider concurrency group, and secret mapping.
Optional inputs are forwarded as empty strings and fall back via `envOrDefault`
(`bench-entry.ts:9-11`), avoiding per-provider `env` branching. The discover/patch
and tag-move blocks are gated by `discover_new`/`move_tag` booleans.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. build:tsc | Add tsc-only build; switch 5 jobs off `ncc` | None significant — mechanical |
| 2. Concurrency | Per-provider groups; k+o share `benchmark-reorder` | Accidental overlap of k+o patch |
| 3. Template | `benchmark-template.yml` + 5 thin callers | Template input/secret wiring bugs |
| 4. CI lint | `actionlint` in CI + confirm hardening | Choosing a maintained actionlint action |

**Prerequisites:** repo secrets for all 5 providers present; ability to
`workflow_dispatch` for manual verification.
**Estimated effort:** ~1 session across 4 phases (mostly mechanical YAML + one
template).

## Open Risks & Assumptions

- `actionlint` action choice: pin a current major (e.g. `reviewdog/action-actionlint@v1`).
- Empty optional inputs rely on `bench-entry.ts` `envOrDefault` `||` fallback — verified at `bench-entry.ts:9-11`.
- Reusable-workflow + per-provider secret passing is fiddly; a single template bug
  would affect all 5 providers (the frame's noted tradeoff, accepted by user).

## Success Criteria (Summary)

- Daily runs no longer build the unused ncc bundle; wall-clock drops to ~10–15 min.
- One template owns the skeleton; 5 files are thin callers; `actionlint` guards CI.
- All 5 providers still benchmark, reorder, commit, and (k/o) patch correctly with
  no push conflicts.
