# SWE Score Resolver — Automatic SWE-bench Score Mapping

## Overview

Create a standalone CLI script that resolves models stuck at the default 0.5 SWE-bench score to their actual leaderboard scores. Uses enhanced deterministic matching (strip `:free`, org prefix, version differences) with LLM fallback for remaining models. Run after benchmarks to patch the `SWE_BENCH_SCORES` table.

## Current State Analysis

- **SWE_BENCH_SCORES** (`src/bench-reorder.ts:136-202`): Hardcoded table mapping ~60 model IDs to scores. Unknown models return 0.5.
- **getSweBenchScore()** (`src/bench-reorder.ts:208-210`): Returns score from table or 0.5 default.
- **deterministicMatch()** (`src/bench-entry.ts:89-125`): Tries exact → case-insensitive → normalized → substring. Does NOT strip `:free` suffix or handle org prefix differences.
- **matchModelScore()** (`src/bench-entry.ts:134-171`): LLM fallback using top-30 leaderboard context. Only runs in NIM benchmark path.
- **discoverNewModels()** (`src/bench-reorder.ts:512-516`): Returns models not in table with hardcoded 0.5.
- **patchScoresTable()** (`src/bench-reorder.ts:522-547`): Inserts entries into source file by marker comment.
- **Leaderboard API**: `https://api.zeroeval.com/leaderboard/benchmarks/swe-bench-verified/details` returns 104 models.
- **Problem**: 12 Kilo benchmark models all have SWE=0.5. Some exist on leaderboard without `:free` suffix (e.g., `nemotron-3-super-120b-a12b` = 0.537), others don't exist at all (free-tier variants not independently benchmarked).

### Key Discoveries:
- Leaderboard uses short names (e.g., `nemotron-3-super-120b-a12b`) while our models use full IDs (`nvidia/nemotron-3-super-120b-a12b:free`)
- Some models share architecture but differ in version (e.g., `stepfun/step-3.7-flash:free` vs leaderboard `step-3.5-flash`)
- The LLM fallback already exists but only triggers in NIM path — needs extraction for standalone use
- `patchScoresTable` already handles source-file insertion — script can reuse this pattern

## Desired End State

A CLI script `src/swe-resolver.ts` that:
1. Reads current `SWE_BENCH_SCORES` table from `bench-reorder.ts`
2. Fetches latest leaderboard from API
3. Finds models currently scored 0.5 (or a provided list)
4. Tries enhanced deterministic match → LLM fallback for each
5. Patches `SWE_BENCH_SCORES` with resolved scores
6. Logs which models couldn't be resolved (kept at 0.5)

Runnable via `node dist/src/swe-resolver.js` or `npx tsx src/swe-resolver.ts`.

## What We're NOT Doing

- NOT integrating into the live benchmark workflow (standalone only)
- NOT creating a separate scores file (patches existing table)
- NOT estimating scores for models with no leaderboard entry (keep 0.5)
- NOT building a full semantic search/embedding system

## Implementation Approach

Extend the existing `normalizeModelId` to handle `:free` suffix and org prefix stripping. Reuse the existing LLM matching prompt logic. Output resolved scores into the existing `patchScoresTable` flow.

## Critical Implementation Details

