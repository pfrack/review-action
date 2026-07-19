# Daily Model Benchmark & Auto-Reorder — Implementation Plan

## Overview

Add a self-optimizing model fallback chain to the NIM Code Review Action. A daily GitHub Actions workflow benchmarks the current top 7 models, ranks them by effective score (SWE-bench Verified × latency penalty), replaces any failed models with the next-best from a ranked list, and commits the updated order to `action.yml`.

## Current State Analysis

The action has a static, hand-curated model list in `action.yml` (`nim_models` default). The `NimClient` class (`src/nim-client.ts`) already supports chat completions, streaming, and model probing. A benchmark module (`src/bench.ts`) exists with `runBenchmark()` and `formatMarkdownTable()` utilities. A benchmark entry point (`src/bench-entry.ts`) runs benchmarks and outputs results.

### Key Discoveries:

- `src/nim-client.ts:1-130` — Full NIM client with `chat()`, `chatStream()`, `probeModel()`, `listModels()` methods
- `src/bench.ts:1-105` — Benchmark runner with iteration results, markdown table formatting
- `src/bench-entry.ts` — Entry point that reads models from `action.yml`, benchmarks them, replaces failures
- `action.yml:14` — `nim_models` default value is the single source of truth for model order
- `.github/workflows/ci.yml` — Existing CI runs build + test on all pushes

## Desired End State

The `action.yml` default model list is always ordered by effective quality score. The workflow runs daily at 06:00 UTC, validates the current 7 models are alive and fast, replaces broken ones, and commits any reordering. Users of the action always get the best available model tried first without manual intervention.

**Verification**: After one successful workflow run, `action.yml` should contain 7 models ordered by descending effective score. Running `node dist/bench-entry.js` locally should produce a markdown table and `node dist/bench-reorder.js < table.txt` should update `action.yml` with the same order.

## What We're NOT Doing

- Real-time model health dashboard
- A/B testing between models on actual PRs
- Benchmarking on real PR diffs (synthetic prompt suffices)
- Auto-discovering new models without SWE-bench data
- Tracking historical win statistics
- Modifying the core review logic

## Implementation Approach

Three new files + one workflow:

1. **`src/bench-reorder.ts`** — SWE-bench score table, latency penalty function, ranking logic, action.yml updater
2. **`src/bench-entry.ts`** (modified) — Reads current 7 from action.yml, benchmarks them, replaces failures from SWE-bench list
3. **`src/bench-reorder.test.ts`** — Unit tests for parsing, scoring, ranking
4. **`.github/workflows/benchmark.yml`** — Daily cron + manual trigger, runs bench → reorder → commit

The `NimClient.listModels()` method was added to support probing the NIM API catalog.

## Phase 1: SWE-bench Scores & Ranking Logic

### Overview

Create the reorder module with SWE-bench score mapping, latency penalty function, and model ranking.

### Changes Required:

#### 1. Benchmark Reorder Module

**File**: `src/bench-reorder.ts`

**Intent**: Central ranking logic. Maps NIM model IDs to SWE-bench Verified scores, computes effective score with latency penalty, ranks models, and writes updated order to `action.yml`.

**Contract**:
- `SWE_BENCH_SCORES: Record<string, number>` — model ID → score (0–1)
- `getSweBenchScore(model: string): number` — returns score or 0.5 for unknown
- `getEffectiveScore(model: string, latencies?: Record<string, number>, maxLatencyMs?: number): number` — SWE × penalty
- `rankModels(rows: ParsedRow[], latencies?: Record<string, number>): string[]` — sorted model list
- `updateActionYml(actionPath: string, orderedModels: string[]): void` — regex-replaces `nim_models` default
- `parseMarkdownTable(table: string): ParsedRow[]` — parses bench output

Latency penalty:
```typescript
// ≤ 60s: multiplier = 1.0
// 60-120s: multiplier = 1.0 - 0.3 * ((lat - 60000) / 60000)
// > 120s: multiplier = 0.5
```

#### 2. Unit Tests

**File**: `src/bench-reorder.test.ts`

**Intent**: Test parsing, scoring, effective score with penalty tiers, ranking with latency demotion, and dead model exclusion.

**Contract**: Tests cover `parseMarkdownTable`, `getSweBenchScore`, `getEffectiveScore` (4 penalty tiers), `rankModels` (SWE ordering, slow demotion, tiebreaker, dead exclusion).

### Success Criteria:

#### Automated Verification:

- Build passes: `npm run build`
- Reorder tests pass: `node --test dist/bench-reorder.test.js`
- Full test suite passes: `npm test`

#### Manual Verification:

- Running `echo "| \`deepseek-ai/deepseek-v4-pro\` | 5s | 10s | 50.0 | 0 |" | node dist/bench-reorder.js` updates action.yml correctly

---

## Phase 2: Benchmark Entry Point & Model Discovery

### Overview

Modify the benchmark entry point to read current models from `action.yml`, benchmark them, and replace failures with next-best from SWE-bench ranked list.

### Changes Required:

#### 1. Benchmark Entry Point

**File**: `src/bench-entry.ts`

**Intent**: Daily benchmark orchestrator. Reads current 7 from action.yml (or seeds from SWE-bench top 7 on first run), benchmarks each, replaces any that fail all iterations by probing next-best candidates.

