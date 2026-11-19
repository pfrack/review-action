# SWE List Order - Hybrid Model Management Implementation Plan

## Overview

Implement a hybrid model management system that maintains explicit per-provider model lists while auto-discovering new models from provider catalogs. New models are benchmarked alongside known ones and merged into a two-tier ordered list: known models (sorted by SWE-bench score) come first, then new models (sorted by latency).

## Current State Analysis

- **SWE_BENCH_SCORES** (`src/bench-reorder.ts:136-202`): Hardcoded table mapping model IDs to scores. Unknown models default to 0.5.
- **getSweBenchScore()** (`src/bench-reorder.ts:208-210`): Returns score from table or 0.5 default.
- **model-chain.ts:76-80**: Sorts provider models by SWE score descending.
- **bench-entry.ts**: Benchmarks specified models. Has `--discover-new` and `--patch-scores` modes.
- **action.yml**: Contains hardcoded model lists per provider (nim_models, mistral_models, groq_models, openrouter_models, kilocode_models).
- **config.ts**: `loadConfig()` reads model lists from action.yml inputs. Now async — fetches provider catalog when list is empty.

### Key Discoveries:
- SWE_BENCH_SCORES already has many free-tier models at 0.5 (`src/bench-reorder.ts:185-201`)
- `getSweBenchScore()` defaults to 0.5 for unknown models
- Benchmark workflow (`.github/workflows/benchmark.yml`) has per-provider jobs that update action.yml
- `patchScoresTable()` (`src/bench-reorder.ts`) can insert new entries into SWE_BENCH_SCORES
- Free models on OR/Kilo identified by "free" in name (case-insensitive)

## Desired End State

A daily benchmark that:
1. Reads yesterday's model list from action.yml
2. Discovers new free models from provider catalog (OR + Kilo only in Phase 1)
3. Benchmarks all models (known + new)
4. Orders them: known models by SWE score, then new models at 0.5 by latency
5. Updates action.yml with the merged list
6. Adds new models to SWE_BENCH_SCORES at 0.5 (user updates manually later)
7. Tracks active models per provider in a JSON file

### Key Discoveries:
- Two-tier ranking preserves stability while allowing new models to enter
- SWE_BENCH_SCORES at 0.5 default means new models rank last among known models
- History tracking needs only active list (no dates, no removal history)

## What We're NOT Doing

- NOT implementing combined effective score (SWE × latency) — user chose two-tier
- NOT tracking removal dates or history timestamps
- NOT auto-removing models that fail benchmark (only remove if gone from catalog)
- NOT adding NIM/Mistral/Groq auto-discovery in Phase 1
- NOT implementing approval workflow (PR-based) — auto-add at 0.5

## Implementation Approach

Phase 1 establishes the data model (history JSON), Phase 2 implements discovery for OR+Kilo, Phase 3 integrates with benchmark, Phase 4 generates the ordered list, Phase 5 automates the daily workflow.

## Critical Implementation Details

- **Two-tier ranking**: Must sort known models (in SWE_BENCH_SCORES) by score first, then new models by latency. This preserves stability — a new model can't outrank a known one until user gives it a score.
- **SWE_BENCH_SCORES mutation**: The table is a `const` in source. Patching requires source file editing (regex insertion).
- **Provider catalog filtering**: OR + Kilo filter for "free" in name. Others use curated lists only.
- **Race condition**: Multiple benchmark jobs commit to main. Use `git pull --rebase` with conflict abort (already implemented).

---

## Phase 1: Model History Tracking

### Overview

Create a simple JSON file per provider tracking active models. This enables detection of new models (in catalog but not in history) and removed models (in history but not in catalog).

### Changes Required:

#### 1. Create model history JSON schema

**File**: `src/model-history.ts` (new file)

**Intent**: Define and manage per-provider model history. Track which models are currently active to detect additions and removals.

