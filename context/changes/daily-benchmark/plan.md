# Daily Model Benchmark & Auto-Reorder — Implementation Plan

## Overview

Comprehensive improvement to the NIM Code Review Action covering: (1) self-optimizing model fallback chain via daily benchmarks, (2) generic PR comment formatting with update-in-place, (3) proper ncc bundling for action distribution, and (4) self-review on own PRs.

## Current State Analysis

The action had a static, hand-curated model list in `action.yml`. PR comments were branded "NIM Code Review" and created duplicate comments on each push. The action was not properly bundled with ncc, causing module resolution failures. The repo had no self-review mechanism.

### Key Discoveries:

- `src/nim-client.ts` — Full NIM client with `chat()`, `chatStream()`, `probeModel()`, `listModels()` methods
- `src/bench.ts` — Benchmark runner with iteration results, markdown table formatting
- `src/bench-entry.ts` — Entry point that reads models from `action.yml`, benchmarks them, replaces failures
- `src/bench-reorder.ts` — SWE-bench scores, latency penalty, ranking logic, action.yml updater
- `src/review.ts` — PR comment posting with find-and-update logic
- `src/index.ts` — Main action entry point with generic "AI Code Review" header
- `action.yml:14` — `nim_models` default value is the single source of truth for model order
- `dist/bundle/index.js` — ncc-bundled self-contained action entry point

## Desired End State

1. The model fallback chain auto-optimizes daily based on SWE-bench quality × latency
2. PR comments say "AI Code Review", show only the model used, and update in place on re-runs
3. The action is properly bundled (ncc) so consumers don't get module resolution errors
4. The repo reviews its own PRs using the action
5. The benchmark workflow amends its own commit and moves the latest `v*` tag automatically

## What We're NOT Doing

- Real-time model health dashboard
- A/B testing between models on actual PRs
- Benchmarking on real PR diffs (synthetic prompt suffices)
- Auto-discovering new models without SWE-bench data
- Tracking historical win statistics

## Implementation Approach

Four parallel tracks delivered as a single cohesive change:
- **Track A**: Benchmark + ranking engine (bench-reorder.ts, bench-entry.ts, SWE-bench scores)
- **Track B**: Workflow infrastructure (benchmark.yml with amend, rebase, tag movement)
- **Track C**: PR comment UX (generic header, model display, update-in-place)
- **Track D**: Distribution & self-review (ncc bundle, review.yml)

---

## Phase 1: SWE-bench Ranking Engine

### Overview

Core ranking logic with SWE-bench score mapping, latency penalty, and action.yml update.

### Changes Required:

#### 1. Benchmark Reorder Module

**File**: `src/bench-reorder.ts`

**Intent**: Maps NIM model IDs to SWE-bench Verified scores, computes effective score with latency penalty, ranks models, updates action.yml.

**Contract**:
- `SWE_BENCH_SCORES: Record<string, number>` — 36 models mapped
- `getSweBenchScore(model): number` — returns score or 0.5 for unknown
- `getEffectiveScore(model, latencies?, maxLatencyMs?): number` — SWE × penalty (≤60s: 1.0, 60-120s: linear to 0.7, >120s: 0.5)
- `rankModels(rows, latencies?): string[]` — alive models sorted by effective score, tiebreak by latency
- `parseMarkdownTable(table): ParsedRow[]` — parses bench stdout
- `updateActionYml(actionPath, orderedModels): void` — regex-replaces nim_models default

#### 2. Unit Tests

**File**: `src/bench-reorder.test.ts`

**Intent**: 16 tests covering parsing, scoring, penalty tiers, ranking with demotion, dead model exclusion.

### Success Criteria:

#### Automated

- Build passes: `npm run build`
- All 16 reorder tests pass: `node --test dist/bench-reorder.test.js`
- Full test suite (67+ tests) passes: `npm test`

---

## Phase 2: Benchmark Entry Point

### Overview

Orchestrator that reads current 7 from action.yml, benchmarks them, replaces failures from SWE-bench list.

### Changes Required:

#### 1. Entry Point

**File**: `src/bench-entry.ts`

**Intent**: Daily benchmark orchestrator. Reads current models from action.yml, benchmarks each with synthetic code review prompt, replaces failures by probing next-best SWE-bench candidates.

**Contract**:
- Reads model list from action.yml (or seeds from SWE-bench top 7 on first run)
- 1 iteration per model (configurable via `NIM_BENCH_ITERATIONS`)
- Failed model → probe candidates from SWE-bench list descending
- Outputs markdown table to stdout, progress to stderr
- `--probe` flag for quick availability check

#### 2. NimClient.listModels()

**File**: `src/nim-client.ts`

**Intent**: Fetch available models from NIM API `/models` endpoint.

**Contract**: `async listModels(): Promise<string[]>`

### Success Criteria:

#### Automated

- Build passes
- `--probe` mode works with live API

#### Manual

- Full benchmark produces table for 7 models
- Replacement logic works when a model is unreachable

---

## Phase 3: Benchmark Workflow

### Overview

Daily cron workflow with git amend, rebase, and automatic tag movement.

### Changes Required:

#### 1. Workflow

**File**: `.github/workflows/benchmark.yml`

**Intent**: Daily cron (06:00 UTC) + manual trigger. Runs bench, pipes to reorder, commits with amend logic, moves latest v* tag.

