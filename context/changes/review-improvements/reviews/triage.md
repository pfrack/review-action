# Triage: review-improvements — Fix Status

## Resolution Status

| Priority | Issue | Status | Resolution |
|----------|-------|--------|------------|
| **P0** | Custom rules never passed to `buildSystemPrompt` | ✅ Fixed | Rules parsed, validated, and passed to `buildSystemPrompt` in `index.ts:79-87,174,251` |
| **P0** | Metrics never collected — `metrics.ts` is dead code | ✅ Fixed | Metrics collected and written to `GITHUB_STEP_SUMMARY` in `index.ts:425-441` |
| **P0** | Inline comments never used — `github-review.ts` is dead code | ✅ Fixed | `createReview` used for inline comments, `postComment` used as fallback when >50 findings |
| **P1** | `probeModels` never called — sequential fallback only | ✅ Fixed | `probeModels` called before review loop, fastest model moved to front of chain |
| **P1** | `revalidateFindings` never called + no `revalidate_findings` input | ✅ Fixed | `revalidate_findings` input added to `action.yml`, `revalidateFindings` called when enabled |
| **P1** | File batching never used — `batchFiles`/`mergeFindings` dead code | ✅ Fixed | `batchFiles` + `mergeFindings` integrated; files split into batches of 50 when count > threshold |
| **P1** | `chunkDiff` never called — large single-file diffs not chunked | ⚠️ Deferred | `chunkDiff` available but not integrated; requires restructure beyond initial triage scope |
| **P2** | `BASE_SYSTEM_PROMPT` in `review.ts` is dead code | ⚠️ Deferred | Cleanup not critical — not harmful but should be removed eventually |
| **P2** | No integration tests verifying `index.ts` uses new modules | ⚠️ Deferred | Would require extracting `runModelChainForBatch` to a testable module |

## What Was Fixed

### 1. Custom Rules (Phase 5) — `index.ts:79-87`
- Parse `config.customRules` via `parseRules()`
- Validate via `validateRules()`, warn on invalid
- Pass `rules` to both `buildSystemPrompt()` calls (lines 174 and 251)

### 2. Metrics (Phase 6) — `index.ts:425-441`
- Collect `ReviewMetrics` with real timing, counts, and batch metadata
- Write formatted metrics to `$GITHUB_STEP_SUMMARY` if env var is set
- `batch_count` reflects actual batch usage

### 3. Inline Comments (Phase 4) — `index.ts:365-423`
- Delete existing reviews/comments before posting (find-and-replace pattern)
- Use `createReview` with inline comments when `findings.length <= 50`
- Fall back to `postComment` for large reviews (>50 findings)

### 4. LLM Re-validation (Phase 2) — `index.ts:288-294`
- `revalidateFindings` called when `config.revalidateFindings` is true
- Validation drop count tracked in metrics

### 5. File Batching (Phase 3) — `index.ts:168-336`
- `batchFiles` splits files into batches of 50 when file count > threshold
- `runModelChainForBatch` processes each batch through the model chain
- `mergeFindings` deduplicates results by file+line across batches
- Single pass used when file count <= batch size (no overhead change)

### 6. Parallel Model Probing (Phase 3) — `index.ts:148-161`
- `probeModels` runs all models in parallel with 10s timeout each
- Fastest responding model moved to front of chain
- Graceful fallback to original chain on probe failure

### 7. Event Interface — `event.ts`
- Added `head.sha` to `GitHubEvent` for commit SHA in Review API

### 8. Action Inputs — `action.yml`
- Added `revalidate_findings` input (default: false)

### 9. Config Loading — `review.ts`
- Added `revalidateFindings: boolean` to `Config` interface
- Loaded from `revalidate_findings` action input

## Still Outstanding

1. **Diff chunking** (`chunkDiff`) — Available but not integrated into batch flow. Would benefit large single-file diffs that exceed token limits.
2. **`BASE_SYSTEM_PROMPT` cleanup** — Dead code in `review.ts`. Low priority.
3. **Integration tests** — `runModelChainForBatch` is a closure inside `run()`, making it hard to test independently. Would benefit from extraction to a separate module.
4. **`mergeFindings` type safety** — Uses `[key: string]: unknown` wide type; casts needed at call site. Works correctly but loses type safety.
