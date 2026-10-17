# SWE Score Resolver — Plan Brief

> Full plan: `context/changes/swe-score-resolver/plan.md`

## What & Why

Models discovered by the benchmark default to 0.5 SWE-bench score when they're not in the hardcoded `SWE_BENCH_SCORES` table. Many of these models have real leaderboard scores but aren't matched due to naming differences (`:free` suffix, org prefix, version variants). This script automates the resolution.

## Starting Point

- `deterministicMatch()` in `bench-entry.ts` handles basic normalization but misses `:free` suffix and org prefix differences
- `matchModelScore()` in `bench-entry.ts` has LLM fallback but only runs in NIM benchmark path
- `patchScoresTable()` in `bench-reorder.ts` handles source-file insertion
- 12 Kilo benchmark models currently stuck at 0.5

## Desired End State

Standalone CLI (`src/swe-resolver.ts`) that resolves 0.5 models to real scores and patches `SWE_BENCH_SCORES`. Run after benchmarks. Models without leaderboard entries stay at 0.5 with logged warnings.

## Key Decisions Made

| Decision | Choice | Why | Source |
|----------|--------|-----|--------|
| Integration | Standalone script run after benchmark | Reusable, testable, doesn't slow benchmark | Plan |
| Matching | Enhanced deterministic + LLM fallback | Cheap for most, accurate for rest | Plan |
| Storage | Patch `SWE_BENCH_SCORES` table | Single source of truth | Plan |
| No match | Keep 0.5 + log warning | Honest about uncertainty | Plan |

## Scope

**In scope:** Enhanced normalization, standalone resolver script, LLM fallback reuse, patching existing table

**Out of scope:** Workflow integration, separate scores file, score estimation, full semantic search

## Phases at a Glance

| Phase | What it delivers | Key risk |
|-------|-----------------|----------|
| 1. Enhanced Normalization | Strip `:free`, better org handling | May over-match and assign wrong scores |
| 2. Resolver Script | CLI that resolves + patches | Parsing SWE_BENCH_SCORES from source |
| 3. Testing | Test coverage, npm script | LLM mocking complexity |

**Prerequisites:** Leaderboard API accessible, NIM API key for LLM fallback (optional)
**Estimated effort:** ~1 session across 3 phases

## Open Risks & Assumptions

- Leaderboard API format may change (currently returns 104 models)
- Free-tier models may perform differently than paid counterparts (scores may not be identical)
- LLM fallback adds API cost — should be optional (skip with `--no-llm`)

## Success Criteria (Summary)

- Models like `nvidia/nemotron-3-super-120b-a12b:free` get resolved to 0.5373
- Models without leaderboard entries stay at 0.5 with logged warnings
- Script is idempotent (running twice doesn't duplicate entries)
