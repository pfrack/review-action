# EOL Model Handling — Runtime Deadness Skip

## Overview

Close the deadness loop at the point of use: make the runtime act on the 410/403/413 signal it already observes via probe and chat, instead of discarding it. Repurpose the probe as a deadness detector, skip models that fail with permanent errors within the current run, remove hardcoded EOL fallback lists, and fix the two pipeline gaps that silently break delivery (stale bundle, groq stall). The system stops re-discovering dead models every PR and degrades less often to weak fallback outcomes.

## Current State Analysis

The runtime has zero dead-model defense. `prioritizeChain` (`src/index.ts:485-496`) probes the whole chain but the result is log-only. `probeModel` swallows all errors — returns boolean, no status (`src/openai-client.ts:453-455`). The `removed-*.txt` and `*-model-history.json` files are imported only by `src/bench-entry.ts`; the runtime bundle contains zero references to them.

The bench pipeline does prune `action.yml` (daily crons; the observed 410 models were ejected 2026-09-03/04), but delivery to `@v1` consumers is broken by compounding gaps: tag frozen at a non-benchmark commit, `dist/bundle/` 4+ days stale, groq bench dead 18 days, score table insert-only so dead models keep high scores and get probed daily.

Hardcoded TS fallbacks in `src/config.ts:69-73` still list EOL'd Mistral models and are never updated by the pipeline.

### Key Discoveries:

- Probe costs ~90s for a 25-model chain (10s × ⌈N/3⌉) yet returns pure logging (`src/model-chain.ts:146-211`)
- `withRetry` already fails fast on 4xx — each 410 costs exactly 1 round trip (`src/retry.ts:29`); the expensive waste is 90s timeouts on hung heads
- `v1` tag → PR #32 merge (non-"benchmark" subject) → tag-move guard refuses all future moves (`benchmark-template.yml:163-174`)
- Bundle last built 2026-09-02 (`ddb9568`), missing PR #32's SWE-dominant winner logic
- Groq all-fail exits 0 with "Skipping reorder" (`src/bench-reorder.ts:479-482`) — silent green

## Desired End State

After this plan, the runtime detects permanent model-deadness signals (410, 403, 413) during the probe and chat stages, skips those models for the current run, and logs which models were skipped and why. The hardcoded fallback lists are gone — `action.yml` defaults are the single source of truth. The bench pipeline rebuilds and commits `dist/bundle/` automatically, and fails (not exits green) when all models in a provider chain fail. Consumers on pinned `@v1` refs get meaningful deadness-avoidance from the runtime even if the push channel stays broken.

**Verification**: A run with an EOL-dense chain (containing known 410/403 models) skips dead models, logs the skip reason, completes from a healthy model, and posts a review. Pipeline workflows commit `dist/` changes and fail loudly on all-model-fail.

## What We're NOT Doing

