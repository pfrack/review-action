# Node.js Rewrite — Implementation Plan

## Overview

Rewrite the NIM Code Review GitHub Action from Go to Node.js (TypeScript). The action reviews GitHub PR diffs using NVIDIA NIM models with automatic fallback. The rewrite eliminates the Go compilation step, uses the native `node20` GitHub Actions runtime, and ships compiled JS without bundling.

## Current State Analysis

The action is a Go composite action (~475 lines, zero external deps) with:
- `cmd/nim-review/main.go` — orchestration pipeline
- `cmd/nim-bench/main.go` — model benchmarking tool
- `internal/nimclient/` — HTTP client with SSE streaming
- `internal/nimreview/` — review logic, diff parsing, GitHub API, prompt templates
- `action.yml` — composite action requiring `setup-go` + compilation (~30-60s startup overhead)

## Desired End State

1. TypeScript source in `src/`, compiled to `dist/` via `tsc`
2. `action.yml` uses `node20` runtime pointing to `dist/index.js`
3. All Go files removed, Node.js files take their place
4. Full feature parity: review, fallback, per-language prompts, env config, benchmarking
5. CI updated to run TypeScript compilation + node:test
6. README updated with new development instructions

### Key Discoveries:

- `internal/nimclient/nimclient.go:22-29` — Client struct with 180s timeout; port to native fetch with AbortSignal.timeout
- `internal/nimclient/nimclient.go:140-221` — SSE streaming via bufio.Scanner; port to ReadableStream + TextDecoder
- `internal/nimreview/nimreview.go:104-130` — FetchDiff with Accept header; straightforward fetch port
- `internal/nimreview/nimreview.go:172-184` — ReviewFileWithFallback loop; same pattern in JS
- `internal/nimreview/prompts.go:27-34` — Language prompt map; load from files with fs.readFileSync
- `action.yml:28-70` — composite steps to replace with single node20 entrypoint

## What We're NOT Doing

- Using esbuild/webpack for bundling (use @vercel/ncc — the GitHub Actions standard)
- Adding runtime TypeScript loaders (compile ahead of time)
- Changing the NIM API contract or model defaults
- Adding new features beyond what Go version has
- Keeping Go files (clean cutover)

## Implementation Approach

Compile TypeScript to JavaScript with `tsc` for type-checking and tests. Bundle for distribution with `@vercel/ncc` to produce a single `dist/index.js` (no node_modules to commit). Use `@actions/core` for input handling. Use `node:test` for testing. Each phase produces working, testable code.

## Phase 1: Project Scaffolding + Build

### Overview

Initialize the Node.js project with TypeScript configuration, package.json, build script, and directory structure. Verify `tsc` compiles successfully.

### Changes Required:

#### 1. package.json

**File**: `package.json`

**Intent**: Create package.json with project metadata, scripts (build, test, package), devDependencies (typescript, @types/node, @vercel/ncc), and dependencies (@actions/core).

**Contract**: name: "review-action", scripts.build: "tsc", scripts.test: "node --test dist/**/*.test.js", scripts.package: "ncc build src/index.ts -o dist", devDependencies: typescript ^5.x, @types/node ^20.x, @vercel/ncc ^0.38.x, dependencies: @actions/core ^1.10.x

#### 2. tsconfig.json

**File**: `tsconfig.json`

**Intent**: TypeScript configuration targeting Node 20, outputting to dist/.

**Contract**: target: "ES2022", module: "Node16", moduleResolution: "Node16", outDir: "dist", rootDir: "src", strict: true, esModuleInterop: true, skipLibCheck: true

#### 3. Directory structure

**Files**: `src/` directory with placeholder index.ts

**Intent**: Create src/ directory that will contain all TypeScript source files. Start with a minimal index.ts that validates the build pipeline works.

**Contract**: `src/index.ts` — minimal entrypoint that can be compiled and run

### Success Criteria:

#### Automated Verification:

