# Daily Model Recheck + Auto-Scoring — Plan Brief

> Full plan: `context/changes/model-recheck/plan.md`
> Research: `context/changes/model-recheck/research.md`

## What & Why

When a model fails the daily benchmark, it's permanently replaced with no mechanism to retry. A temporary outage (rate limit, restart) causes permanent removal. Additionally, new models added to NIM/Mistral aren't discovered or scored automatically — the hardcoded `SWE_BENCH_SCORES` table requires manual updates.

## Starting Point

The daily benchmark (`benchmark.yml`) runs `bench-entry.ts` which benchmarks 7 NIM models, replaces failures with next-best SWE-bench candidates, then `bench-reorder.ts` ranks survivors and writes to `action.yml`. `listModels()` exists in `openai-client.ts` but is dead code. No failure persistence, no retry, no auto-discovery.

## Desired End State

- Failed models that are still on the provider → saved to `removed-models.txt`, retried next day automatically
- Failed models removed from provider → permanently dropped (no wasted retries)
- Models that were down yesterday but recovered → probed, benchmarked, reinserted into `action.yml`
- New models discovered via `listModels()` → scored by fetching SWE-bench API + LLM fuzzy matching, benchmarked with real scores
- `removed-models.txt` self-cleans: models no longer on provider are purged

## Key Decisions Made

| Decision | Choice | Why | Source |
|----------|--------|-----|--------|
| Recheck frequency | Daily (same workflow) | Faster recovery from outages, minimal overhead (~5-30s) | Plan |
| Failure classification | Provider catalog via `listModels()` | Distinguishes outage from removal, avoids useless retries | Plan |
| State persistence | `removed-models.txt` committed to git | Consistent with action.yml pattern, auditable | Plan |
| Cleanup mechanism | Remove models not in `/models` catalog | Automatic, no TTL/date logic needed | Plan |
| New model scoring | Fetch API JSON → LLM prompt for fuzzy matching | Zero scraping code, LLM handles NIM↔API ID mapping | Plan |
| Score persistence | Ephemeral (per-run only) | Hardcoded table remains fallback, no source code mutation | Plan |

## Scope

**In scope:**
- `bench-entry.ts`: failure tracking, provider catalog check, removed-models recheck, new model discovery
- `bench-reorder.ts`: `fetchSweBenchScores()`, `getSweBenchScore()` with fetched scores, LLM matching helper
- `benchmark.yml`: commit `removed-models.txt`, separate file for Mistral

**Out of scope:**
- Separate `recheck.yml` workflow
- HTML scraping (API returns clean JSON)
- SWE-bench score caching across runs
- Changes to `model-chain.ts` or `review.ts`
- TTL/date-based cleanup

## Architecture / Approach

All changes fit within the existing daily benchmark flow. The sequence becomes:

```
1. listModels() → provider catalog
2. Cleanup removed-models.txt (purge models不在 catalog)
3. Benchmark current models (existing flow)
4. Classify failures → write transient ones to removed-models.txt
5. Recheck removed-models.txt → probe → benchmark survivors → reinsert
6. Discover new models from listModels() → fetch SWE-bench API → LLM match → benchmark
7. Reorder all results → update action.yml
8. Commit action.yml + removed-models.txt
```

## Phases at a Glance

| Phase | What it delivers | Key risk |
|-------|-----------------|----------|
| 1. Track + classify failures | `removed-models.txt` with provider-aware classification | `listModels()` might not return all models |
| 2. Daily recheck | Survivors reinserted into action.yml | Recheck adds latency to daily run |
| 3. Auto-scoring | New models get real SWE-bench scores via API + LLM | LLM matching might return wrong score |
| 4. Workflow updates | `removed-models.txt` persisted in git | Amend pattern might conflict |

**Prerequisites:** None — builds on existing infrastructure
**Estimated effort:** ~4 files modified, ~150 lines added, 4 phases

## Open Risks & Assumptions

- `listModels()` might not return all available models (NIM API limitation) — graceful degradation handles this
- LLM might hallucinate SWE-bench score for unknown model — score is provisional, validated by actual benchmark
- API endpoint (`api.zeroeval.com`) might change or go down — `fetchSweBenchScores()` returns empty array on failure, falls back to 0.5
- `removed-models.txt` git commits might conflict with amend/force-push pattern — mitigated by committing in the same step as action.yml

## Success Criteria (Summary)

- A model that fails due to transient outage is automatically retried and reinserted the next day
- A model removed from NIM is permanently dropped after one check (no wasted retries)
- New models from NIM/Mistral get real SWE-bench scores without manual table updates
- Daily benchmark runtime increases by less than 30 seconds
