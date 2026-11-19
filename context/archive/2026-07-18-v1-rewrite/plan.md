# NIM Review Action v1 Rewrite — Implementation Plan

## Overview

Extend the NIM Code Review GitHub Action with four capabilities: model speed benchmarking via a new `cmd/nim-bench` binary, env-configurable prompt override, per-language prompt templates, and a shared HTTP client extraction. Then force-move the `v1` tag and fix the README placeholder.

## Current State Analysis

The action is a Go composite action (~284 lines of Go, zero external deps) with a clean `cmd/nim-review` + `internal/nimreview` split. `LoadConfig` centralizes all env parsing. `ReviewFile` creates a fresh `http.Client` per call (latent perf issue). The `systemPrompt` is a package-level const. The `Stream` field exists on the request struct but is always `false`. The `usage` field is not parsed from responses. The README has an `owner/nim-review-action` placeholder that was never replaced.

## Desired End State

1. `cmd/nim-bench` binary that benchmarks NIM models, outputting a markdown table to stdout and `$GITHUB_STEP_SUMMARY` with TTFT and tokens/sec metrics.
2. `NIM_SYSTEM_PROMPT` env var that overrides or appends to the default review prompt (controlled by `NIM_PROMPT_MODE`: `append` default, `replace` alt).
3. Per-language prompt templates for Go, Python, TypeScript/JavaScript, Java, Rust, and C/C++ — loaded via `go:embed`, auto-detected from file extension.
4. Shared `internal/nimclient` package extracted from `nimreview` — reused by both `nim-review` and `nim-bench`.
5. `v1` tag force-moved to the merge commit. README placeholder fixed.

### Key Discoveries:

- `internal/nimreview/nimreview.go:237` — fresh `http.Client` per call; extract into shared client
- `internal/nimreview/nimreview.go:176-186` — hardcoded `systemPrompt` const to extend
- `internal/nimreview/nimreview.go:193-207` — request/response structs need `usage` field and streaming support
- `internal/nimreview/nimreview.go:210` — `ReviewFile` receives file path; add per-language template dispatch here
- `action.yml:29-40` — env passthrough pattern to follow for new inputs
- `.github/workflows/ci.yml:21-26` — build/test/vet gate

## What We're NOT Doing