- `npm install` succeeds
- `npm run build` compiles src/index.ts → dist/index.js
- `node dist/index.js` runs without error

#### Manual Verification:

- TypeScript IDE support works (type checking, autocomplete)

---

## Phase 2: Core NIM Client

### Overview

Port the HTTP client from Go to TypeScript with native fetch, SSE streaming, and chat completions. This is the foundation that review and bench modules depend on.

### Changes Required:

#### 1. NIM client module

**File**: `src/nim-client.ts`

**Intent**: Create a NIM API client class with chat (non-streaming) and chatStream (streaming) methods. Use native fetch with AbortSignal.timeout for HTTP calls. Parse SSE responses using ReadableStream.

**Contract**:
- `NimClient` class with constructor(baseURL, apiKey)
- `chat(model, messages, options)` → returns `{ content, usage, latency }`
- `chatStream(model, messages, options)` → returns async iterable of `{ delta, done, firstTokenAt }`
- `probeModel(model)` → returns boolean (health check)
- Types: `ChatMessage`, `ChatOptions`, `ChatResult`, `Usage`, `StreamChunk`

#### 2. Prompt templates

**File**: `src/prompts.ts`

**Intent**: Port language detection and prompt template loading. Load .txt files at runtime using `fs.readFileSync(path.join(__dirname, 'prompts', file))` — ncc will detect this pattern and bundle the .txt assets into dist/.

**Contract**:
- `languageForFile(filePath)` → returns language name or "generic"
- `resolveSystemPrompt(filePath, config)` → returns composed prompt
- Map extensions to languages: .go→Go, .py→Python, .ts/.tsx/.js/.jsx→TypeScript, .java→Java, .rs→Rust, .cpp/.c/.h/.hpp→C++
- Prompt files resolved via `path.join(__dirname, 'prompts', '<lang>.txt')` (ncc bundles these as assets)

#### 3. Prompt template files

**Files**: `src/prompts/*.txt` (copy from internal/nimreview/prompts/)

**Intent**: Copy existing prompt template files unchanged. These are loaded at runtime by prompts.ts.

**Contract**: Same content as current Go version

### Success Criteria:

#### Automated Verification:

- `npm run build` compiles without errors
- Unit tests pass for nim-client.ts (mock HTTP server)
- Unit tests pass for prompts.ts (language detection, prompt composition)

#### Manual Verification:

- Chat method sends correct request format
- Stream method correctly parses SSE chunks
- Prompt resolution follows precedence: env prompt → per-language → base

---

## Phase 3: Review Logic

### Overview

Port the review orchestration: diff parsing, GitHub API calls, file exclusion, review-with-fallback loop, and PR comment posting.

### Changes Required:

#### 1. Review module

**File**: `src/review.ts`

**Intent**: Port diff parsing, GitHub API interactions, file exclusion logic, and the review pipeline. This module handles all GitHub-specific operations.

**Contract**:
- `parseDiff(rawDiff)` → returns `{ [filePath]: diffText }`
- `fetchDiff(repo, prNumber, token)` → returns parsed diffs
- `shouldExclude(filePath, patterns)` → returns boolean
- `postComment(repo, prNumber, token, body)` → posts PR comment
- `reviewFileWithFallback(client, filePath, diff, config)` → returns review text
- `loadConfig()` → returns Config from environment variables

#### 2. GitHub event loading

**File**: `src/event.ts`

**Intent**: Load and parse the GitHub event payload from GITHUB_EVENT_PATH.

**Contract**:
- `loadEvent()` → returns `{ pullRequest: { number } }`
- Reads from process.env.GITHUB_EVENT_PATH

### Success Criteria:

#### Automated Verification:

- `npm run build` compiles without errors
- Unit tests pass for diff parsing (table-driven, matching Go tests)
- Unit tests pass for file exclusion patterns

#### Manual Verification:

- Diff parsing handles multi-file diffs correctly
- Exclusion patterns match Go version behavior (glob + basename)

---

## Phase 4: Action Entrypoint

