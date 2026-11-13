<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Node.js Rewrite

- **Plan**: context/changes/nodejs-rewrite/plan.md
- **Scope**: Phases 1-7 of 8
- **Date**: 2026-07-19
- **Verdict**: REJECTED
- **Findings**: 3 critical, 5 warnings, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | FAIL |
| Scope Discipline | PASS |
| Safety & Quality | FAIL |
| Architecture | WARNING |
| Pattern Consistency | WARNING |
| Success Criteria | PASS |

## Findings

### F1 — dist/ is tsc output, not ncc bundle — action will fail at runtime

- **Severity**: ❌ CRITICAL
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Plan Adherence
- **Location**: dist/index.js:1
- **Detail**: The plan mandates `scripts.package: "ncc build src/index.ts -o dist"` to produce a single bundled file. Instead, `dist/` contains raw tsc output (12 separate .js files) that import `@actions/core` from `node_modules/`. Since `node_modules/` is gitignored and not committed, the action will crash with `Cannot find module '@actions/core'` when GitHub Actions tries to run it. The `npm run package` command exists in package.json but was never executed.
- **Fix**: Run `npm run package` to produce the ncc bundle and commit the resulting `dist/index.js`. Update the build/CI to always run `ncc build` for the distributable. The `tsc` step remains for type-checking and test compilation, but `dist/` for the action must come from ncc.
  - Strength: One command fixes the issue; ncc is already installed as a devDep.
  - Tradeoff: Tests currently run from `dist/**/*.test.js` (tsc output). Need to separate: tsc output goes somewhere for tests, ncc output goes to dist/ for the action.
  - Confidence: HIGH — ncc is already configured, just never run.
  - Blind spot: ncc may need `--asset` flag for prompt .txt files; verify they're included.
- **Decision**: PENDING

### F2 — No probe-before-review flow in entrypoint

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence
- **Location**: src/index.ts (entire file)
- **Detail**: Plan Phase 4 explicitly requires: "Probe all models via NimClient.probeModel(), filter to alive list; fall back to full list if none respond. Log alive/dead counts via core.info()." The implementation skips probing entirely — goes straight from config loading to fetchDiff → review. This means the action will attempt reviews against dead models, wasting time on timeouts before fallback kicks in. The original Go action's reliability depended on this probe step.
- **Fix**: Add probe loop before the review: iterate `config.models`, call `client.probeModel(model)` for each, collect alive ones, log counts, replace `config.models` with alive subset (or keep full list if all fail).
  - Strength: ~15 lines of code; `probeModel()` already exists in NimClient.
  - Tradeoff: Adds N sequential HTTP calls at startup (one per model, ~30s timeout each). For 8 models, worst case is 4 minutes if all are dead.
  - Confidence: HIGH — straightforward port of the bash probe logic.
  - Blind spot: None significant.
- **Decision**: PENDING

### F3 — loadConfig() reads process.env instead of core.getInput()

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence
- **Location**: src/review.ts:loadConfig()
- **Detail**: Plan says "Read inputs via core.getInput('nim_api_key') for all inputs." Implementation reads raw env vars (NIM_API_KEY, NIM_MODELS, etc.). GitHub Actions maps `with:` inputs to `INPUT_NIM_API_KEY` env vars, which `core.getInput()` reads. Without `core.getInput()`, all action inputs defined via `with:` in a workflow are invisible — effectively making the action.yml inputs decorative. The action only works if users manually set `NIM_API_KEY` etc. as environment variables.
- **Fix**: Change `loadConfig()` to use `core.getInput()` for all 7 action inputs (with env var fallback for local CLI usage): `const apiKey = core.getInput('nim_api_key') || process.env.NIM_API_KEY`.
  - Strength: 7 one-line changes; maintains backward compat with env var users.
  - Tradeoff: Introduces `@actions/core` import into review.ts (or move loadConfig to index.ts).
  - Confidence: HIGH — standard GitHub Actions pattern.
  - Blind spot: None significant.
- **Decision**: PENDING

### F4 — resp.body! non-null assertion in streaming

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/nim-client.ts:~108
- **Detail**: `resp.body!.getReader()` uses non-null assertion. If response body is null (possible with certain fetch edge cases), this throws an untyped TypeError with no context, making debugging difficult.
- **Fix**: Add guard: `if (!resp.body) throw new Error('No response body for streaming request');` before `.getReader()`.
- **Decision**: PENDING

