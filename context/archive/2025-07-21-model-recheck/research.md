---
date: 2025-07-21T00:00:00+02:00
researcher: MiMoCode
git_commit: 80d598c242f1ce923de6ffc8f8e39303b2b669d7
branch: main
repository: pfrack/review-action
topic: "Retry/recheck mechanism for failed benchmark models + API model discovery"
tags: [research, benchmark, retry, model-chain, bench-entry, model-discovery, swe-bench]
status: complete
last_updated: 2025-07-21
last_updated_by: MiMoCode
last_updated_note: "Added API model discovery research (listModels, new model scoring, provider availability)"
---

# Research: Retry/recheck mechanism for failed benchmark models

**Date**: 2025-07-21T00:00:00+02:00
**Researcher**: MiMoCode
**Git Commit**: 80d598c242f1ce923de6ffc8f8e39303b2b669d7
**Branch**: main
**Repository**: pfrack/review-action

## Research Question

The system lacks a "check again later" mechanism. When a model fails the daily benchmark (all iterations error out), it is permanently replaced by the next-best SWE-bench candidate. A temporary outage (rate limit, server restart, transient network issue) causes permanent removal. Should we add a retry/recheck mechanism — e.g., weekly re-testing of models that previously failed?

## Summary

**The system has zero persistence of failure data.** Failed models are tracked only in a local variable (`failed: string[]`) that is discarded when the process exits. The only record of removal is indirect — the model disappears from `action.yml`. There is no mechanism to re-test previously failed models.

The most feasible solution is adding a `--recheck` flag to `bench-entry.ts` (reusing the existing `probeModel()` primitive) combined with a weekly GitHub Actions workflow. This adds ~60 lines total and requires no new state file.

## Detailed Findings

### Current Failure Flow

**Failure detection** (`src/bench-entry.ts:136-141`): A model is marked failed only when **all** benchmark iterations produce errors (`errCount === iterations`). The `withRetry` wrapper in `openai-client.ts:112` already retries transient HTTP errors (5xx, 429, network) up to 2 times with exponential backoff before the iteration is considered failed.

**Replacement logic** (`src/bench-entry.ts:149-193`): For each failed model, the system:
1. Calls `getReplacements(models)` to get SWE-bench-ranked candidates not currently active
2. Probes each candidate via `probeModel()` (cheap "Say hi" request)
3. If probe passes, runs a full benchmark on the candidate
4. If benchmark passes, swaps the candidate into the failed model's position

**No persistence** — `failed` is a local array (`bench-entry.ts:122`). No files are written recording which models failed, when, or why. The only surviving artifact is `action.yml`'s updated default values.

### Model Ordering and Persistence

**Single source of truth**: `action.yml` `default:` fields for `nim_models` (line 14-16) and `mistral_models` (lines 23-25) hold the current active model list. This is both configuration and state.

**Reorder mechanism** (`src/bench-reorder.ts:136-153`): `rankModels()` filters out dead models (`tokensPerSec > 0 || errors === 0`) and sorts survivors by effective score (SWE-bench score × latency penalty). The ranked list replaces `action.yml` defaults.

**Git history is compressed**: The benchmark workflow amends existing commits and force-pushes (`benchmark.yml:62-68`), so intermediate states are overwritten. Historical model lists are largely lost.

**Runtime re-sorting**: `buildCombinedChain()` (`src/model-chain.ts:42-46`) re-sorts all models by static SWE-bench score at runtime, meaning the `action.yml` order primarily determines *which* models are included, not their runtime fallback order.

### Existing Retry Infrastructure