### Overview

Wire up the action.yml with node20 runtime, implement input handling via @actions/core, and create the main orchestration entrypoint.

### Changes Required:

#### 1. action.yml

**File**: `action.yml`

**Intent**: Replace composite action with node20 runtime. Keep all inputs identical for backward compatibility.

**Contract**: `runs.using: "node20"`, `runs.main: "dist/index.js"`, inputs unchanged

#### 2. Main entrypoint

**File**: `src/index.ts`

**Intent**: Implement the main orchestration: load config via @actions/core inputs, load event, probe models for health, fetch diffs, review files with fallback, post comment. Handle errors gracefully.

**Contract**:
- Read inputs via `core.getInput()`
- Load config, load event
- Probe all models via `NimClient.probeModel()`, filter to alive list; fall back to full list if none respond. Log alive/dead counts via `core.info()`
- Fetch diffs
- Loop through files: review with fallback (using alive models only), collect sections
- Post assembled comment to PR
- Use `core.setFailed()` for error reporting

#### 3. Core integration

**File**: `src/index.ts`

**Intent**: Use @actions/core for input handling, logging (core.info, core.warning), and error reporting (core.setFailed).

**Contract**:
- `core.getInput('nim_api_key')` for all inputs
- `process.env.GITHUB_TOKEN` for GitHub token (auto-injected by Actions, not an action input)
- `core.info()` for progress logging
- `core.setFailed()` for errors

### Success Criteria:

#### Automated Verification:

- `npm run build` compiles without errors
- action.yml validates (correct node20 syntax)
- Input names match Go version exactly (nim_api_key, nim_base_url, etc.)

#### Manual Verification:

- `node dist/index.js` runs with test environment variables
- Comment posting works against a real PR (manual test)

---

## Phase 5: Benchmark Tool

### Overview

Port the full benchmark tool: model probing, iteration timing, TTFT measurement, tokens-per-sec calculation, and markdown table output.

### Changes Required:

#### 1. Benchmark module

**File**: `src/bench.ts`

**Intent**: Port benchmark logic: warmup call, sequential iterations, non-streaming latency + tokens/sec, streaming TTFT, median calculation, markdown table formatting.

**Contract**:
- `runBenchmark(client, model, config)` → returns BenchmarkResult
- `probeModel(client, model)` → returns boolean
- `formatMarkdownTable(results)` → returns markdown string
- `median(arr)` → returns median value
- Write to GITHUB_STEP_SUMMARY if set

#### 2. Benchmark entrypoint

**File**: `src/bench-entry.ts`

**Intent**: Standalone CLI entry point for benchmarking. Parse env vars, iterate models, output results.

**Contract**:
- Reads NIM_API_KEY, NIM_BASE_URL, NIM_MODELS, NIM_BENCH_ITERATIONS, NIM_BENCH_PROMPT
- Supports --probe flag for health checks
- Outputs markdown table to stdout
- Writes to GITHUB_STEP_SUMMARY if available

### Success Criteria:

#### Automated Verification:

- `npm run build` compiles without errors
- Unit tests pass for benchmark metrics calculation
- Unit tests pass for markdown table formatting

#### Manual Verification:

- `node dist/bench-entry.js --probe` checks model health
- `node dist/bench-entry.js` produces markdown table with TTFT, latency, tokens/sec

---

## Phase 6: Tests

### Overview

Write comprehensive unit tests for all modules using node:test and node:assert. Match the coverage of the Go test suite.

### Changes Required:

#### 1. Client tests

**File**: `src/nim-client.test.ts`

**Intent**: Test NIM client with mock HTTP server. Cover: successful chat, streaming, HTTP errors, timeout, probe.

**Contract**: Uses node:test + createServer for mocking

#### 2. Review tests

**File**: `src/review.test.ts`

**Intent**: Test diff parsing, file exclusion, prompt resolution. Port table-driven tests from Go.

**Contract**: Matches Go test cases exactly

#### 3. Benchmark tests