**Contract**:
```typescript
interface ProviderHistory {
  models: string[]  // currently active models
}

interface ModelHistory {
  [provider: string]: ProviderHistory
}

export function loadHistory(path?: string): ModelHistory
export function saveHistory(history: ModelHistory, path?: string): void
export function detectNewModels(history: ModelHistory, provider: string, currentModels: string[]): string[]
export function detectRemovedModels(history: ModelHistory, provider: string, currentModels: string[]): string[]
export function updateHistory(history: ModelHistory, provider: string, activeModels: string[]): ModelHistory
```

### Success Criteria:

#### Automated Verification:
- Unit tests pass: `npm test`
- Type checking passes: `npm run build`

#### Manual Verification:
- History file loads/saves correctly
- New model detection works: model in catalog but not in history → "new"
- Removed model detection works: model in history but not in catalog → "removed"

---

## Phase 2: Auto-Discovery for OpenRouter + Kilo

### Overview

Implement provider catalog querying for OR and Kilo. Discovers free-tier models and compares against history to find new additions.

### Changes Required:

#### 1. Extend bench-entry.ts for hybrid discovery

**File**: `src/bench-entry.ts`

**Intent**: When `BENCH_AUTO_FREE=true`, read existing models from action.yml, discover all free models from provider catalog, and benchmark both groups (known + new).

**Contract**:
- Read existing models from `action.yml` for the target provider
- Query provider `/models` endpoint
- Filter for models containing "free" (case-insensitive)
- Combine: existing models first (preserving order), then append new models not in existing list
- Output combined list for benchmarking

#### 2. Add history tracking to benchmark

**File**: `src/bench-entry.ts`

**Intent**: After benchmarking, update the model history JSON with current active models for the provider.

**Contract**:
- Read history JSON
- For benchmarked provider: update `models` array with all active models (from catalog)
- Save history JSON
- Output new/removed models to stderr for logging

### Success Criteria:

#### Automated Verification:
- Unit tests pass: `npm test`
- Type checking passes: `npm run build`

#### Manual Verification:
- Running with `BENCH_AUTO_FREE=true` on OR discovers free models
- New models (not in action.yml) are appended to benchmark list
- History JSON is updated with current active models

---

## Phase 3: Benchmark Integration

### Overview

Integrate the two-tier ranking into the benchmark output. Known models get their SWE score; new models get 0.5. Output is ordered: known by SWE desc, then new by latency asc.

### Changes Required:

#### 1. Add two-tier ranking to bench-reorder.ts

**File**: `src/bench-reorder.ts`

**Intent**: Add a new ranking mode that separates known models (with SWE scores) from new models (at 0.5), then sorts each tier differently.

**Contract**:
```typescript
export function rankModelsTwoTier(
  rows: ParsedRow[],
  knownModels: Set<string>,
  latencies?: Record<string, number>,
  fetchedScores?: Map<string, number>,
): string[] {
  // Tier 1: known models sorted by SWE score (desc), latency as tiebreaker
  // Tier 2: new models sorted by latency (asc)
  return [...knownSorted, ...newSorted]
}
```

### Success Criteria:

#### Automated Verification:
- Unit tests pass: `npm test`
- Type checking passes: `npm run build`

#### Manual Verification:
- Known models always rank above new models
- Within known tier: higher SWE score ranks first
- Within new tier: lower latency ranks first

---

## Phase 4: List Generation

### Overview

Generate the merged action.yml list and update SWE_BENCH_SCORES with new models at 0.5.

### Changes Required:

#### 1. Update bench-reorder.ts to output two-tier ordered list

**File**: `src/bench-reorder.ts`

**Intent**: After ranking, output the ordered list. Update action.yml with this list. Add new models to SWE_BENCH_SCORES.

**Contract**:
- `updateActionYml()` already updates action.yml — use it with the two-tier ordered list
- `patchScoresTable()` already adds new entries at 0.5 — call it for new models
- Output summary: "X known models + Y new models = Z total"

#### 2. Update workflow to pass known models set

**File**: `.github/workflows/benchmark.yml`

**Intent**: Pass the current action.yml model list to the benchmark so it can distinguish known vs new.

**Contract**:
- Read current models from action.yml (already done by `readCurrentModels()`)
- Pass as environment variable or write to temp file
- Benchmark uses this to determine tier

### Success Criteria:

#### Automated Verification:
- Unit tests pass: `npm test`

