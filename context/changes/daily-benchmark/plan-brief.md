# Daily Model Benchmark & Auto-Reorder — Plan Brief

> Full plan: `context/changes/daily-benchmark/plan.md`
> PRD: `context/foundation/prd.md`

## What & Why

The NIM Code Review Action needed four improvements: (1) static model list → self-optimizing daily benchmark, (2) "NIM" branding → generic "AI Code Review" with update-in-place, (3) broken module resolution → proper ncc bundling, (4) no self-testing → action reviews its own PRs.

## Starting Point

Working action with static model list, NIM-branded comments that duplicated on each push, tsc-only build (no ncc bundle for distribution), no self-review.

## Desired End State

Action consumers always get the best model first (auto-ranked daily). PR comments are clean, generic, and update in place. The action is properly bundled for distribution. The repo eats its own dogfood.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
|----------|--------|-------------------|
| Ranking signal | SWE-bench Verified × latency penalty | Quality matters most but timeout = useless |
| Latency thresholds | 60s/120s with 1.0/0.7/0.5 multipliers | Matches real-world review UX expectations |
| Benchmark scope | Only current 7 from action.yml | Keeps workflow under 10 minutes |
| State persistence | action.yml default IS the state | No extra files, simplest possible |
| Comment update | Find by marker, PATCH existing | Prevents spam on re-pushes |
| Bundle strategy | tsc for tests/bench + ncc for action | Both workflows need their own output |
| Git strategy | Amend previous benchmark commit | Clean history, one commit reused daily |
| Tag movement | Auto-find latest v* and force-move | Works for v1, v2, etc. without hardcoding |

## Scope

**In scope:** Daily benchmark, SWE-bench ranking, latency penalty, failure replacement, generic PR comment, update-in-place, ncc bundle, self-review workflow, amend commit, tag movement

**Out of scope:** Health dashboard, A/B testing, real-diff benchmarking, historical win stats, new model auto-discovery without SWE-bench data

## Phases at a Glance

| Phase | What it delivers | Key risk |
|-------|-----------------|----------|
| 1. Ranking Engine | SWE-bench scores + latency penalty + ranking | Scores need manual updates for new models |
| 2. Benchmark Entry | Orchestrator: bench 7, replace failures | NIM API rate limits |
| 3. Workflow | Daily cron, amend, rebase, tag move | Concurrent push conflicts |
| 4. PR Comment UX | Generic header, update-in-place | Comment marker detection edge cases |
| 5. Distribution | ncc bundle + self-review | Bundle size, node version compat |

**Prerequisites:** `NIM_API_KEY` secret in repo settings
**Estimated effort:** 1 session — fully implemented

## Open Risks & Assumptions

- SWE-bench scores are manually maintained — new models need entries added
- NIM API assumed stable at 06:00 UTC daily
- If all 7 models fail, action.yml is unchanged (safe)
- `git pull --rebase` handles concurrent commits but could theoretically conflict on action.yml

## Success Criteria (Summary)

- Top model in fallback chain is always a top-3 SWE-bench scorer on NIM
- PR comments are generic, show only model used, and don't duplicate
- Action works for consumers without module resolution errors
- Benchmark runs daily without manual intervention