- Rewriting the NIM API client (reuse existing OpenAI-compatible patterns)
- Adding external dependencies (keep zero-dep policy)
- Changing the default model chain order (bench results will inform this, but that's a separate decision)
- Adding a `NIM_SYSTEM_PROMPT_FILE` env var (defer to follow-up if multi-line prompts prove awkward)
- Creating a release workflow (tag rewrite is a one-off manual step)

## Implementation Approach

Extract shared NIM client infrastructure first (`internal/nimclient`), then layer on the three features (env prompt, per-language templates, benchmarking), and finish with the tag rewrite and README fix. Each phase is independently testable.

## Critical Implementation Details

### Prompt composition semantics

The env prompt and per-language templates compose with this precedence: `NIM_SYSTEM_PROMPT` (if set) overrides everything when `NIM_PROMPT_MODE=replace`. When `NIM_PROMPT_MODE=append` (default), the user's env prompt is prepended to the per-language template (or base default if no language match), and the format-enforcing base prompt is always appended as the final system message. This three-layer composition ensures the findings format is never lost.

### Measurement hygiene for benchmarking

The bench binary must: (1) do ≥1 warmup call per model before measurement and discard it; (2) reuse a single `http.Client` across all iterations; (3) keep `temperature: 0.2` and `max_tokens: 1024` fixed; (4) run iterations sequentially (parallel calls contend on rate limits); (5) use the same input payload for all models.

## Phase 1: Extract shared NIM client (`internal/nimclient`)

### Overview

Extract the HTTP client, chat request/response types, and streaming support into a new `internal/nimclient` package. Refactor `internal/nimreview` to use it. This is the foundation for all subsequent features.

### Changes Required:

#### 1. New package: `internal/nimclient/nimclient.go`

**File**: `internal/nimclient/nimclient.go`

**Intent**: Create a shared NIM client package that owns the HTTP client, chat types, and provides `Chat` (non-streaming) and `ChatStream` (streaming) methods. This eliminates the per-call `http.Client` instantiation and provides the streaming infrastructure needed by `nim-bench`.

**Contract**:
- `Client` struct holding a shared `*http.Client`, `baseURL`, `apiKey`
- `NewClient(baseURL, apiKey string) *Client` — constructor with a 120s timeout client
- `ChatMessage` struct: `Role`, `Content` fields
- `ChatRequest` struct: `Model`, `Messages`, `Temperature`, `MaxTokens`, `Stream` fields
- `ChatResult` struct: `Content string`, `Usage Usage`, `Latency time.Duration`
- `Usage` struct: `PromptTokens`, `CompletionTokens`, `TotalTokens int`
- `Chat(ctx, model, messages, opts) (ChatResult, error)` — non-streaming
- `ChatStream(ctx, model, messages, opts) (<-chan StreamChunk, error)` — streaming via SSE
- `StreamChunk` struct: `Delta string`, `Done bool`, `FirstTokenAt time.Time`
- `ChatOptions` struct: `Temperature float64`, `MaxTokens int`, `Stream bool`

#### 2. Refactor `internal/nimreview/nimreview.go`

**File**: `internal/nimreview/nimreview.go`

**Intent**: Replace the inline `http.Client` creation, `chatRequest`/`chatResponse` structs, and raw HTTP calls with calls to the new `nimclient.Client`. Remove the now-redundant types.

**Contract**: `NIMConfig` gains a `SystemPrompt string` field (populated by `LoadConfig`). `ReviewFile` accepts a `*nimclient.Client` parameter instead of constructing its own client. The `chatRequest`, `chatResponse`, and `chatMessage` types are removed.

#### 3. Update `cmd/nim-review/main.go`

**File**: `cmd/nim-review/main.go`

**Intent**: Construct the shared `nimclient.Client` once and pass it through the review pipeline.

**Contract**: `main()` creates `nimclient.NewClient(cfg.BaseURL, cfg.APIKey)` and passes it to `ReviewFileWithFallback` and `ReviewFile`.

#### 4. Add tests: `internal/nimclient/nimclient_test.go`

**File**: `internal/nimclient/nimclient_test.go`

**Intent**: Test the shared client using `httptest.Server` to mock the NIM API endpoint. Cover both `Chat` and `ChatStream` paths.

**Contract**: Table-driven tests matching the existing style in `nimreview_test.go`. Test cases: successful non-streaming response, streaming response with TTFT tracking, error/status code handling, usage parsing.

### Success Criteria:

#### Automated Verification:

- `go build ./...` passes
- `go test -race ./...` passes
- `go vet ./...` passes
- Existing `nimreview_test.go` tests still pass (no behavioral change to review logic)

#### Manual Verification:

- `nim-review` works identically when run against a real PR (if available)
- Shared client reuses TCP connections (verify via `-race` and debug logging)

---

## Phase 2: Env-configurable prompt + per-language templates

### Overview

Add `NIM_SYSTEM_PROMPT` and `NIM_PROMPT_MODE` env vars to control the system prompt. Add per-language prompt templates for 6 core languages, loaded via `go:embed`. Wire both through `LoadConfig` and `action.yml`.

### Changes Required:

#### 1. Per-language prompt templates

**File**: `internal/nimreview/prompts/` (new directory)

**Intent**: Create embedded prompt template files for Go, Python, TypeScript/JavaScript, Java, Rust, and C/C++. Each template adds language-specific focus areas (goroutine leaks for Go, mutable default args for Python, async/await misuse for TypeScript, etc.) while preserving the findings format.

**Contract**: One `.txt` file per language under `internal/nimreview/prompts/`. Files are loaded at init via `//go:embed`. Each template starts with "You are an expert senior software engineer performing a code review of {LANGUAGE} code." and ends with the findings format block.

#### 2. Language detection

**File**: `internal/nimreview/prompts.go` (new)

**Intent**: Add `LanguageForFile(fp string) string` that maps file extensions to language names. Returns `"generic"` for unknown extensions.

**Contract**: Map entries: `.go` → `"Go"`, `.py` → `"Python"`, `.ts`/`.tsx`/`.js`/`.jsx` → `"TypeScript/JavaScript"`, `.java` → `"Java"`, `.rs` → `"Rust"`, `.cpp`/`.c`/`.h`/`.hpp` → `"C/C++"`. Table-driven test in `nimreview_test.go`.

#### 3. Prompt composition logic

**File**: `internal/nimreview/nimreview.go`

**Intent**: Add `resolveSystemPrompt(fp string, cfg NIMConfig) string` that implements the three-layer precedence: env prompt (with mode) → per-language template → base default.

**Contract**: When `cfg.SystemPrompt != ""` and `cfg.PromptMode == "replace"`, return `cfg.SystemPrompt` directly. When `cfg.SystemPrompt != ""` and `cfg.PromptMode == "append"`, return `cfg.SystemPrompt + "\n\n" + languageTemplate`. When `cfg.SystemPrompt == ""`, return `languageTemplate` (or base default if no language match). The `systemPrompt` const becomes the base default.

#### 4. Extend `NIMConfig` and `LoadConfig`

**File**: `internal/nimreview/nimreview.go`

**Intent**: Add `SystemPrompt string` and `PromptMode string` fields to `NIMConfig`. `LoadConfig` reads `NIM_SYSTEM_PROMPT` and `NIM_PROMPT_MODE` (default: `"append"`).

**Contract**: `envOrDefault("NIM_SYSTEM_PROMPT", "")` and `envOrDefault("NIM_PROMPT_MODE", "append")`.

#### 5. Update `action.yml`

**File**: `action.yml`

**Intent**: Add `nim_system_prompt` and `nim_prompt_mode` inputs with env passthrough, following the existing pattern.

**Contract**: Two new inputs under `inputs:` with descriptions. Two new env passthrough lines in the build step under the existing `NIM_EXCLUDE_PATTERNS` line.

#### 6. Update tests

**File**: `internal/nimreview/nimreview_test.go`

**Intent**: Add tests for `LanguageForFile` (table-driven) and `resolveSystemPrompt` (covers: no env + no lang, no env + lang match, env replace, env append + lang, env append + no lang).

**Contract**: Table-driven tests matching existing style.

### Success Criteria:

#### Automated Verification:

- `go build ./...` passes
- `go test -race ./...` passes
- `go vet ./...` passes
- New `LanguageForFile` tests pass
- New `resolveSystemPrompt` tests pass

#### Manual Verification:

- Setting `NIM_SYSTEM_PROMPT="Focus on security"` with `NIM_PROMPT_MODE=append` includes the custom prompt alongside the base format
- Setting `NIM_SYSTEM_PROMPT="You are..."` with `NIM_PROMPT_MODE=replace` uses only the user's prompt
- Reviewing a `.py` file uses the Python-specific template
- Reviewing a `.go` file uses the Go-specific template
- Reviewing a `.xyz` file falls back to the base default

---

## Phase 3: Benchmark binary (`cmd/nim-bench`)

### Overview

Create a new `cmd/nim-bench` binary that benchmarks NIM models across multiple iterations, measuring TTFT, total latency, and tokens/sec. Outputs a markdown table to stdout and `$GITHUB_STEP_SUMMARY`.

### Changes Required:

#### 1. New binary: `cmd/nim-bench/main.go`

**File**: `cmd/nim-bench/main.go`

**Intent**: Standalone CLI that accepts env/flags for model list, iteration count, and prompt source. Runs benchmark iterations, collects metrics, and outputs a markdown table.

**Contract**:
- Flags/env: `NIM_MODELS` (comma-separated, reuse existing default chain), `NIM_BENCH_ITERATIONS` (default: 5), `NIM_BENCH_PROMPT` (custom prompt; falls back to a synthetic code review prompt), `NIM_API_KEY`, `NIM_BASE_URL`
- Pipeline: parse config → for each model: warmup call (discard) → N iterations: non-streaming call (latency + tokens/sec) + streaming call (TTFT) → aggregate median/p95 → output table
- Output: markdown table with columns: Model | TTFT (median) | Latency (median) | Tokens/sec (median) | Errors
- Write to `$GITHUB_STEP_SUMMARY` if the env var is set

#### 2. Benchmark metrics collection

**File**: `internal/nimclient/bench.go` (new)

**Intent**: Add `BenchmarkResult` struct and `RunBenchmark` helper that takes a `*Client`, model name, prompt, and iteration count. Returns per-iteration timing data.

**Contract**: `BenchmarkResult` struct: `Model string`, `Iterations []IterationResult`. `IterationResult`: `TTFT time.Duration`, `Latency time.Duration`, `CompletionTokens int`, `TokensPerSec float64`, `Error error`. `RunBenchmark` handles warmup, sequential iterations, and both streaming + non-streaming calls.

#### 3. Tests

**File**: `internal/nimclient/bench_test.go` (new)

**Intent**: Test benchmark logic using `httptest.Server` with deterministic responses. Verify warmup is discarded, metrics are correctly computed, and errors are tracked.

**Contract**: Table-driven tests. Mock server returns fixed responses with known token counts. Verify TTFT > 0 for streaming, latency > 0 for non-streaming, tokens/sec = completion_tokens / latency.

#### 4. Update `action.yml` build step

**File**: `action.yml`

**Intent**: Add a comment or note that `nim-bench` is available for model benchmarking (not built by default in the action, but documented in README).

**Contract**: No functional change to action.yml — the bench binary is a standalone tool.

### Success Criteria:

#### Automated Verification:

- `go build ./...` passes (includes `cmd/nim-bench`)
- `go test -race ./...` passes
- `go vet ./...` passes
- `nim-bench` binary builds and prints `--help` or usage info

#### Manual Verification:

- Running `nim-bench` with a valid API key produces a markdown table with TTFT, latency, and tokens/sec for each model
- `$GITHUB_STEP_SUMMARY` is populated when the env var is set
- Warmup iterations are not counted in the results

---

## Phase 4: README fix + v1 tag rewrite

### Overview

Fix the `owner/nim-review-action` placeholder in README, update the README with new features (env prompt, per-language templates, benchmarking), and force-move the `v1` tag.

### Changes Required:

#### 1. Fix README placeholder

**File**: `README.md`

**Intent**: Replace `owner/nim-review-action` with `pfrack/nim-review-action` in the usage snippet.

**Contract**: Line 24: `uses: owner/nim-review-action@v1` → `uses: pfrack/nim-review-action@v1`.

#### 2. Update README with new features

**File**: `README.md`

**Intent**: Document the new `nim_system_prompt`, `nim_prompt_mode` inputs, per-language templates, and `cmd/nim-bench` usage.

**Contract**: Add rows to the Inputs table for the two new inputs. Add a "Per-Language Prompts" section listing supported languages. Add a "Benchmarking" section with `cmd/nim-bench` usage instructions.

#### 3. Force-move v1 tag

**File**: (git operation, not a file change)

**Intent**: After all changes are merged to main, force-move the `v1` tag to the new merge commit.

**Contract**:
```bash
git tag -fa v1 -m "v1: model benchmarking, env prompt, per-language templates" <merge-sha>
git push --force origin v1
```

### Success Criteria:

#### Automated Verification:

- `go build ./...` passes
- `go test -race ./...` passes
- README renders correctly (manual check)

#### Manual Verification:

- README usage snippet shows `pfrack/nim-review-action@v1`
- README documents all new inputs and features
- `v1` tag points to the correct commit: `git tag -l v1 --format='%(objectname:short)'`

---

## Testing Strategy

### Unit Tests:

- `internal/nimclient`: `Chat`, `ChatStream`, `RunBenchmark` via `httptest.Server`
- `internal/nimreview`: `LanguageForFile`, `resolveSystemPrompt` (table-driven, pure functions)
- Existing `ShouldExclude`, `parseDiff`, `splitCSV` tests remain unchanged

### Integration Tests:

- `cmd/nim-review`: end-to-end review with mocked NIM API (if CI env allows)
- `cmd/nim-bench`: end-to-end benchmark with mocked NIM API

### Manual Testing Steps:

1. Set `NIM_SYSTEM_PROMPT` and verify it appears in the system message
2. Review a `.go` file and verify Go-specific focus areas in the prompt
3. Review a `.py` file and verify Python-specific focus areas
4. Run `nim-bench` and verify the markdown table output
5. Verify `GITHUB_STEP_SUMMARY` is populated in a real Actions run
6. After merge: verify `v1` tag points to the correct commit

## Performance Considerations

- Shared `http.Client` eliminates TCP+TLS handshake overhead per request (currently ~100ms+ per call in the review path)
- Streaming SSE parsing uses `bufio.Scanner` (stdlib) — no buffering issues expected at NIM's token rate
- Benchmark sequential iteration avoids rate-limit contention; warmup calls prevent cold-start skew

## Migration Notes

- No data migration needed — this is a code-only change
- Existing users who upgrade via `@v1` get all new features transparently
- The `NIM_SYSTEM_PROMPT` env var defaults to empty (no behavior change unless configured)

## References

- Research: `context/changes/v1-rewrite/research.md`
- `internal/nimreview/nimreview.go:17-34` — `NIMConfig`/`LoadConfig` (extend)
- `internal/nimreview/nimreview.go:176-186` — `systemPrompt` const (reference for templates)
- `internal/nimreview/nimreview.go:193-207` — request/response structs (extend for streaming + usage)
- `internal/nimreview/nimreview.go:210-258` — `ReviewFile` (refactor to use shared client + templates)
- `action.yml:29-40` — env passthrough pattern (follow for new inputs)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands.

### Phase 1: Extract shared NIM client

#### Automated

- [x] 1.1 `go build ./...` passes after `internal/nimclient` extraction — efb7820
- [x] 1.2 `go test -race ./...` passes (existing + new tests) — efb7820
- [x] 1.3 `go vet ./...` passes — efb7820

#### Manual

- [ ] 1.4 `nim-review` works against a real PR with shared client

### Phase 2: Env prompt + per-language templates

#### Automated

- [x] 2.1 `go build ./...` passes — cdd8b6d
- [x] 2.2 `go test -race ./...` passes (LanguageForFile + resolveSystemPrompt tests) — cdd8b6d
- [x] 2.3 `go vet ./...` passes — cdd8b6d

#### Manual

- [ ] 2.4 `NIM_SYSTEM_PROMPT` with `append` mode includes custom text + base format
- [ ] 2.5 `NIM_SYSTEM_PROMPT` with `replace` mode uses only custom text
- [ ] 2.6 `.py` file uses Python template, `.go` file uses Go template
- [ ] 2.7 Unknown extension falls back to base default

### Phase 3: Benchmark binary

#### Automated

- [x] 3.1 `go build ./...` passes (includes `cmd/nim-bench`) — 2656392
- [x] 3.2 `go test -race ./...` passes (bench_test.go) — 2656392
- [x] 3.3 `go vet ./...` passes — 2656392

#### Manual

- [ ] 3.4 `nim-bench` produces correct markdown table with mocked API
- [ ] 3.5 `$GITHUB_STEP_SUMMARY` is populated

### Phase 4: README + v1 tag

#### Automated

- [x] 4.1 `go build ./...` passes — 3d4fc0a
- [x] 4.2 `go test -race ./...` passes — 3d4fc0a

#### Manual

- [ ] 4.3 README shows `pfrack/nim-review-action@v1` (no placeholder)
- [ ] 4.4 README documents new inputs and benchmarking
- [ ] 4.5 `v1` tag points to correct commit after force-push