**File**: `src/bench.test.ts`

**Intent**: Test benchmark metrics: warmup discarded, metrics computed correctly, markdown table output.

**Contract**: Uses mock server with deterministic responses

#### 4. Prompts tests

**File**: `src/prompts.test.ts`

**Intent**: Test language detection and prompt composition for all 6 languages + generic fallback.

**Contract**: Table-driven tests matching Go LanguageForFile tests

### Success Criteria:

#### Automated Verification:

- `npm test` runs all tests
- All tests pass
- Test coverage covers all public functions

#### Manual Verification:

- Tests match Go test behavior

---

## Phase 7: CI & Cleanup

### Overview

Update CI workflow to use Node.js, remove all Go files, update README with new development instructions.

### Changes Required:

#### 1. CI workflow

**File**: `.github/workflows/ci.yml`

**Intent**: Replace Go CI with Node.js CI: install deps, compile TypeScript, run tests.

**Contract**:
- Setup Node.js 20
- npm ci
- npm run build
- npm test

#### 2. Remove Go files

**Files**: All .go files, go.mod, go.sum, internal/, cmd/

**Intent**: Remove all Go source files now that Node.js version is complete.

**Contract**: Delete cmd/, internal/, go.mod, go.sum

#### 3. Update README

**File**: `README.md`

**Intent**: Update development instructions, examples, and benchmarking docs for Node.js.

**Contract**:
- Development: `npm install && npm run build && npm test`
- Benchmarking: `node dist/bench-entry.js`
- Remove Go-specific instructions

#### 4. package.json scripts

**File**: `package.json`

**Intent**: Add any missing scripts, ensure build/test/publish scripts are correct.

**Contract**: scripts.build, scripts.test, scripts.lint (if adding eslint later)

### Success Criteria:

#### Automated Verification:

- CI passes on GitHub Actions
- `npm run build && npm test` passes locally
- No Go files remain in repository

#### Manual Verification:

- README renders correctly
- Usage examples work
- v1 tag can be force-moved to new commit

---

## Phase 8: History Rewrite & v1 Release

### Overview

Squash the entire repository history into a single clean commit with only the Node.js source. Force-push to main and move the v1 tag. This is a destructive operation — acceptable because there's a single user/consumer.

### Changes Required:

#### 1. Squash history

**Intent**: Create a fresh initial commit containing only the Node.js codebase. Remove all traces of Go code from git history.

**Contract**:
- `git checkout --orphan clean-main`
- `git add -A` (only Node.js files — Go files already deleted in Phase 7)
- `git commit -m "feat: NIM Code Review Action (Node.js rewrite)"`
- `git branch -D main`
- `git branch -m main`
- `git push --force origin main`

#### 2. Move v1 tag

**Intent**: Point the v1 tag at the new single commit so consumers using `@v1` get the Node.js version.

**Contract**:
- `git tag -d v1` (delete local)
- `git push origin :refs/tags/v1` (delete remote)
- `git tag v1`
- `git push origin v1`

### Success Criteria:

#### Automated Verification:

- `git log --oneline` shows single commit
- No Go files in `git ls-files`
- `git show v1 --stat` shows only Node.js files

#### Manual Verification:

- Fresh clone works: `git clone`, `npm ci`, `npm run build`, `npm test`
- Action works when referenced as `uses: <repo>@v1` in a test workflow

---

## Testing Strategy

### Unit Tests:

- `nim-client.test.ts`: HTTP client, streaming, error handling
- `review.test.ts`: Diff parsing, exclusion, prompt resolution
- `bench.test.ts`: Metrics calculation, table formatting
- `prompts.test.ts`: Language detection, prompt composition

### Integration Tests:

- End-to-end review with mocked NIM API
- End-to-end benchmark with mocked NIM API

### Manual Testing Steps:

1. Run `npm run build` — compiles without errors
2. Run `npm test` — all tests pass
3. Set NIM_API_KEY and run against a real PR
4. Run benchmark tool against live models
5. Verify CI passes on GitHub Actions