| Component | Location | Reusability for Recheck |
|-----------|----------|------------------------|
| `withRetry()` | `src/retry.ts:10-29` | Handles per-request retries (5xx, 429, network). Already wired into every API call. |
| `probeModel()` | `src/openai-client.ts:228-238` | **Key reusable primitive.** Sends minimal "Say hi" request, returns boolean. Already uses `withRetry()` internally. |
| `--probe` mode | `src/bench-entry.ts:102-106` | Existing mode that probes a list of models and prints ok/FAIL. Easy to extend. |
| `probe()` function | `src/bench-entry.ts:56-70` | Iterates models, calls `probeModel()`, prints results. |
| `getReplacements()` | `src/bench-entry.ts:48-54` | Returns SWE-bench-ranked candidates not in the active list. |

### Design Options Evaluated

#### Option A: Separate `retry.yml` workflow
- Weekly schedule, tests models not in action.yml
- Pro: Clean separation, easy to add
- Con: Needs a source of truth for "which models were removed" — without a state file, would need to compare action.yml against SWE_BENCH_SCORES (basically what getReplacements already does)

#### Option B: `failed-models.json` state file with TTL
- Track when each model failed, re-test after cooldown
- Pro: Precise failure history
- Con: Over-engineered — requires JSON parsing, TTL logic, cleanup, risk of merge conflicts with daily auto-commits

#### Option C: `--recheck` flag + weekly workflow (RECOMMENDED)
- Add `--recheck` flag to bench-entry.ts, weekly workflow reads a model list
- Pro: Minimal code change (~15-20 lines in bench-entry.ts), reuses probeModel() + runBenchmark()
- Con: Needs an external source for the recheck list (solved by having daily benchmark write removed models to a file)

#### Option D: Git history parsing
- Diff consecutive action.yml versions to find removed models
- Pro: No new state file
- Con: Fragile, slow in CI, does not distinguish "removed due to failure" from "outranked by better model"

### Recommended Approach: Option C (with daily-benchmark integration)

**Part 1: Track removed models** (~10 lines in `bench-entry.ts`)

In the failure replacement section (~line 189, when a model is swapped out or no replacement found), write removed model IDs to a file:

```typescript
// After the replacement loop, write removed models
if (removedModels.length > 0) {
  const removedPath = envOrDefault('REMOVED_MODELS_PATH', 'removed-models.txt');
  const existing = existsSync(removedPath) ? readFileSync(removedPath, 'utf-8') : '';
  const existingSet = new Set(existing.split('\n').filter(Boolean));
  for (const m of removedModels) {
    if (!existingSet.has(m)) {
      appendFileSync(removedPath, m + '\n');
    }
  }
}
```

**Part 2: Add `--recheck` flag** (~15-20 lines in `bench-entry.ts`)

After the existing `--probe` block (line 106):

```typescript
if (process.argv.includes('--recheck')) {
  const recheckModels = splitCSV(process.env.NIM_RECHECK_MODELS || '');
  if (recheckModels.length === 0) {
    process.stderr.write('No models to recheck (NIM_RECHECK_MODELS is empty)\n');
    return;
  }
  // Probe first, then benchmark survivors
  const survivors: string[] = [];
  for (const model of recheckModels) {
    process.stderr.write(`  Probing ${model} ...`);
    const ok = await client.probeModel(model);
    if (!ok) {
      process.stderr.write(' still down\n');
      continue;
    }
    process.stderr.write(' back! benchmarking...');
    const result = await runBenchmark(client, model, { prompt: benchPrompt, iterations, temperature: 0.2, maxTokens: 1024 });
    const errCount = result.iterations.filter(it => it.error !== null).length;
    if (errCount === iterations) {
      process.stderr.write(' FAILED\n');
      continue;
    }
    process.stderr.write(' ok\n');
    survivors.push(model);
    results.push(result);
  }
  // Remove rechecked survivors from removed-models.txt
  // Output table for bench-reorder.js
}
```

**Part 3: Weekly `recheck.yml` workflow** (~40-50 lines)