**Contract**:
- Triggers: `schedule: cron '0 6 * * *'` + `workflow_dispatch`
- Permissions: `contents: write`
- `NIM_BENCH_ITERATIONS: 1` for speed
- Stderr shows live progress in Actions logs
- If last commit was a benchmark commit → amend it (no commit pile-up)
- If not → create new commit with `[skip ci]`
- `git pull --rebase origin main` before push (handles concurrent commits)
- Finds latest `v*` tag and force-moves it to the new commit

### Success Criteria:

#### Automated

- Workflow YAML valid
- Build passes

#### Manual

- `gh workflow run benchmark.yml` completes successfully
- Produces commit or amends existing one
- Tag moved to latest commit

---

## Phase 4: PR Comment UX

### Overview

Generic branding, show only model used, update existing comment in-place.

### Changes Required:

#### 1. Generic Comment Header

**File**: `src/index.ts`

**Intent**: Replace "NIM Code Review" with "AI Code Review". Show only the short model name (e.g. `deepseek-v4-pro` not `deepseek-ai/deepseek-v4-pro`) in subtle `<sub>` tag.

**Contract**:
- Header: `### AI Code Review`
- Model: `<sub>Model: {modelShort}</sub>`
- `modelShort = usedModel.split('/').pop()`

#### 2. Update-in-Place

**File**: `src/review.ts`

**Intent**: Find existing "AI Code Review" comment on the PR and update it instead of creating duplicates.

**Contract**:
- `postComment()` → first calls `findExistingComment()` (searches for comment starting with `### AI Code Review`)
- If found → PATCH the comment (update)
- If not found → POST new comment (create)
- Marker: `const COMMENT_MARKER = '### AI Code Review'`

### Success Criteria:

#### Automated

- Build passes
- Existing review tests still pass

#### Manual

- First push on PR creates comment
- Second push updates same comment (no duplicate)

---

## Phase 5: Distribution & Self-Review

### Overview

Proper ncc bundling for action consumers, and self-review workflow.

### Changes Required:

#### 1. ncc Bundle

**File**: `dist/bundle/index.js`, `action.yml`, `package.json`

**Intent**: Bundle the action entry point with ncc so all dependencies are included. Consumers don't need node_modules.

**Contract**:
- `action.yml` points to `dist/bundle/index.js`
- `package.json` build script: `tsc && cp -r src/prompts dist/prompts && ncc build src/index.ts -o dist/bundle`
- `dist/*.js` remains for tests/bench (tsc output)
- `dist/bundle/index.js` is the self-contained action (ncc output)

#### 2. Self-Review Workflow

**File**: `.github/workflows/review.yml`

**Intent**: Use our own action on PRs to this repo.

**Contract**:
- Triggers: `pull_request: [opened, synchronize]`
- Permissions: `contents: read`, `pull-requests: write`
- Uses: `pfrack/review-action@v1`
- Passes `NIM_API_KEY` secret and `GITHUB_TOKEN`

### Success Criteria:

#### Automated

- `npm run build` produces both tsc output and ncc bundle
- Action runs without `ERR_MODULE_NOT_FOUND`

#### Manual

- PR on this repo triggers self-review
- PR on consumer repo (freedius) gets "AI Code Review" comment

---

## Testing Strategy

### Unit Tests (67+):

- `bench-reorder.test.ts`: 16 tests (parsing, scoring, penalty, ranking)
- `bench.test.ts`: runBenchmark, median, countErrors, formatDuration, formatMarkdownTable
- `nim-client.test.ts`: chat, stream, probe, error handling
- `review.test.ts`: parseDiff, shouldExclude, resolveSystemPrompt
- `prompts.test.ts`: languageForFile, languageForTemplate

### Integration Tests:

- Full pipeline: bench-entry → table → bench-reorder → action.yml (manual)
- PR comment update-in-place (manual via freedius repo)

## Performance Considerations

- Benchmark with 1 iteration per model: ~5-8 minutes for 7 models
- Some models may timeout at 180s (NimClient hard limit) — counted as failure
- `[skip ci]` on benchmark commits prevents cascading CI runs
- ncc bundle is ~970KB (acceptable for GitHub Actions)

## References

- PRD: `context/foundation/prd.md`
- Shape notes: `context/foundation/shape-notes.md`
- SWE-bench Verified: https://llm-stats.com/benchmarks/swe-bench-verified
- NIM API: https://integrate.api.nvidia.com/v1/models

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: SWE-bench Ranking Engine

#### Automated

- [x] 1.1 Build passes
- [x] 1.2 Reorder tests pass (16/16)
- [x] 1.3 Full test suite passes (67+)

### Phase 2: Benchmark Entry Point

#### Automated

- [x] 2.1 Build passes
- [x] 2.2 Probe mode works

#### Manual

- [x] 2.3 Benchmark produces table for 7 models
- [x] 2.4 Replacement logic works

### Phase 3: Benchmark Workflow

#### Automated

- [x] 3.1 Build passes

#### Manual

- [x] 3.2 Workflow runs and benchmarks models — `29701548594`
- [x] 3.3 Reorder step produces correct ranking
- [ ] 3.4 Commit + tag movement succeeds end-to-end

### Phase 4: PR Comment UX

#### Automated

- [x] 4.1 Build passes
- [x] 4.2 Tests pass

#### Manual

- [ ] 4.3 Comment shows "AI Code Review" with short model name
- [ ] 4.4 Re-push updates existing comment (no duplicate)

### Phase 5: Distribution & Self-Review

#### Automated

- [x] 5.1 ncc bundle builds without errors
- [x] 5.2 Action runs without ERR_MODULE_NOT_FOUND

#### Manual

- [ ] 5.3 Self-review triggers on PR to this repo
- [ ] 5.4 Consumer repo (freedius) gets review comment