- **No cross-run deadness persistence** (no local file cache of dead models) — per-run skip only
- **No tag-move guard fix** — tag freeze is a release-process concern, not a runtime fix
- **No score-table pruning** — the insert-only decision stands; runtime skipping makes it tolerable
- **No cross-provider ejection** — ejecting a model on one provider doesn't affect others
- **No change to parallel winner selection** — SWE-dominance (PR #32) is already merged
- **No change to retry policy** — 4xx fail-fast is already correct
- **No fail-loudly on weak-model outcome** — we accept "any review > no review" but log the tier

## Implementation Approach

The plan follows the "tolerate, don't avoid" philosophy but adds a thin avoidance layer at the point of use: the runtime already *sees* deadness (probe 410s, chat 403s); we just stop throwing that signal away. The probe — currently vestigial — becomes load-bearing as a cheap deadness detector (10s vs 90s timeout). Hardcoded fallbacks are removed to eliminate the drift class. Pipeline fixes target the two gaps that silently break delivery, not the full delivery channel.

## Phase 1: Runtime Deadness Detection

### Overview

Repurpose the probe as a deadness detector and make the runtime skip models that fail with permanent errors (410, 403, 413) within the current run. The probe result — currently log-only — is promoted to a chain filter.

### Changes Required:

#### 1. Propagate probe failure status

**File**: `src/openai-client.ts`

**Intent**: `probeModel` currently swallows all errors and returns `boolean` (`src/openai-client.ts:453-455`). It needs to return the failure reason (status code or error type) so callers can distinguish permanent (410/403/413) from transient (timeout, 5xx, network) failures.

**Contract**: Change `probeModel` return type from `Promise<boolean>` to `Promise<{ ok: boolean; permanent: boolean; status?: number }>` (or equivalent). A probe that fails with status 410, 403, or 413 returns `{ ok: false, permanent: true, status }`. Timeout/network/5xx returns `{ ok: false, permanent: false }`. Keep the function signature compatible with existing callers.

#### 2. Filter chain on permanent probe failures

**File**: `src/model-chain.ts`

**Intent**: `probeModels` (`src/model-chain.ts:149-211`) batches probes and returns a suggested head. Currently it returns the fastest responder (capped) or null. It needs to also return the set of models that failed permanently so callers can exclude them.

**Contract**: Extend `probeModels` return type to include a `skip: Set<string>` (or `string[]`) of model IDs whose probe failed with a permanent error. Existing return contract for `head` is preserved — the skip set is additive.

#### 3. Skip dead models in chain execution

**File**: `src/index.ts`

**Intent**: `prioritizeChain` (`src/index.ts:485-496`) currently discards the probe result after logging. It must now pass the dead-model set to `runModelChainForBatch` so those models are excluded from both the parallel window and sequential fallthrough.

**Contract**: `runModelChainForBatch` (or `buildCombinedChain`) accepts an optional `skipModels: Set<string>` parameter. Models in this set are excluded from the chain before sorting and execution. If `skipModels` is undefined/null, behavior is unchanged.

#### 4. Surface dead-model skip in logs

**File**: `src/index.ts`

**Intent**: After the chain is built but before execution, log which models were skipped and why (status code). This is the observability win — consumers see exactly which models died and the reason.

**Contract**: Add a log line after chain construction: `"Skipping N models: <id1> (<status1>), <id2> (<status2>)"` when any models are skipped. No log change when skip set is empty.

### Success Criteria:

#### Automated Verification:

- Unit tests pass: `npm test -- --grep "probeModel|prioritizeChain|probeModels"`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Existing chain-order test (`src/index.test.ts:548`) still passes — probe does not change chain order when no models are permanent-failed

#### Manual Verification:

- Run the action locally (or observe a real run) with a chain containing a known 410 model — verify the skip log line appears and the model is not attempted
- Verify that healthy models in the same chain are still attempted normally

---

## Phase 2: Remove Hardcoded Fallback Lists

### Overview

Delete the hardcoded TS fallback lists in `src/config.ts:69-73` that contain EOL'd Mistral models. `action.yml` defaults become the single source of truth. If an input resolves empty, the chain simply has fewer models — NIM already has no fallback and this is acceptable.

### Changes Required:

#### 1. Remove hardcoded fallback constants

**File**: `src/config.ts`

**Intent**: The hardcoded fallback lists (`src/config.ts:69-73`) are a drift class — they compiled into the stale bundle and still list EOL'd Mistral models. Removing them eliminates the class and makes `action.yml` the single source of truth, as `mistral-support`'s impl-review once demanded for `src/review.ts`.

**Contract**: Remove the fallback constants. Update the input resolution logic so that when an input resolves empty, no fallback is applied — the provider simply contributes zero models to the combined chain. The combined chain (`buildCombinedChain`) must handle zero-model providers gracefully.

### Success Criteria:

#### Automated Verification:

- Unit tests pass: `npm test`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- No references to the removed constants in `src/` or `dist/`

#### Manual Verification:

- Verify that when an input is empty (e.g. `nim_models: ""`), the chain still builds with remaining providers and does not crash
- Verify the delivered bundle no longer contains the EOL Mistral model strings in fallback position

---

## Phase 3: Pipeline Reliability

### Overview

Fix the two pipeline gaps that silently break delivery: (1) the stale bundle — `dist/bundle/index.js` is never rebuilt by the pipeline, so even when `action.yml` is pruned, the runtime logic stays stale; (2) the groq-style silent stall — when all benched models fail, the reorder exits green and the dead model stays in defaults indefinitely.

### Changes Required:

#### 1. Auto-rebuild and commit dist/ in pipeline

**File**: `.github/workflows/benchmark-template.yml`

**Intent**: The pipeline currently runs `build:tsc` only (`benchmark-template.yml:79`); `npm run build` (ncc bundle) is manual. The runtime executes stale compiled logic. The pipeline must rebuild `dist/bundle/index.js` and commit it as part of the bench workflow so consumers get fresh runtime code alongside pruned `action.yml` defaults.

**Contract**: After the bench step reorders `action.yml`, run `npm run build` (or the specific ncc build command) and commit any changes to `dist/` in the same commit as the `action.yml` change. If `dist/` is unchanged, the commit is just `action.yml`.

#### 2. Fail workflow on all-model-fail

**File**: `src/bench-reorder.ts`

**Intent**: `classifyFailedModels` can classify all models as permanent → empty table → "Skipping reorder" → exit 0 (`src/bench-reorder.ts:479-482`). This has silently hidden the groq stall for 18 days. The exit code must be non-zero so the workflow fails and alerts fire.

**Contract**: When the benchmark produces zero alive models (all failed permanently), exit with a non-zero code and a clear error message: `"All <provider> models failed — check provider status or model availability. Refusing to commit empty defaults."` The current behavior of skipping reorder is preserved for the case where there are simply no benchmark data rows yet (first run), but genuine all-fail exits non-zero.

### Success Criteria:

#### Automated Verification:

- Unit tests pass: `npm test -- --grep "bench-reorder|classifyFailedModels"`
- Type checking passes: `npm run typecheck`
- Build command succeeds: `npm run build`
- Linting passes: `npm run lint`

#### Manual Verification:

- Trigger a bench workflow run and verify `dist/` changes are committed alongside `action.yml`
- Verify the groq bench (or a synthetic all-fail scenario) fails the workflow instead of exiting green

---

## Phase 4: Observability & Verification

### Overview

Add the observability layer: surface the winner's tier in logs, summarize dead models with reasons, and run end-to-end verification with an EOL-dense chain to confirm the full loop works.

### Changes Required:

#### 1. Log winner tier and dead-model summary

**File**: `src/index.ts`

**Intent**: After the winner is selected, log the winner's model ID and whether it's a `:free`-tier alias (the weak-tail signal). Combine with the dead-model skip summary from Phase 1 so consumers get one coherent picture of why their review came from a particular model.

**Contract**: After winner selection (`src/index.ts:303-324`), add a log line: `"Winner: <model_id> (tier: <free|paid>, effectiveScore: <n>)"` and a summary: `"Skipped <N> dead models, attempted <M> healthy models"`. No behavior change — purely additive logging.

#### 2. End-to-end test with EOL models

**File**: `src/index.test.ts` (or a new test file)

**Intent**: Add an integration-style test that builds a chain containing known-permanent-fail models and verifies they are skipped, the chain proceeds with healthy models, and the winner is selected from the remaining set.

**Contract**: Test builds a chain with a mock `probeModel` that returns `permanent: true` for specific model IDs. Asserts those IDs are excluded from execution, the skip log is emitted, and a healthy model wins. Uses existing test infrastructure — no new test framework needed.

### Success Criteria:

#### Automated Verification:

- Unit tests pass: `npm test`
- New EOL test passes: `npm test -- --grep "dead|eol|skip"`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`

#### Manual Verification:

- Run the action against a real PR with a chain containing a known 410 model — verify the skip summary and winner tier are visible in logs
- Confirm the review posts successfully from a healthy model (not a free-tier alias)

---

## Testing Strategy

### Unit Tests:

- `probeModel` returns correct `permanent` flag for 410, 403, 413, 500, timeout, network errors
- `probeModels` skip set contains only permanent-failure model IDs
- `runModelChainForBatch` with `skipModels` excludes those models from execution
- `buildCombinedChain` handles empty provider inputs without crash (Phase 2)
- `classifyFailedModels` all-fail exits non-zero (Phase 3)
- Existing chain-order test still passes (probe doesn't reorder on healthy chains)

### Integration Tests:

- Full chain run with mocked permanent failures: dead models skipped, healthy model wins, skip summary logged
- Pipeline: after bench reorders `action.yml`, `dist/` is rebuilt and committed

### Manual Testing Steps:

1. Run action with a chain containing `stepfun-ai/step-3.7-flash` (known 410) — verify skip log, verify model not attempted
2. Run action with all NIM inputs empty — verify chain builds from other providers without crash
3. Trigger groq bench workflow — verify it fails (not green) when all models are dead
4. Observe a real `@v1` consumer run after landing — confirm dead models skipped and winner tier visible

## Performance Considerations

- Probe still costs ~90s for 25-model chains but now delivers value (deadness detection) instead of pure logging
- Skipping dead models *reduces* total run time: a 410'd model costs 10s probe + 1 round-trip chat instead of 10s probe + 90s timeout
- No additional network calls — the probe already runs; we just use its result
- Pipeline `npm run build` adds ~10-30s to bench workflow but only when `action.yml` changes

## Migration Notes

- Phase 1 (runtime skip) is purely additive — no migration needed; existing runs just get better
- Phase 2 (remove fallbacks) changes behavior only when an input is empty — chains get shorter, not broken
- Phase 3 (pipeline) affects CI only; no consumer-facing migration
- The `dist/` commit in Phase 3 means the next `@v1` tag move (when manually performed) will include both pruned `action.yml` and fresh bundle

## References

- Frame brief: `context/changes/eol-model-handling/frame.md`
- Research: `context/changes/eol-model-handling/research.md`
- `src/openai-client.ts:446-456` — probeModel (swallows errors)
- `src/index.ts:485-496` — prioritizeChain (log-only probe)
- `src/model-chain.ts:146-211` — probeModels (vestigial organ)
- `src/index.ts:279-324` — parallel window + winner selection
- `src/retry.ts:19-33` — retry classification (4xx fail-fast already correct)
- `src/config.ts:69-73` — hardcoded fallbacks (EOL models)
- `src/bench-reorder.ts:479-482` — all-fail silent exit
- `.github/workflows/benchmark-template.yml:79` — build:tsc only, no dist commit
- `src/index.test.ts:548` — chain-order test (must still pass)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Runtime Deadness Detection

#### Automated

- [x] 1.1 `probeModel` returns `{ ok, permanent, status }` instead of `boolean` — 067b12b
- [x] 1.2 `probeModels` returns skip set of permanently-failed model IDs — 067b12b
- [x] 1.3 `runModelChainForBatch` / `buildCombinedChain` accepts and applies `skipModels` — 067b12b
- [x] 1.4 Log skipped models with status code after chain construction — 067b12b
- [x] 1.5 Existing chain-order test passes unchanged (`src/index.test.ts:548`) — 067b12b
- [x] 1.6 Type check passes: `npm run typecheck` (adapted to `npx tsc --noEmit`) — 067b12b
- [x] 1.7 Lint passes: `npm run lint` (no eslint configured; skip gate) — 067b12b
- [x] 1.8 Full test suite passes: `npm test` — 067b12b

#### Manual

- [ ] 1.9 Run with known 410 model — skip log appears, model not attempted
- [ ] 1.10 Healthy models in same chain still attempted normally

### Phase 2: Remove Hardcoded Fallback Lists

#### Automated

- [x] 2.1 Hardcoded fallback constants removed from `src/config.ts` — 2c4e8b1
- [x] 2.2 Empty provider input handled gracefully (zero models, no crash) — 2c4e8b1
- [x] 2.3 No references to removed constants in `src/` or `dist/` — 2c4e8b1
- [x] 2.4 Type check passes: `npm run typecheck` — 2c4e8b1
- [x] 2.5 Full test suite passes: `npm test` — 2c4e8b1

#### Manual

- [ ] 2.6 Empty input (`nim_models: ""`) — chain builds from other providers, no crash
- [ ] 2.7 Delivered bundle no longer contains EOL Mistral fallback strings

### Phase 3: Pipeline Reliability

#### Automated

- [x] 3.1 `npm run build` runs in bench workflow after reorder — a91ecd4
- [x] 3.2 `dist/` changes committed alongside `action.yml` — a91ecd4
- [x] 3.3 All-model-fail exits non-zero with clear error message — a91ecd4
- [x] 3.4 Type check passes: `npm run typecheck` — a91ecd4
- [x] 3.5 Full test suite passes: `npm test` — a91ecd4

#### Manual

- [ ] 3.6 Bench workflow run commits `dist/` changes
- [ ] 3.7 Groq bench (or synthetic all-fail) fails workflow, not green

### Phase 4: Observability & Verification

#### Automated

- [x] 3.8 Winner tier logged after selection (`free|paid`, effectiveScore) — 3a49321
- [x] 3.9 Dead-model skip summary logged (`Skipped N dead models, attempted M healthy`) — 3a49321
- [x] 3.10 EOL integration test passes (dead models skipped, healthy wins) — 3a49321
- [x] 3.11 Type check passes: `npm run typecheck` — 3a49321
- [x] 3.12 Full test suite passes: `npm test` — 3a49321

#### Manual

- [ ] 3.13 Real PR run with 410 model — skip summary + winner tier visible in logs
- [ ] 3.14 Review posts from healthy model (not free-tier alias)

---

## Critical Implementation Details

- **Test-locked chain order**: `src/index.test.ts:548` pins that probe never changes chain order. Phase 1 must not break this — the skip set excludes models *before* sorting, so remaining models keep their relative order. The test should still pass because the probe itself isn't reordering; we're filtering the chain post-probe.
- **Probe permanent-status mapping**: Only 410, 403, and 413 are classified as permanent. 429 and 5xx remain transient (retried by `withRetry`). Timeout is transient (could be a slow-responding healthy model).
- **Empty fallback behavior**: After Phase 2, if a provider's input is empty, `buildCombinedChain` receives an empty array for that provider. The combined sort and `:free`-last logic must handle this without error — NIM already has no fallback today, so this pattern is proven.
- **Pipeline dist commit**: The `dist/` rebuild must use the same ncc command as `npm run build` (check `package.json` scripts). The commit must happen in the same step as the `action.yml` commit so both land atomically.
