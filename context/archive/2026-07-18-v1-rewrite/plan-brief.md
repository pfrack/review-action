# NIM Review Action v1 Rewrite — Plan Brief

> Full plan: `context/changes/v1-rewrite/plan.md`
> Research: `context/changes/v1-rewrite/research.md`

## What & Why

Extend the NIM Code Review GitHub Action with model speed benchmarking, env-configurable prompts, and per-language prompt templates — then force-move the `v1` tag to ship these features. The goal is to let users benchmark which NIM models are fastest for their use case, customize the review prompt without forking, and get language-specific review focus areas automatically.

## Starting Point

The action is ~284 lines of Go with zero deps, a clean `cmd/nim-review` + `internal/nimreview` split, and env-only config. `systemPrompt` is a hardcoded const, `http.Client` is created per call (latent perf issue), and the `Stream` field is unused. The README has an unreplaced `owner/nim-review-action` placeholder.

## Desired End State

1. `cmd/nim-bench` benchmarks NIM models (TTFT, latency, tokens/sec) and outputs a markdown table
2. `NIM_SYSTEM_PROMPT` env var overrides or appends to the review prompt (mode-selectable)
3. Per-language templates for Go, Python, TypeScript/JS, Java, Rust, C/C++ — auto-detected from file extension
4. Shared `internal/nimclient` package eliminates per-call client creation
5. `v1` tag force-moved; README placeholder fixed

## Key Decisions Made

| Decision                       | Choice                              | Why (1 sentence)                                   | Source    |
| ------------------------------ | ----------------------------------- | -------------------------------------------------- | --------- |
| Benchmark binary placement     | Separate `cmd/nim-bench`            | Keeps review binary lean; reuse pattern from research | Research  |
| Env prompt semantics           | Append (default) + replace mode     | Preserves findings format by default; full control when needed | Plan      |
| Prompt storage                 | `go:embed` files                    | Editable without touching code; zero cost (stdlib) | Research  |
| Benchmark output               | Stdout + `$GITHUB_STEP_SUMMARY`    | Standard Actions visibility pattern                | Plan      |
| Bench lifespan                 | Permanent                           | Users can re-bench when models change              | Plan      |
| Default iterations             | 5                                   | Stable median/p95; ~15-20 min for 7 models        | Plan      |
| Language scope                 | Core 6 (Go, Python, TS/JS, Java, Rust, C/C++) | Covers ~80% of OSS PRs; clear extension pattern | Plan      |
| TTFT measurement               | Streaming + non-streaming           | TTFT is the most user-visible LLM metric          | Plan      |
| v1 tag strategy                | Force-move existing tag             | Standard major-tag practice for actions            | Research  |

## Scope

**In scope:**
- Extract `internal/nimclient` shared client package
- Env-configurable prompt (`NIM_SYSTEM_PROMPT` + `NIM_PROMPT_MODE`)
- Per-language prompt templates (6 core languages via `go:embed`)
- New `cmd/nim-bench` binary with TTFT + throughput metrics
- README placeholder fix + new feature documentation
- v1 tag force-move

**Out of scope:**
- Default model chain reordering (bench informs this, but is a separate decision)
- `NIM_SYSTEM_PROMPT_FILE` env var (defer to follow-up)
- Release workflow automation
- Additional language templates beyond the core 6

## Architecture / Approach

```
cmd/nim-review/     cmd/nim-bench/
      \                /
       \              /
    internal/nimclient/     ← shared HTTP client, Chat(), ChatStream()
            |
    internal/nimreview/     ← review logic, prompt composition, language detection
            |
    internal/nimreview/prompts/  ← per-language .txt templates (go:embed)
```

Both binaries import `nimclient`. The review binary adds prompt composition logic. The bench binary adds iteration/aggregation. `action.yml` only builds `nim-review`; `nim-bench` is a standalone tool.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Extract shared client | `internal/nimclient` with Chat + ChatStream | Refactoring existing review path without breaking it |
| 2. Env prompt + templates | `NIM_SYSTEM_PROMPT`, per-language templates, language detection | Prompt composition edge cases (append + replace + no lang) |
| 3. Benchmark binary | `cmd/nim-bench` with TTFT + throughput metrics | SSE streaming parser correctness; measurement hygiene |
| 4. README + v1 tag | Documentation + tag force-move | Tag rewrite is irreversible; verify commit SHA first |

**Prerequisites:** Valid `NIM_API_KEY` for manual testing phases 1-3
**Estimated effort:** ~2-3 sessions across 4 phases; phase 1-2 are tightly coupled, phase 3-4 are independent

## Open Risks & Assumptions

- NIM API may have cold-start latency that skews benchmark results; warmup calls mitigate this but don't eliminate it
- Multi-line prompts through GitHub Actions inputs work with YAML block scalars but may be awkward; `NIM_SYSTEM_PROMPT_FILE` is the fallback if users report friction
- The `go:embed` approach requires Go 1.22+ (already in `go.mod`)

## Success Criteria (Summary)

- `nim-review` produces identical PR comments with shared client (no behavioral change)
- Setting `NIM_SYSTEM_PROMPT` with `append` mode adds domain focus without breaking the findings format
- `nim-bench` outputs a markdown table with TTFT, latency, and tokens/sec for each model
- README shows `pfrack/nim-review-action@v1` and documents all new features
- `v1` tag points to the post-rewrite merge commit