```yaml
name: Weekly Model Recheck

on:
  schedule:
    - cron: '0 6 * * 1'  # Monday 6 AM UTC
  workflow_dispatch:
    inputs:
      models:
        description: 'Comma-separated models to recheck'
        required: false

permissions:
  contents: write

jobs:
  recheck-nim:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci && npm run build
      - name: Determine models to recheck
        id: models
        run: |
          if [ -n "${{ github.event.inputs.models }}" ]; then
            echo "list=${{ github.event.inputs.models }}" >> $GITHUB_OUTPUT
          elif [ -f removed-models.txt ]; then
            MODELS=$(paste -sd, removed-models.txt)
            echo "list=$MODELS" >> $GITHUB_OUTPUT
          else
            echo "list=" >> $GITHUB_OUTPUT
          fi
      - name: Recheck models
        if: steps.models.outputs.list != ''
        env:
          NIM_API_KEY: ${{ secrets.NIM_API_KEY }}
          NIM_RECHECK_MODELS: ${{ steps.models.outputs.list }}
          NIM_BENCH_ITERATIONS: '1'
        run: node dist/src/bench-entry.js --recheck > recheck-output.txt
      - name: Reorder with survivors
        if: steps.models.outputs.list != ''
        env:
          ACTION_PATH: action.yml
          ACTION_TARGET: nim_models
        run: |
          grep '^|' recheck-output.txt > table.txt || true
          if [ -s table.txt ]; then
            node dist/src/bench-reorder.js < table.txt
          fi
      - name: Commit survivors
        if: steps.models.outputs.list != ''
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add action.yml removed-models.txt
          if ! git diff --cached --quiet; then
            git commit -m "chore: recheck recovered models [skip ci]"
            git push
          fi
```

**Part 4: Clean up removed-models.txt** — Models that are re-checked and fail again stay in the file. Models that succeed are removed from the file during the recheck run. Models older than N days could be pruned, but a simple "keep all" approach works since the file will be small (only models that have failed at least once).

### Total Effort

| Component | Lines | Complexity |
|-----------|-------|------------|
| Track removed models in bench-entry.ts | ~10 | Low |
| `--recheck` flag in bench-entry.ts | ~20 | Low |
| `recheck.yml` workflow | ~50 | Low |
| **Total** | **~80** | **Low** |

### Risk Assessment

- **False positives**: A model that fails recheck is simply not re-added. No harm.
- **State file bloat**: `removed-models.txt` grows slowly (only models that fail completely). At most ~37 entries (all SWE_BENCH_SCORES minus 7 active). Could be pruned if needed.
- **Race conditions**: The weekly recheck and daily benchmark could both modify `action.yml` on the same day. The existing concurrency group (`benchmark-commit`) prevents this for the daily benchmark. The recheck workflow should use a different concurrency group or run on a different day.
- **Amend/force-push**: The recheck commit should NOT amend the daily benchmark commit — it should create a new commit with a distinct message.

## Code References

- `src/bench-entry.ts:33` — TARGET_COUNT = 7 (active model count)
- `src/bench-entry.ts:48-54` — `getReplacements()` finds replacement candidates
- `src/bench-entry.ts:56-70` — `probe()` function iterates and probes models
- `src/bench-entry.ts:83-100` — Model list initialization from env or action.yml
- `src/bench-entry.ts:102-106` — Existing `--probe` mode
- `src/bench-entry.ts:122` — `failed` local variable (no persistence)
- `src/bench-entry.ts:136-147` — Failure detection (allFailed = errCount === iterations)
- `src/bench-entry.ts:149-193` — Replacement loop
- `src/bench-reorder.ts:58-104` — SWE_BENCH_SCORES constant (44 models)
- `src/bench-reorder.ts:136-153` — `rankModels()` filters dead models
- `src/bench-reorder.ts:171-200` — `updateActionYml()` writes to action.yml
- `src/model-chain.ts:26-53` — `buildCombinedChain()` runtime fallback
- `src/openai-client.ts:228-238` — `probeModel()` reusable probe primitive
- `src/retry.ts:10-29` — `withRetry()` exponential backoff
- `.github/workflows/benchmark.yml:54-82` — Daily benchmark commit logic
- `.github/workflows/benchmark.yml:62-68` — Amend/force-push pattern