- **:free suffix**: Must be stripped before matching — `nvidia/nemotron-3-super-120b-a12b:free` → `nemotron-3-super-120b-a12b`
- **Org prefix**: Leaderboard omits org — strip `nvidia/`, `inclusionai/`, `poolside/` etc. before matching
- **Version differences**: `step-3.7` vs `step-3.5` are different models — don't fuzzy match versions
- **Ambiguous matches**: If multiple leaderboard entries match, log warning and keep 0.5 (don't guess)
- **Marker detection**: `patchScoresTable` uses provider-specific markers — resolver must pick correct section

---

## Phase 1: Enhanced Normalization

### Overview

Extend `normalizeModelId` to handle `:free` suffix and improve org prefix stripping. Add this to `bench-entry.ts` so both the benchmark and resolver benefit.

### Changes Required:

#### 1. Enhance normalizeModelId in bench-entry.ts

**File**: `src/bench-entry.ts:71-77`

**Intent**: Strip `:free` suffix and improve org prefix handling so deterministic matching works for free-tier model IDs.

**Contract**:
```typescript
// Before:
function normalizeModelId(id: string): string {
  return id
    .toLowerCase()
    .replace(/^[^/]+\//, '')
    .replace(/-(instruct|chat|base|it|bf16|fp8|fp16|preview)$/i, '')
    .replace(/[^a-z0-9]/g, '');
}

// After: also strip :free suffix and -free variants
function normalizeModelId(id: string): string {
  return id
    .toLowerCase()
    .replace(/:free$/i, '')
    .replace(/^[^/]+\//, '')
    .replace(/-(instruct|chat|base|it|bf16|fp8|fp16|preview|free)$/i, '')
    .replace(/[^a-z0-9]/g, '');
}
```

### Success Criteria:

#### Automated Verification:
- Unit tests pass: `npm test`
- Type checking passes: `npm run build`

#### Manual Verify:
- `deterministicMatch('nvidia/nemotron-3-super-120b-a12b:free', leaderboard)` returns score 0.5373

---

## Phase 2: SWE Resolver Script

### Overview

Create standalone CLI script that reads the current scores table, fetches leaderboard, resolves 0.5 models, and patches the table.

### Changes Required:

#### 1. Create src/swe-resolver.ts

**File**: `src/swe-resolver.ts` (new file)

**Intent**: Standalone CLI that resolves models with 0.5 score to actual leaderboard scores.

**Contract**:
```typescript
interface ResolvedScore {
  model: string;
  score: number;
  strategy: 'exact' | 'normalized' | 'substring' | 'llm';
}

interface UnresolvedModel {
  model: string;
  reason: 'not_found' | 'ambiguous' | 'api_error';
}

export async function resolveScores(
  currentScores: Record<string, number>,
  leaderboard: SweBenchEntry[],
  options: { llmClient?: OpenAIClient; matcherModel?: string }
): Promise<{ resolved: ResolvedScore[]; unresolved: UnresolvedModel[] }>

// CLI: node dist/src/swe-resolver.js [--source src/bench-reorder.ts] [--dry-run]
```

**Behavior**:
1. Parse `SWE_BENCH_SCORES` from `src/bench-reorder.ts` (extract via regex or import)
2. Identify models scored 0.5 (or accept `--models` list)
3. Fetch leaderboard from API
4. For each model: try enhanced deterministic match → LLM fallback (if client provided)
5. If `--dry-run`: print results without patching
6. Otherwise: call `patchScoresTable` to insert resolved scores
7. Log unresolved models

#### 2. Export normalizeModelId for reuse

**File**: `src/bench-entry.ts:71-77`

**Intent**: Export `normalizeModelId` so `swe-resolver.ts` can reuse it instead of duplicating.

**Contract**: Add `export` keyword to function declaration.

### Success Criteria:

#### Automated Verification:
- `npm run build` compiles `swe-resolver.ts`
- `npm test` passes (existing tests unaffected)

#### Manual Verification:
- `node dist/src/swe-resolver.js --dry-run` shows resolved/unresolved lists
- `node dist/src/swe-resolver.js` patches `SWE_BENCH_SCORES` table
- Running twice doesn't duplicate entries

---

## Phase 3: Integration & Testing

### Overview

Wire the resolver into the benchmark workflow (optional step) and add tests for the matching logic.

### Changes Required:

#### 1. Add tests for enhanced matching

**File**: `src/bench-entry.test.ts` (new file or extend existing)

**Intent**: Cover the enhanced `normalizeModelId` and `deterministicMatch` with `:free` suffix and org prefix cases.

**Test cases**:
- `'nvidia/nemotron-3-super-120b-a12b:free'` matches `nemotron-3-super-120b-a12b` (0.5373)
- `'poolside/laguna-xs-2.1:free'` matches `poolside/laguna-xs-2.1` (if on leaderboard)
- `'stepfun/step-3.7-flash:free'` → normalized → substring match
- `'inclusionai/ling-3.0-flash:free'` → NOT found (no leaderboard entry)
- Ambiguous match (multiple candidates) → returns null, logs warning

#### 2. Add npm script

**File**: `package.json`

**Intent**: Convenient invocation.

**Contract**: Add `"resolve-swe": "tsx src/swe-resolver.ts"` (or use `node dist/src/swe-resolver.js`)

### Success Criteria:

#### Automated Verification:
- `npm test` passes with new test cases
- `npm run resolve-swe -- --dry-run` outputs resolution table

#### Manual Verification:
- Running `npm run resolve-swe` patches `bench-reorder.ts` with correct scores
- `git diff` shows only score additions (no formatting changes)

---

## Testing Strategy

### Unit Tests:
- `normalizeModelId` handles `:free`, `-free`, org prefixes
- `deterministicMatch` with enhanced normalization
- `resolveScores` with mocked leaderboard (no API call)
- `resolveScores` with mocked LLM client

### Integration Tests:
- Fetch real leaderboard → resolve known models → verify scores

### Manual Testing Steps:
1. `npm run build`
2. `node dist/src/swe-resolver.js --dry-run` — review output
3. `node dist/src/swe-resolver.js` — apply patches
4. `git diff src/bench-reorder.ts` — verify only score changes
5. `npm test` — confirm no regressions

## References

- Leaderboard API: `https://api.zeroeval.com/leaderboard/benchmarks/swe-bench-verified/details`
- Existing LLM matching: `src/bench-entry.ts:134-171`
- Existing table patching: `src/bench-reorder.ts:522-547`

## Progress

### Phase 1: Enhanced Normalization

#### Automated
- [x] 1.1 Update `normalizeModelId` to strip `:free` suffix
- [x] 1.2 Export `normalizeModelId` for reuse
- [x] 1.3 Existing tests still pass

#### Manual
- [x] 1.4 Verify `deterministicMatch` works with `:free` IDs

### Phase 2: SWE Resolver Script

#### Automated
- [x] 2.1 `src/swe-resolver.ts` compiles
- [x] 2.2 `--dry-run` outputs resolved/unresolved lists
- [x] 2.3 Without `--dry-run`, patches `SWE_BENCH_SCORES`

#### Manual
- [x] 2.4 Run against real leaderboard, verify scores

### Phase 3: Integration & Testing

#### Automated
- [x] 3.1 New test cases for enhanced matching
- [x] 3.2 `npm run resolve-swe -- --dry-run` works

#### Manual
- [x] 3.3 Full run patches table correctly
- [x] 3.4 Idempotent — running twice doesn't duplicate