### F5 — Glob matching is duplicated and incorrect

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Pattern Consistency
- **Location**: src/index.ts:48-52, src/review.ts:globMatch()
- **Detail**: Exclude pattern matching is implemented twice: inline in index.ts (never calls shouldExclude) and as exported shouldExclude() in review.ts. Both use a naive `*` → `.*` regex conversion where `*` matches path separators — non-standard glob semantics. A pattern like `*.lock` would incorrectly match `path/to/package.lock` at any depth. The shouldExclude() function is exported but unused in production code.
- **Fix A ⭐ Recommended**: Remove inline glob logic from index.ts, call `shouldExclude(filePath, config.excludePatterns)` from review.ts. Fix globMatch to use `[^/]*` for `*` (single segment) — matching standard glob behavior and the Go version's filepath.Match semantics.
  - Strength: Single source of truth; correct semantics; matches Go behavior.
  - Tradeoff: Minor behavior change for users (though current behavior is a bug).
  - Confidence: HIGH — Go's filepath.Match doesn't match `/` with `*` either.
  - Blind spot: Need to verify test cases still pass after fixing.
- **Fix B**: Use a battle-tested glob library (minimatch or picomatch).
  - Strength: Well-tested edge cases handled; industry standard.
  - Tradeoff: Adds a dependency (though ncc bundles it away).
  - Confidence: HIGH — widely used.
  - Blind spot: None significant.
- **Decision**: PENDING

### F6 — Stream reader never released on early exit

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/nim-client.ts:chatStream() ~L95-130
- **Detail**: The streaming async generator reads from `reader.read()` in a loop but never calls `reader.releaseLock()` or `reader.cancel()` in error/early-exit paths. If the consumer breaks out of the `for await` loop early, the underlying HTTP connection may leak.
- **Fix**: Wrap the read loop in `try/finally { reader.cancel(); }` to ensure cleanup on all exit paths.
- **Decision**: PENDING

### F7 — No diff size limit before sending to model

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/review.ts:reviewFile() ~L118
- **Detail**: The entire diff for each file is sent as the user message with no size check. Large generated files or data files that slip past exclusions could exceed the model's context window (causing silent truncation or error) and burn excessive tokens. The Go version had the same gap but the rewrite is an opportunity to fix it.
- **Fix**: Add a configurable max diff size (e.g., 50KB default). If a file's diff exceeds it, skip with a note in the review output: "Diff too large (120KB), skipped."
  - Strength: Prevents token waste and model errors; easy to implement.
  - Tradeoff: Very large legitimate diffs won't get reviewed. User can increase limit.
  - Confidence: HIGH — straightforward guard.
  - Blind spot: Optimal default size limit not benchmarked against model context windows.
- **Decision**: PENDING

### F8 — Prompt files read synchronously at module load with no error handling

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/prompts.ts:~7-14
- **Detail**: `readFileSync` at module top level means if any prompt .txt file is missing or the path resolves incorrectly (common with bundled ESM), the entire action crashes immediately with a raw filesystem error and no actionable message.
- **Fix**: Wrap in try/catch with a descriptive error: `throw new Error(\`Failed to load prompt file \${file}: \${err.message}. Verify dist/prompts/ exists.\`)`
- **Decision**: PENDING

### F9 — action.yml uses node24 instead of planned node20

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: action.yml:29
- **Detail**: Plan specifies `runs.using: "node20"` but implementation uses `node24`. This is likely intentional (newer runtime, more features) but deviates from the documented plan. GitHub Actions supports node24 as of 2025, so this works fine — just needs the plan updated to match.
- **Fix**: Update plan to say `node24` (or change action.yml to `node20` if backward compat matters).
- **Decision**: PENDING

### F10 — resolveSystemPrompt() in review.ts instead of planned prompts.ts

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architecture
- **Location**: src/review.ts vs src/prompts.ts
- **Detail**: Plan placed `resolveSystemPrompt()` in prompts.ts but implementation puts it in review.ts. This makes prompts.ts a pure data module (language detection + file loading) and review.ts handles prompt composition with config (env prompt, mode). Architecturally reasonable — review.ts needs config context that prompts.ts shouldn't know about.
- **Fix**: Accept as-is and update plan to reflect actual module boundary. The separation is arguably better than planned.
- **Decision**: PENDING
