# SWE List Order — Plan Brief

> Full plan: `context/changes/swe-list-order/plan.md`

## What & Why

Hybrid model management: keep explicit per-provider lists while auto-discovering new models from provider catalogs. New models are benchmarked alongside known ones and merged into a two-tier ordered list — known models (by SWE score) first, then new models (by latency) at 0.5 until you manually update their score.

## Starting Point

- `SWE_BENCH_SCORES` in `src/bench-reorder.ts` maps model IDs to scores (default 0.5)
- `model-chain.ts` sorts by SWE score descending
- `bench-entry.ts` can discover new models and patch the scores table
- Benchmark workflow runs daily per-provider, commits to main

## Desired End State

Daily benchmark that: reads yesterday's list → discovers new free models (OR+Kilo) → benchmarks both → orders (known by SWE, new by latency at 0.5) → updates action.yml → adds new models to SWE table → commits. You later update SWE scores for promising new models.

## Key Decisions Made

| Decision | Choice | Why | Source |
|----------|--------|-----|--------|
| Ranking | Two-tier separation | Known models always prioritized; new ones prove themselves first | Plan |
| Discovery | Catalog + history JSON | Detect both new additions and removals | Plan |
| Scope | Phased: OR+Kilo first | Validates on providers that need it most | Plan |
| Entry | Auto-add at 0.5 | Fast; you edit scores manually later | Plan |
| History | Simple active list JSON | No dates needed; only current state matters | Plan |
| Removed | Remove from list, keep score | Score preserved for potential re-addition | Plan |

## Scope

**In scope:**
- Model history tracking (JSON per provider)
- Auto-discovery for OpenRouter + Kilo (Phase 1)
- Two-tier ranking (known by SWE, new by latency)
- Daily benchmark integration

**Out of scope:**
- Auto-discovery for NIM/Mistral/Groq (Phase 2)
- Combined effective score (SWE × latency)
- PR-based approval workflow
- Removal dates or temporal history

## Architecture / Approach

```
Provider Catalog → Discover New Models → Combine with Known List
    → Benchmark All → Two-Tier Rank → Update action.yml + SWE_TABLE
    → Commit → Next Day: Updated Scores Reorder Known Tier
```

## Phases at a Glance

| Phase | What it delivers | Key risk |
|-------|-----------------|----------|
| 1. History Tracking | JSON model per provider | Schema design |
| 2. Auto-Discovery (OR+Kilo) | Query catalog, find new models | API reliability |
| 3. Benchmark Integration | Two-tier ranking function | Correct sort order |
| 4. List Generation | Updated action.yml + SWE_TABLE | Source file patching |
| 5. Workflow Automation | Daily auto-discover + commit | Race conditions on commit |

**Prerequisites:** MERGED PR #18 (free-only filter, dynamic fetching, benchmark fixes)
**Estimated effort:** ~2-3 sessions across 5 phases

## Open Risks & Assumptions

- Provider `/models` API rate limits could slow discovery
- Two-tier ranking means new models can't bubble up until user edits SWE score (by design)
- Commit race conditions already handled with `git pull --rebase` + abort on conflict

## Success Criteria (Summary)

1. Daily benchmark discovers new OR/Kilo free models and adds them at 0.5
2. action.yml reordered: known models by SWE, then new models by latency
3. User can update SWE score → model ranks higher next run