**Contract**:
- Reads model list from `action.yml` via regex (same pattern as reorder)
- Seeds from `SWE_BENCH_SCORES` top 7 if action.yml has no models
- For each failed model: probes candidates from SWE-bench list in descending score order
- First successful probe+bench replaces the failed model
- Outputs markdown table to stdout (only successful models)
- `--probe` flag: quick availability check without full benchmark

#### 2. NimClient.listModels()

**File**: `src/nim-client.ts`

**Intent**: Fetch available models from NIM API `/models` endpoint.

**Contract**: `async listModels(): Promise<string[]>` — returns array of model IDs.

### Success Criteria:

#### Automated Verification:

- Build passes: `npm run build`
- Full test suite passes: `npm test`
- Probe mode works: `NIM_API_KEY=... node dist/bench-entry.js --probe`

#### Manual Verification:

- Running `NIM_API_KEY=... NIM_BENCH_ITERATIONS=2 node dist/bench-entry.js` produces a markdown table with latency data for the 7 models in action.yml
- If a model is unreachable, replacement logic kicks in

---

## Phase 3: GitHub Actions Workflow & Integration

### Overview

Create the daily benchmark workflow that orchestrates bench → reorder → commit.

### Changes Required:

#### 1. Benchmark Workflow

**File**: `.github/workflows/benchmark.yml`

**Intent**: Daily cron (06:00 UTC) + manual trigger. Runs benchmark, pipes table to reorder script, commits action.yml if changed.

**Contract**:
- Triggers: `schedule: cron '0 6 * * *'` + `workflow_dispatch`
- Permissions: `contents: write`
- Steps: checkout → setup-node → npm ci → npm run build → run bench → grep table → run reorder → git commit (if changed)
- Commit message: `chore: update model order from daily benchmark [skip ci]`
- Uses `NIM_API_KEY` from repository secrets

#### 2. Update action.yml default

**File**: `action.yml`

**Intent**: Set initial model order to SWE-bench ranked top 7 that are currently available on NIM.

**Contract**: `nim_models` default value = `deepseek-ai/deepseek-v4-pro,minimaxai/minimax-m3,deepseek-ai/deepseek-v4-flash,z-ai/glm-5.2,qwen/qwen3.5-397b-a17b,stepfun-ai/step-3.7-flash,mistralai/mistral-nemotron`

### Success Criteria:

#### Automated Verification:

- Workflow YAML is valid: `actionlint .github/workflows/benchmark.yml` (if available)
- Build passes: `npm run build`
- Full test suite passes: `npm test`

#### Manual Verification:

- Triggering workflow via `gh workflow run benchmark.yml` completes successfully
- Workflow produces a commit with updated model order (or no commit if order unchanged)
- GitHub Actions step summary shows benchmark results table

---

## Testing Strategy

### Unit Tests:

- `bench-reorder.test.ts`: parseMarkdownTable (well-formed, N/A values, empty)
- `bench-reorder.test.ts`: getSweBenchScore (known, unknown)
- `bench-reorder.test.ts`: getEffectiveScore (no penalty, moderate, heavy, no data)
- `bench-reorder.test.ts`: rankModels (SWE ordering, slow demotion, tiebreaker, dead exclusion)
- `bench.test.ts`: runBenchmark (iterations, errors) — existing tests

### Integration Tests:

- Full pipeline: bench-entry.ts → stdout table → bench-reorder.ts → action.yml update (manual)

### Manual Testing Steps:

1. Run `source ~/.env.keys && NIM_BENCH_ITERATIONS=2 node dist/bench-entry.js` — verify table output
2. Pipe table to reorder: `grep '^|' output.txt | node dist/bench-reorder.js` — verify action.yml updated
3. Trigger workflow: `gh workflow run benchmark.yml` — verify commit appears

## Performance Considerations

- Each model benchmark takes ~20-60s (warmup + 2 iterations with streaming TTFT measurement)
- Total workflow time: ~3-7 minutes for 7 models
- If a model times out (180s hard limit in NimClient), it counts as an error and the model is replaced
- The `[skip ci]` commit message prevents cascading CI runs

## References

- PRD: `context/foundation/prd.md`
- Shape notes: `context/foundation/shape-notes.md`
- SWE-bench Verified leaderboard: https://llm-stats.com/benchmarks/swe-bench-verified
- NIM API models endpoint: `https://integrate.api.nvidia.com/v1/models`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: SWE-bench Scores & Ranking Logic

#### Automated

- [x] 1.1 Build passes
- [x] 1.2 Reorder tests pass
- [x] 1.3 Full test suite passes

#### Manual

- [ ] 1.4 Reorder script updates action.yml correctly with piped input

### Phase 2: Benchmark Entry Point & Model Discovery

#### Automated

- [x] 2.1 Build passes
- [x] 2.2 Full test suite passes
- [ ] 2.3 Probe mode works with live API

#### Manual

- [ ] 2.4 Full benchmark produces table for 7 models
- [ ] 2.5 Replacement logic works when a model is unreachable

### Phase 3: GitHub Actions Workflow & Integration

#### Automated

- [x] 3.1 Build passes
- [x] 3.2 Full test suite passes

#### Manual

- [ ] 3.3 Workflow triggered via gh workflow run completes
- [ ] 3.4 Workflow produces commit with updated order