## Performance Considerations

- Native fetch eliminates TCP+TLS overhead from Go's http.Client (shared connection pool via Node.js agent)
- No compilation step saves ~30-60s per workflow run
- Node.js memory overhead (~30MB vs ~10MB) is acceptable for GitHub Actions runners

## Migration Notes

- All input names remain identical (backward compatible)
- Users upgrading via @v1 get Node.js version transparently
- No data migration needed

## References

- Research: `context/changes/nodejs-rewrite/research.md`
- Go source: `internal/nimclient/nimclient.go`, `internal/nimreview/nimreview.go`
- Prompt templates: `internal/nimreview/prompts/*.txt`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands.

### Phase 1: Project Scaffolding + Build

#### Automated

- [x] 1.1 `npm install` succeeds — 0e536e7
- [x] 1.2 `npm run build` compiles src/index.ts → dist/index.js — 0e536e7
- [x] 1.3 `node dist/index.js` runs without error — 0e536e7

#### Manual

- [ ] 1.4 TypeScript IDE support works

### Phase 2: Core NIM Client

#### Automated

- [x] 2.1 `npm run build` compiles without errors — 14f709b
- [x] 2.2 Unit tests pass for nim-client.ts — 14f709b
- [x] 2.3 Unit tests pass for prompts.ts — 14f709b

#### Manual

- [ ] 2.4 Chat method sends correct request format
- [ ] 2.5 Stream method correctly parses SSE chunks
- [ ] 2.6 Prompt resolution follows precedence correctly

### Phase 3: Review Logic

#### Automated

- [x] 3.1 `npm run build` compiles without errors — 79a7d43
- [x] 3.2 Unit tests pass for diff parsing — 79a7d43
- [x] 3.3 Unit tests pass for file exclusion — 79a7d43

#### Manual

- [ ] 3.4 Diff parsing handles multi-file diffs
- [ ] 3.5 Exclusion patterns match Go behavior

### Phase 4: Action Entrypoint

#### Automated

- [x] 4.1 `npm run build` compiles without errors — 11446b6
- [x] 4.2 action.yml validates with node20 syntax — 11446b6
- [x] 4.3 Input names match Go version — 11446b6

#### Manual

- [ ] 4.4 `node dist/index.js` runs with test env vars
- [ ] 4.5 Comment posting works against real PR

### Phase 5: Benchmark Tool

#### Automated

- [x] 5.1 `npm run build` compiles without errors — 14678d0
- [x] 5.2 Unit tests pass for benchmark metrics — 14678d0
- [x] 5.3 Unit tests pass for markdown table — 14678d0

#### Manual

- [ ] 5.4 `node dist/bench-entry.js --probe` works
- [ ] 5.5 `node dist/bench-entry.js` produces correct table

### Phase 6: Tests

#### Automated

- [x] 6.1 `npm test` runs all tests — 14678d0
- [x] 6.2 All tests pass — 14678d0
- [x] 6.3 Test coverage covers all public functions — 14678d0

#### Manual

- [ ] 6.4 Tests match Go test behavior

### Phase 7: CI & Cleanup

#### Automated

- [x] 7.1 CI passes on GitHub Actions — a559c35
- [x] 7.2 `npm run build && npm test` passes locally — a559c35
- [x] 7.3 No Go files remain — a559c35

#### Manual

- [ ] 7.4 README renders correctly
- [ ] 7.5 Usage examples work
- [ ] 7.6 v1 tag can be force-moved

### Phase 8: History Rewrite & v1 Release

#### Automated

- [ ] 8.1 `git log --oneline` shows single commit
- [ ] 8.2 No Go files in `git ls-files`
- [ ] 8.3 `git show v1 --stat` shows only Node.js files

#### Manual

- [ ] 8.4 Fresh clone works (clone, npm ci, build, test)
- [ ] 8.5 Action works when referenced as `@v1` in test workflow
