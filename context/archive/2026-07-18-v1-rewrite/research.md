---
date: 2026-07-18T18:24:12+02:00
researcher: pfrack
git_commit: c6f5f8950a369eee4f12b159124c64800e182460
branch: main
repository: pfrack/nim-review-action
topic: "Extending nim-review-action: NIM model speed benchmarking, env-configurable prompt, per-language prompt templates, and v1 tag rewrite"
tags: [research, codebase, nim, github-action, benchmarking, prompt-templates, go]
status: complete
last_updated: 2026-07-18
last_updated_by: pfrack
---

# Research: Extending nim-review-action (model benchmarking, prompt config, v1 retag)

**Date**: 2026-07-18T18:24:12+02:00
**Researcher**: pfrack
**Git Commit**: c6f5f8950a369eee4f12b159124c64800e182460
**Branch**: main
**Repository**: pfrack/nim-review-action

## Research Question

1. Can this codebase be extended to check which NIM models are the fastest?
2. Can the prompt be changed from an environment variable?
3. Can there be prompt templates per programming language?
4. What does rewriting the `v1` tag involve afterwards?

## Summary

The codebase is small (~475 lines of Go, zero external dependencies) and cleanly layered, so all three extensions are low-effort and well-localized:

- **Model speed benchmarking — feasible, best as a separate command.** The NIM API returns `usage` token counts (`prompt_tokens`/`completion_tokens`/`total_tokens`) on every response, which the current code parses but discards ([nimreview.go:201-207](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/internal/nimreview/nimreview.go#L201-L207)). That gives tokens/sec for free; the existing-but-unused `Stream` field in the request struct ([nimreview.go:198](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/internal/nimreview/nimreview.go#L198)) enables time-to-first-token (TTFT) with a small SSE parser. Recommended shape: `cmd/nim-bench` next to `cmd/nim-review`, sharing a new `internal/nimclient` package. Decision recorded with user: **separate `cmd/nim-bench` command**.
- **Env-configurable prompt — trivial.** `systemPrompt` is a const ([nimreview.go:176-186](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/internal/nimreview/nimreview.go#L176-L186)); `LoadConfig` already centralizes env parsing ([nimreview.go:26-34](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/internal/nimreview/nimreview.go#L26-L34)). Add `NIM_SYSTEM_PROMPT` + one passthrough input in `action.yml`.
- **Per-language prompt templates — easy.** `ReviewFile` already receives the file path ([nimreview.go:210](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/internal/nimreview/nimreview.go#L210)); an extension→language map plus per-language prompt sections (embedded via `go:embed` or as constants) slot in without touching the orchestration in `main.go`.
- **v1 tag rewrite — simple, with one caveat.** The tag is lightweight and currently points at the same commit as `main` HEAD (`c6f5f89`). Because the composite action builds from source at run time, moving the tag *is* the entire release — no build artifacts to publish. Rewrite with `git tag -fa v1 -m ... <sha> && git push --force origin v1`. Decision recorded with user: **force-move the existing `v1` tag** (standard major-tag practice for actions).

No architectural obstacles found. The main design decisions are about *placement* (separate binary vs. mode flag — resolved: separate binary) and *measurement hygiene* (warmup calls, shared HTTP client, fixed sampling params), detailed below.

## Detailed Findings

### 1. Codebase structure and extension points

The action is a Go composite action: `action.yml` installs Go, builds `./cmd/nim-review` from source on every run, and executes it ([action.yml:22-40](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/action.yml#L22-L40)).

Pipeline in `cmd/nim-review/main.go` ([main.go:18-75](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/cmd/nim-review/main.go#L18-L75)):

```
LoadConfig → LoadEvent → FetchDiff → for each file: ReviewFileWithFallback → PostComment
```

All logic lives in `internal/nimreview` — the `main` package is a thin shell, which is exactly the structure that makes a second `cmd/` entry point cheap.

Key types and functions:

| Symbol | Location | Role | Relevance to extensions |
|---|---|---|---|
| `NIMConfig` / `LoadConfig` | [nimreview.go:17-34](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/internal/nimreview/nimreview.go#L17-L34) | Env-driven config | Add `SystemPrompt` field + `NIM_SYSTEM_PROMPT` here |
| `ReviewFileWithFallback` | [nimreview.go:163-174](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/internal/nimreview/nimreview.go#L163-L174) | Sequential model fallback | Pattern to *reuse* in bench: iterate models, but collect per-model latency instead of short-circuiting |
| `ReviewFile` | [nimreview.go:210-258](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/internal/nimreview/nimreview.go#L210-L258) | Single non-streaming `chat/completions` call | Extension point for templates (has `fp`) and usage parsing |
| `systemPrompt` const | [nimreview.go:176-186](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/internal/nimreview/nimreview.go#L176-L186) | Hardcoded review prompt | Replace/augment with env override + per-language templates |
| `chatRequest.Stream` | [nimreview.go:198](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/internal/nimreview/nimreview.go#L198) | Already modeled, always `false` | Flip to `true` in bench for TTFT |
| `chatResponse` | [nimreview.go:201-207](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/internal/nimreview/nimreview.go#L201-L207) | Parses only `choices` | Add `usage` struct for token counts |
| `ShouldExclude` | [nimreview.go:147-160](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/internal/nimreview/nimreview.go#L147-L160) | Glob/basename exclusion | Shows the established table-driven-test style to follow |
| `PostComment` | [nimreview.go:261-284](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/internal/nimreview/nimreview.go#L261-L284) | Posts PR comment | Reusable for posting a benchmark results table |

### 2. Model speed benchmarking on NIM — feasibility and design

**Confirmed API facts** (NVIDIA NIM API docs, `POST /v1/chat/completions`):

- Every response includes `usage` with `prompt_tokens`, `completion_tokens`, `total_tokens` → **tokens/sec = completion_tokens / wall-time** with zero streaming work.
- `stream: true` is supported (OpenAI-compatible SSE) → enables **TTFT** (time until first `data:` chunk) and per-token inter-arrival stats.
- The endpoint is the same `BaseURL + /chat/completions` the code already calls ([nimreview.go:229](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/internal/nimreview/nimreview.go#L229)) — no new endpoints or auth needed; the existing `NIM_API_KEY`/`NIM_BASE_URL` config carries over.

**Metrics achievable:**

| Metric | How | Code change needed |
|---|---|---|
| Total latency | `time.Since(start)` around request | none (new code) |
| Throughput (tok/s) | `usage.completion_tokens / latency` | add `usage` to `chatResponse` |
| TTFT | stream + timestamp first SSE chunk | SSE line parser (~30 lines, stdlib `bufio.Scanner`) |
| Error/rate-limit rate | count non-200s per model | already surfaced as errors |
| Comparative ranking | N iterations × M models, median/p95 | orchestration in new `cmd/nim-bench` |

**Measurement hygiene gotchas (important for trustworthy results):**

1. **Cold starts / model spin-up.** NVIDIA-hosted NIM can park unused models; the first request to a model may be seconds slower. Always do ≥1 warmup call per model and discard it. (This is also why the fallback chain exists — models occasionally 429/5xx under hosted load.)
2. **Shared HTTP client.** `ReviewFile` creates a fresh `http.Client` per call ([nimreview.go:237](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/internal/nimreview/nimreview.go#L237)) — fine for review, but a benchmark must reuse one client or it measures TCP+TLS handshake per request. Extract the client into the new `internal/nimclient`.
3. **Fixed sampling params.** Keep `temperature: 0.2` and `max_tokens: 1024` ([nimreview.go:219-220](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/internal/nimreview/nimreview.go#L219-L220)) identical across models; normalize by completion tokens, not characters.
4. **Sequential, not parallel** iterations — parallel calls would contend on hosted rate limits and skew results.
5. **Same payload for all models.** A real diff from the repo (or a synthetic fixed prompt) — input length affects TTFT/latency.

**Recommended shape (decided: separate command):**

```
cmd/nim-bench/main.go        # flags/env: models, iterations, prompt source; prints markdown table
internal/nimclient/          # extracted: shared client, Chat(), ChatStream(), usage struct
internal/nimreview/          # keeps review-specific logic; refactored to use nimclient
```

Output options: stdout table, `$GITHUB_STEP_SUMMARY`, or a PR comment via the existing `PostComment`. The natural end state: run `nim-bench` against the 7 default models, then order the `nim_models` default chain in `action.yml` by measured speed/quality tradeoff.

### 3. Env-configurable prompt

- `systemPrompt` is a package-level const; `LoadConfig` is the single funnel for env vars. Adding `SystemPrompt string` to `NIMConfig` with `envOrDefault("NIM_SYSTEM_PROMPT", systemPrompt)` is a ~5-line change, plus one input + env passthrough in `action.yml` following the existing pattern ([action.yml:29-40](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/action.yml#L29-L40)).
- Multi-line prompts through GitHub Actions inputs are awkward but workable (YAML `|` block scalars survive into env). If that proves clunky, a follow-up could accept a file path (`NIM_SYSTEM_PROMPT_FILE`) read at startup — note as an option, not required for v1.
- Open design choice (below): does the env prompt **replace** the built-in default or **prepend/append** to it? Replace is simpler and more predictable; append preserves the output-format contract (the const currently mandates the findings format that PR comments rely on).

### 4. Per-language prompt templates

- Language detection: `ReviewFile` already gets the file path; a `LanguageForFile(fp string) string` mapping extensions (`.go`, `.py`, `.ts/.tsx`, `.js`, `.java`, `.rs`, `.rb`, `.cpp/.h`, `.cs`, …) to languages is trivially testable in the existing table-driven style ([nimreview_test.go:5-64](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/internal/nimreview/nimreview_test.go#L5-L64)).
- Template structure: keep the base system prompt (role + output format) constant, append a language-specific "focus areas" section (e.g. Go: goroutine leaks, error wrapping, defer-in-loop; TypeScript: async/await misuse, `any` leakage; Python: mutable default args, bare except). This preserves the findings format while specializing the analysis.
- Storage options: Go constants in a new `prompts.go`, or files under `internal/nimreview/prompts/` loaded with `go:embed` (Go 1.22, stdlib — keeps zero-deps and makes templates editable without touching code). `embed` is the nicer long-term choice.
- Interaction with the env override (section 3): define precedence explicitly, e.g. `NIM_SYSTEM_PROMPT` (if set) > per-language template > base default.

### 5. v1 tag rewrite

Current state:

- `v1` is a **lightweight** tag pointing at `c6f5f89`, identical to `main` HEAD; only 3 commits exist (`bdb0445` initial, `3e22f51` remove CI, `c6f5f89` add CI).
- The composite action builds from source at run time — there is **no release artifact**, so moving the tag is the complete release mechanism.
- Consumers reference `@v1` ([README.md:24](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/README.md#L24)); runners fetch the action at job start, so in-flight runs are unaffected and subsequent runs pick up the new tag target.

Procedure (decided with user: force-move the existing `v1`):

```bash
# after merging all changes to main
git tag -fa v1 -m "v1: model benchmarking, env prompt, per-language templates" <merge-sha>
git push --force origin v1
```

Prefer `-a` (annotated) over the current lightweight tag — annotated tags carry author/date/message and are the convention for action version tags.

**Side finding worth fixing in the same pass:** the README usage snippet says `owner/nim-review-action@v1` — the placeholder was never replaced with `pfrack/nim-review-action` ([README.md:24](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/README.md#L24)).

### 6. Test/CI readiness

- CI runs `go build`, `go test -race`, `go vet` on every push/PR ([ci.yml:21-26](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/.github/workflows/ci.yml#L21-L26)).
- Existing tests are pure-function, table-driven (`ShouldExclude`, `parseDiff`, `splitCSV`). The new pure functions (`LanguageForFile`, template selection, SSE chunk parsing, stats aggregation) fit this style; HTTP-dependent paths can be tested with `httptest.Server` (stdlib).

## Code References

- `cmd/nim-review/main.go:18-75` — orchestration pipeline; template for a `cmd/nim-bench` sibling ([permalink](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/cmd/nim-review/main.go#L18-L75))
- `internal/nimreview/nimreview.go:17-34` — `NIMConfig`/`LoadConfig`, where `NIM_SYSTEM_PROMPT` lands ([permalink](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/internal/nimreview/nimreview.go#L17-L34))
- `internal/nimreview/nimreview.go:163-174` — fallback loop; the per-model iteration pattern to adapt for benchmarking ([permalink](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/internal/nimreview/nimreview.go#L163-L174))
- `internal/nimreview/nimreview.go:176-186` — hardcoded `systemPrompt` const to replace/augment ([permalink](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/internal/nimreview/nimreview.go#L176-L186))
- `internal/nimreview/nimreview.go:193-207` — request/response structs; `Stream` unused, `usage` missing ([permalink](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/internal/nimreview/nimreview.go#L193-L207))
- `internal/nimreview/nimreview.go:210-258` — `ReviewFile`; per-language template + shared-client refactor point ([permalink](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/internal/nimreview/nimreview.go#L210-L258))
- `action.yml:13-15, 29-40` — model chain input and env passthrough pattern ([permalink](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/action.yml#L13-L40))
- `.github/workflows/ci.yml:21-26` — build/test/vet gate ([permalink](https://github.com/pfrack/nim-review-action/blob/c6f5f8950a369eee4f12b159124c64800e182460/.github/workflows/ci.yml#L21-L26))

## Architecture Insights

- **Thin `cmd/`, fat `internal/`** — orchestration is fully separated from logic; adding a second command is a structural non-event.
- **Zero external dependencies** (`go.mod` has no `require` block) — deliberate or not, it's worth preserving: SSE streaming, embed, and httptest are all stdlib.
- **Env-only configuration**, parsed once — every new knob follows the same `envOrDefault` pattern, keeping `action.yml` ↔ `LoadConfig` in sync is the only discipline required.
- **Fallback treats all errors identically** (any non-200 → next model). For benchmarking this needs splitting into typed outcomes (rate-limit vs. server error vs. timeout) or results get skewed by models that were never actually measured.
- **Per-call `http.Client`** is the one latent performance bug in the current code — worth fixing as part of the client extraction even for the review path.

## Historical Context (from prior changes)

This repo has no prior `context/` structure — this research initializes `context/changes/v1-rewrite/`. Git history is 3 commits (initial action, CI removed then re-added); no prior decisions to honor beyond the conventions visible in the code.

## Related Research

None — first research artifact in this repository.

## Open Questions

1. Should benchmark results merely be *reported*, or should they feed back into the default `nim_models` ordering (manually via docs, or automatically)?
2. Benchmark output surface: stdout only, `$GITHUB_STEP_SUMMARY`, PR comment, or JSON artifact?
3. Env prompt override semantics: full replacement of the system prompt, or appended to the format-enforcing base prompt? (Replacement is simpler; appending protects the findings format.)
4. Prompt templates as Go constants vs. `go:embed` files? (Recommend `go:embed` for editability; zero cost.)
5. Should `nim-bench` live in this repo permanently, or is it a one-off to inform the v1 default chain order?