## Architecture Insights

1. **Two-layer ordering**: action.yml determines *which* models are included; buildCombinedChain() re-sorts by SWE-bench score for runtime fallback order. The benchmark's latency-based ranking influences action.yml but not runtime order.

2. **Replace-in-place semantics**: bench-entry.ts swaps failed models at their original index (line 184: `models[idx] = candidate`), preserving list length and position. This means a replacement model inherits the failed model's position in the chain.

3. **probeModel() as the right abstraction**: Already cheap (~8 tokens), already uses withRetry(), already used for candidate validation. Any recheck mechanism should use it as the first gate.

4. **State is action.yml**: The system has no separate state layer. Any new state (like removed-models.txt) must be compatible with the existing commit-amend-and-force-push pattern.

## API Model Discovery (NEW)

### `listModels()` — Dead Code Waiting to Be Used

`src/openai-client.ts:240-255` defines a `listModels()` method that fetches all available models from any OpenAI-compatible `/models` endpoint. **It is never called anywhere in the codebase.** It returns a flat array of model ID strings.

This is the key primitive for auto-discovering new models from NIM and Mistral.

### Unknown Model Handling Gap

`getSweBenchScore()` (`src/bench-reorder.ts:109-111`) returns **0.5** for any model not in `SWE_BENCH_SCORES`. This means:

- **New model from NIM** (e.g., `vendor/new-model-v1`) → gets score 0.5 → ranked below ALL 36 known models (lowest known is 0.550)
- **Can never move up** in `rankModels()` unless it gets a real score
- **In `buildCombinedChain()`** → placed at the bottom of the fallback chain

The hardcoded table has **37 models** (29 NIM + 8 Mistral aliases). It is **entirely manually maintained** — no script, no automation, no scraping.

### Model Availability Risk

Several models in `SWE_BENCH_SCORES` may be deprecated/removed from NIM:

| Risk | Models | Reason |
|------|--------|--------|
| **High** | `mistralai/mistral-large`, `mistralai/mistral-large-2-instruct`, `nvidia/nemotron-4-340b-instruct` | Superseded by newer variants |
| **Medium** | `nvidia/llama-3.1-nemotron-70b-instruct`, `meta/llama-3.1-70b-instruct`, `databricks/dbrx-instruct` | Older generation, availability varies |
| **Low** | All DeepSeek V4, MiniMax, Moonshot, Qwen 3.5 | Current generation |

When a model is removed from NIM, `probeModel()` returns `false` (HTTP 404/400 is caught and swallowed). The replacement loop skips it. But there's no record of *why* it failed — was it removed from the provider, or just a transient outage?

### The Missing Piece: Provider vs. Transient Failure Distinction

Currently there is **no way to distinguish**:
1. Model removed from NIM/Mistral permanently → should NOT be retried
2. Model had transient outage → SHOULD be retried

To make this distinction, the system needs to:
1. Call `listModels()` to get the current provider catalog
2. If a failed model is NOT in the catalog → it's removed, don't retry
3. If a failed model IS in the catalog → it's transient, retry tomorrow

### Recommended Enhancement: Provider Catalog Check

**Add to `bench-entry.ts`** (~15 lines):

```typescript
// At the start of main(), after creating the client:
let availableModels: Set<string> | null = null;
try {
  const models = await client.listModels();
  availableModels = new Set(models);
  process.stderr.write(`Provider has ${models.length} models available\n`);
} catch (err) {
  process.stderr.write(`Warning: could not fetch model list: ${err}\n`);
}

// In the failure detection section (after line 147):
if (allFailed) {
  // Check if model still exists on provider
  if (availableModels && !availableModels.has(model)) {
    process.stderr.write(`  ${model} removed from provider (not in /models), skipping retry\n`);
    // Don't add to removed-models.txt — it's permanently gone
  } else {
    process.stderr.write(`  ${model} failed but may be transient, adding to removed-models.txt\n`);
    removedModels.push(model);
  }
  failed.push(model);
}
```

