# Daily Model Benchmark & Auto-Reorder — Plan Brief

> Full plan: `context/changes/daily-benchmark/plan.md`
> PRD: `context/foundation/prd.md`
> Shape notes: `context/foundation/shape-notes.md`

## What & Why

The NIM Code Review Action's model fallback chain is static and hand-curated. Models degrade, new ones appear, and there's no mechanism to keep the order optimal. This plan adds a daily benchmark that validates the current top 7 models, ranks them by code quality (SWE-bench) discounted by latency, replaces failures, and commits the updated order.

## Starting Point

The action already has a `NimClient` with chat/stream/probe capabilities, a `bench.ts` module with `runBenchmark()` and table formatting, and a working test suite (67+ tests). The model list in `action.yml` is the single source of truth for the fallback chain order.

## Desired End State

The `action.yml` default model list is always ordered by effective quality score. A daily workflow keeps it fresh — users always get the best available model tried first without anyone manually monitoring NIM availability or performance.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
|----------|--------|-------------------|
| Ranking algorithm | SWE-bench × latency penalty | Quality matters most, but a slow model is useless in production |
| Latency thresholds | 60s clean, 60-120s linear, >120s heavy | Matches real-world timeout expectations for PR review |
| Benchmark scope | Only current 7, not all models | Keeps workflow under 10 minutes |
| State persistence | action.yml default IS the state | No extra files needed; simplest possible |
| Model discovery | Replace failures from SWE-bench list | Unknown models aren't trusted |
| Historical tracking | None needed | SWE-bench + today's latency is sufficient signal |

## Scope

**In scope:**
- Daily benchmark workflow (cron + manual trigger)
- SWE-bench score mapping for NIM models
- Latency penalty function
- Failed model replacement from ranked list
- Auto-commit of updated action.yml

**Out of scope:**
- Model health dashboard
- A/B testing on real PRs
- Historical win tracking
- New model auto-discovery without SWE-bench data

## Architecture / Approach

Three modules in a pipeline: `bench-entry.ts` (orchestrates benchmark of current 7 models, replaces failures) → stdout markdown table → `bench-reorder.ts` (parses table, ranks by SWE-bench × latency, updates action.yml). A GitHub Actions workflow glues them together with a cron schedule and auto-commit.

## Phases at a Glance

| Phase | What it delivers | Key risk |
|-------|-----------------|----------|
| 1. SWE-bench Scores & Ranking | Core ranking logic + tests | SWE-bench scores need periodic manual updates |
| 2. Benchmark Entry Point | Orchestrator that benchmarks + replaces failures | NIM API rate limits during benchmark |
| 3. Workflow & Integration | Daily cron, auto-commit | Workflow permissions or secret misconfiguration |

**Prerequisites:** `NIM_API_KEY` secret set in repository settings
**Estimated effort:** ~1 session, already largely implemented

## Open Risks & Assumptions

- SWE-bench scores are manually maintained — new models need score entries added
- NIM API availability during benchmark window (06:00 UTC) assumed stable
- If all 7 models fail simultaneously, action.yml is left unchanged (safe fallback)

## Success Criteria (Summary)

- Top model in fallback chain is always a top-3 SWE-bench scorer available on NIM
- Failed models replaced within 24 hours automatically
- No manual intervention needed for model rotation