#### Manual Verification:
- action.yml updated with two-tier ordered list
- New models added to SWE_BENCH_SCORES at 0.5
- Known models maintain their SWE-based order

---

## Phase 5: Workflow Automation

### Overview

Wire everything together in the daily benchmark workflow. Each provider job: discover → benchmark → rank → update → commit.

### Changes Required:

#### 1. Update OR/Kilo benchmark jobs

**File**: `.github/workflows/benchmark.yml`

**Intent**: OR and Kilo jobs use hybrid discovery (known + new free models). New models auto-added at 0.5.

**Contract**:
- Set `BENCH_AUTO_FREE=true`
- After benchmark: discover new models, add to SWE_TABLE at 0.5
- Generate two-tier ordered list
- Update action.yml
- Commit changes (only on main branch)

#### 2. Update NIM/Mistral/Groq jobs (future phase)

**File**: `.github/workflows/benchmark.yml`

**Intent**: When expanded, these providers also get auto-discovery (without free filtering).

**Contract**: Same pattern but without "free" filter — discover all models, compare against history.

### Success Criteria:

#### Automated Verification:
- Unit tests pass: `npm test`

#### Manual Verification:
- Daily benchmark runs without conflicts
- New OR/Kilo models discovered and added at 0.5
- action.yml reordered with known models first
- History JSON updated

---

## Testing Strategy

### Unit Tests:
- `model-history.ts`: load/save/detect new/detect removed
- `rankModelsTwoTier()`: known always above new, correct sorting within tiers
- Integration: full discover → benchmark → rank → update flow

### Integration Tests:
- Run benchmark on OR with mock catalog → verify new models added
- Verify two-tier ordering in output

### Manual Testing Steps:
1. Run `BENCH_AUTO_FREE=true` on OR — verify free models discovered
2. Check action.yml updated with two-tier order
3. Check SWE_BENCH_SCORES has new models at 0.5
4. Manually update a new model's score → verify it ranks higher next run

## Performance Considerations

- Provider catalog query adds ~1s per benchmark run
- Two-tier sort is O(n log n) — negligible for <100 models
- JSON file I/O is trivial

## References

- SWE_BENCH_SCORES: `src/bench-reorder.ts:136-202`
- getSweBenchScore: `src/bench-reorder.ts:208-210`
- model-chain ranking: `src/model-chain.ts:76-80`
- bench-entry discovery: `src/bench-entry.ts` (--discover-new, --patch-scores)
- action.yml model lists: `action.yml:14-54`
- config.ts loadConfig: `src/config.ts:38-88`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Model History Tracking

#### Automated

- [x] 1.1 Create `src/model-history.ts` with load/save/detect functions — c203102
- [x] 1.2 Unit tests for new/removed detection — c203102

#### Manual

- [ ] 1.3 Verify history JSON loads/saves correctly

### Phase 2: Auto-Discovery for OR + Kilo

#### Automated

- [x] 2.1 Extend `bench-entry.ts` to combine known + new models — 510a5d3
- [x] 2.2 Update history JSON after benchmark — 510a5d3

#### Manual

- [ ] 2.3 Verify new models discovered and benchmarked

### Phase 3: Benchmark Integration

#### Automated

- [x] 3.1 Add `rankModelsTwoTier()` to `bench-reorder.ts` — fdd74ee
- [x] 3.2 Unit tests for two-tier ranking — fdd74ee

#### Manual

- [ ] 3.3 Verify known models rank above new models

### Phase 4: List Generation

#### Automated

- [x] 4.1 Update action.yml with two-tier ordered list — 83c4426
- [x] 4.2 Add new models to SWE_BENCH_SCORES at 0.5 — 83c4426

#### Manual

- [ ] 4.3 Verify action.yml and SWE_BENCH_SCORES updated

### Phase 5: Workflow Automation

#### Automated

- [x] 5.1 Update OR/Kilo benchmark jobs for hybrid discovery — 087ec90
- [x] 5.2 Add history tracking to workflow — 087ec90

#### Manual

- [ ] 5.3 Full end-to-end test: discover → benchmark → rank → commit