**Add to `removed-models.txt` logic**: Only write models that are still in the provider catalog. Models removed from the provider are permanently dropped.

### Auto-Discovery of New Models

For new models discovered via `listModels()` that aren't in `SWE_BENCH_SCORES`:

**Option 1: Skip unknown models** (current behavior)
- New models get score 0.5, ranked at bottom
- Safe but misses potential high-performers

**Option 2: Probe + provisional score** (~20 lines in bench-entry.ts)
```typescript
// After listModels(), find models not in SWE_BENCH_SCORES
const knownModels = new Set(Object.keys(SWE_BENCH_SCORES));
const newModels = availableModels.filter(m => !knownModels.has(m));

// Probe each new model
for (const model of newModels) {
  if (await client.probeModel(model)) {
    // Assign provisional score = 0.5 (neutral) and include in benchmark
    process.stderr.write(`New model discovered: ${model} (provisional score 0.5)\n`);
    // Add to models list for benchmarking
  }
}
```

**Option 3: Scrape SWE-bench scores** (full automation, ~50 lines)
- Scrape `llm-stats.com/benchmarks/swe-bench-verified` for new scores
- Auto-update `SWE_BENCH_SCORES` in source code
- Complex, fragile, requires HTML parsing

**Recommendation**: Start with Option 2. New models get a provisional 0.5 score, are benchmarked daily, and can slowly climb the ranking as they prove themselves. If a model consistently performs well, a human can add its real SWE-bench score to the table.

### Updated Daily Benchmark Flow

```
1. listModels() → get provider catalog
2. Read current models from action.yml
3. Benchmark current models
4. For each failed model:
   a. Check if in provider catalog
   b. If YES → transient failure → write to removed-models.txt (retry tomorrow)
   c. If NO → permanently removed → skip, don't retry
5. Get replacements from SWE_BENCH_SCORES
6. For new models from listModels() not in SWE_BENCH_SCORES:
   a. Probe → if alive, add to benchmark with provisional score 0.5
7. Reorder by effective score → update action.yml
8. Read removed-models.txt → probe each → if alive, benchmark → reinsert survivors
```

### Updated Effort Estimate

| Component | Lines | Complexity |
|-----------|-------|------------|
| Track removed models in bench-entry.ts | ~10 | Low |
| Daily recheck of removed-models.txt | ~20 | Low |
| Provider catalog check (listModels) | ~15 | Low |
| New model discovery (provisional score) | ~20 | Low |
| Workflow updates (benchmark.yml) | ~5 | Low |
| **Total** | **~70** | **Low** |

## Open Questions

1. **Should recheck do a full benchmark or just a probe?** A probe confirms the model is reachable; a benchmark confirms it performs well. Recommendation: probe first, full benchmark only if probe succeeds.

2. **Should removed-models.txt be committed or use GitHub Actions cache?** Committing is consistent with the existing pattern (action.yml is committed). Recommendation: commit.

3. **How should the daily benchmark interact with removed-models.txt?** Options: (a) daily benchmark appends to the file, (b) daily benchmark overwrites with current failures, (c) daily benchmark ignores the file. Recommendation: (a) append, since the recheck removes recovered models.

4. **Should new models from listModels() be auto-included?** Risk: a bad model could degrade review quality. Recommendation: probe first, benchmark second, only include if it passes both gates. Keep at bottom of ranking initially.

5. **How to handle listModels() failure?** The NIM /models endpoint might not be available or might return incomplete lists. Recommendation: make it optional — if it fails, fall back to the hardcoded SWE_BENCH_SCORES (current behavior).
